// The app's API, written once for both platforms:
//   - server.js runs it on Node (local testing, Docker)
//   - worker.js runs it on Cloudflare Workers (+ D1 database)
//
// A store is any object with: list() -> entries oldest first, add(entry), remove(id) -> boolean.

const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

function safeUrl(value, hostPattern) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && hostPattern.test(u.hostname) ? u.href : '';
  } catch {
    return '';
  }
}

// Where each catalog's links may point.
const HOSTS = {
  deezer: { artwork: /(^|\.)dzcdn\.net$/, url: /^(www\.)?deezer\.com$/, preview: /(^|\.)dzcdn\.net$/ },
  apple: { artwork: /(^|\.)mzstatic\.com$/, url: /^(music|itunes)\.apple\.com$/, preview: /(^|\.)apple\.com$/ },
};

// A song the guest picked from catalog search (done in their browser, on Deezer or Apple).
// Only keep fields we understand, and only links that point at that catalog.
function cleanTrack(t) {
  if (!t || typeof t !== 'object' || !/^\d{1,15}$/.test(String(t.id))) return null;
  const artist = clean(t.artist, 120);
  const title = clean(t.title, 160);
  if (!artist || !title) return null;
  const durationMs = Number(t.durationMs);
  const source = t.source === 'deezer' ? 'deezer' : 'apple';
  const hosts = HOSTS[source];
  return {
    source,
    id: String(t.id),
    artist,
    title,
    album: clean(t.album, 160),
    artwork: safeUrl(t.artwork, hosts.artwork),
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.min(Math.round(durationMs), 3_600_000) : 0,
    explicit: t.explicit === true,
    clean: t.explicit !== true && t.clean === true,
    url: safeUrl(t.url, hosts.url),
    previewUrl: safeUrl(t.previewUrl, hosts.preview), // ~30s clip
  };
}

// Group duplicate requests (same artist + title, ignoring case/punctuation).
export function groupSongs(requests) {
  const groups = new Map();
  for (const r of requests) {
    const key = normalize(r.artist) + '|' + normalize(r.title);
    if (!groups.has(key)) {
      groups.set(key, { artist: r.artist, title: r.title, track: null, count: 0, requestedBy: [], notes: [], firstAt: r.createdAt });
    }
    const g = groups.get(key);
    // Show the explicit version when people asked for both.
    if (r.track && (!g.track || (r.track.explicit && !g.track.explicit))) g.track = r.track;
    g.count++;
    if (r.name && !g.requestedBy.includes(r.name)) g.requestedBy.push(r.name);
    if (r.note && !g.notes.includes(r.note)) g.notes.push(r.note);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.firstAt.localeCompare(b.firstAt));
}

const searchQuery = (s) => encodeURIComponent(`${s.artist} ${s.title}`);
const links = (s) => ({
  listen: s.track?.url || '', // the song on Deezer or Apple Music
  spotify: `https://open.spotify.com/search/${searchQuery(s)}`,
  youtube: `https://www.youtube.com/results?search_query=${searchQuery(s)}`,
  beatport: `https://www.beatport.com/search?q=${searchQuery(s)}`,
});

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
};

function formatDuration(ms) {
  if (!ms) return '';
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function toCsv(songs) {
  const rows = [['Artist', 'Title', 'Album', 'Length', 'Times requested', 'Requested by', 'Notes', 'Found in catalog', 'Song link', 'Spotify search', 'YouTube search', 'Beatport search']];
  for (const s of songs) {
    const l = links(s);
    const t = s.track || {};
    rows.push([s.artist, s.title, t.album, formatDuration(t.durationMs), s.count, s.requestedBy.join('; '), s.notes.join(' | '), s.track ? (s.track.source === 'deezer' ? 'Deezer' : 'Apple Music') : 'no (typed manually)', l.listen, l.spotify, l.youtube, l.beatport]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// "Artist - Title" per line: paste straight into TuneMyMusic / Soundiiz / Spotify playlist importers.
export const toTxt = (songs) => songs.map((s) => `${s.artist} - ${s.title}`).join('\n') + '\n';

async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
}

// Compare hashes so the check takes the same time however much of the key is right.
async function keyMatches(provided, expected) {
  const [a, b] = await Promise.all([sha256(provided), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Sliding-window limiter: buckets maps ip -> recent timestamps, one per song.
function rateLimited(buckets, ip, max, windowMs, count = 1) {
  const now = Date.now();
  const recent = (buckets.get(ip) || []).filter((t) => now - t < windowMs);
  const limited = recent.length + count > max;
  if (!limited) for (let i = 0; i < count; i++) recent.push(now);
  buckets.set(ip, recent);
  return limited;
}

const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const text = (body, type, headers = {}) => new Response(body, { headers: { 'Content-Type': type, 'Cache-Control': 'no-store', ...headers } });

const MAX_SONGS_PER_SEND = 30;
const MAX_BODY = 64_000;

export function createApp({ store, adminKey, eventName = 'The Party', musicCountry = 'US', musicApi = 'https://itunes.apple.com', deezerApi = 'https://api.deezer.com', maxPerGuestPerHour = 60 }) {
  const submitBuckets = new Map();
  const config = { eventName, musicCountry, musicApi, deezerApi };

  return async function handle(request, ip = '') {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'GET' && pathname === '/health') return json({ ok: true });
    if (method === 'GET' && pathname === '/api/config') return json(config);

    if (method === 'POST' && pathname === '/api/requests') {
      const raw = await request.text();
      if (raw.length > MAX_BODY) return json({ error: 'Request too large.' }, 413);
      let body;
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      if (body.website) return json({ ok: true }, 201); // honeypot field: silently drop bots

      // A guest sends their whole list at once: { songs: [{ track } or { artist, title }], name, note }.
      // A single song at the top level ({ track } or { artist, title }) works too.
      const songs = Array.isArray(body.songs) ? body.songs : [body];
      if (songs.length === 0) return json({ error: 'Add at least one song.' }, 400);
      if (songs.length > MAX_SONGS_PER_SEND) return json({ error: `You can send up to ${MAX_SONGS_PER_SEND} songs at a time.` }, 400);
      const name = clean(body.name, 60);
      const note = clean(body.note, 200);
      const entries = songs.map((song) => {
        const track = cleanTrack(song?.track);
        return {
          id: crypto.randomUUID(),
          artist: track ? track.artist : clean(song?.artist, 120),
          title: track ? track.title : clean(song?.title, 160),
          track,
          name,
          note,
          createdAt: new Date().toISOString(),
        };
      });
      if (entries.some((e) => !e.artist || !e.title)) {
        return json({ error: 'Every song needs both an artist and a title.' }, 400);
      }
      if (rateLimited(submitBuckets, ip, maxPerGuestPerHour, 3600_000, entries.length)) {
        return json({ error: 'Whoa, that is a lot of songs! Try again later.' }, 429);
      }
      for (const entry of entries) await store.add(entry);
      return json({ ok: true, added: entries.length }, 201);
    }

    // Everything below is admin-only.
    const adminRoutes = ['/api/requests', '/api/songs', '/export.csv', '/export.txt', '/export.json'];
    if (adminRoutes.includes(pathname) || pathname.startsWith('/api/requests/')) {
      const header = request.headers.get('authorization') || '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('key') || '';
      if (!(await keyMatches(provided, adminKey))) return json({ error: 'Wrong admin key.' }, 401);

      if (method === 'DELETE' && pathname.startsWith('/api/requests/')) {
        const id = decodeURIComponent(pathname.slice('/api/requests/'.length));
        return (await store.remove(id)) ? json({ ok: true }) : json({ error: 'Not found' }, 404);
      }
      if (method === 'GET') {
        const requests = await store.list();
        const stamp = new Date().toISOString().slice(0, 10);
        const download = (ext) => ({ 'Content-Disposition': `attachment; filename="song-requests-${stamp}.${ext}"` });
        switch (pathname) {
          case '/api/requests': return json(requests);
          case '/api/songs': return json(groupSongs(requests).map((s) => ({ ...s, links: links(s) })));
          case '/export.csv': return text(toCsv(groupSongs(requests)), 'text/csv; charset=utf-8', download('csv'));
          case '/export.txt': return text(toTxt(groupSongs(requests)), 'text/plain; charset=utf-8', download('txt'));
          case '/export.json': return json(requests, 200, download('json'));
        }
      }
    }

    return json({ error: 'Not found' }, 404);
  };
}
