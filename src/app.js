// The app's API, written once for both platforms:
//   - server.js runs it on Node (local testing, Docker)
//   - worker.js runs it on Cloudflare Workers (+ D1 database)
//
// A store is any object with: list() -> entries oldest first, add(entry), remove(id) -> boolean.

import { toGreeklish } from '../public/greeklish.js';

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
    genre: clean(t.genre, 40),
    artwork: safeUrl(t.artwork, hosts.artwork),
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? Math.min(Math.round(durationMs), 3_600_000) : 0,
    explicit: t.explicit === true,
    clean: t.explicit !== true && t.clean === true,
    url: safeUrl(t.url, hosts.url),
    previewUrl: safeUrl(t.previewUrl, hosts.preview), // ~30s clip
  };
}

// Requests for the same song (same artist + title, ignoring case/punctuation) share a key.
// The guest page computes the same key to spot songs that were already requested.
export const songKey = (artist, title) => normalize(artist) + '|' + normalize(title);

// Guest names are kept in Greeklish (Latin letters), e.g. "Στέργιος" → "Stergios".
const cleanName = (value) => toGreeklish(clean(value, 60)).replace(/[^A-Za-z .'-]/g, '').replace(/\s+/g, ' ').trim();

// ---------- guest list ----------
// The DJ can paste the guest list into the dashboard; then only those guests can request and 👍.
// Names are compared loosely, since Greeklish is spelled many ways:
// Aggelos = Angelos, Xristos = Christos, Kostas = Costas, Anny = Ani, Giwrgos = Giorgos.
export function nameKey(name) {
  const word = (w) => w
    .replace(/ks/g, 'x').replace(/x/g, 'ch').replace(/c(?!h)/g, 'k').replace(/ph/g, 'f').replace(/w/g, 'o')
    .replace(/mp/g, 'b').replace(/nt/g, 'd').replace(/y/g, 'i').replace(/(?<![ctp])h/g, 'i')
    .replace(/(.)\1+/g, '$1').replace(/ng/g, 'g');
  return toGreeklish(String(name || '')).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z]+/).filter(Boolean).map(word).join(' ');
}

// Finds the guest on the list: the full name, or just a first name if only one guest has it.
// Returns { name } as written on the list, { ambiguous: true }, or null.
export function findGuest(name, guests) {
  const key = nameKey(name);
  if (!key) return null;
  const full = guests.find((g) => nameKey(g) === key);
  if (full) return { name: full };
  const first = key.split(' ')[0];   // a unique first name is enough, even with a misspelt surname
  const byFirst = guests.filter((g) => nameKey(g).split(' ')[0] === first);
  if (byFirst.length === 1) return { name: byFirst[0] };
  return byFirst.length > 1 ? { ambiguous: true } : null;
}

async function loadGuests(store) {
  try {
    const names = JSON.parse((await store.getSetting?.('guests')) || '[]');
    return Array.isArray(names) ? names : [];
  } catch {
    return [];
  }
}

// The name to store for a guest, or an error response if they're not on the guest list.
// (The guest page always asks for a name; the server insists on one for votes and once there's a guest list.)
async function checkGuest(store, rawName, { required = true } = {}) {
  const name = cleanName(rawName);
  const guests = await loadGuests(store);
  if (!name && (required || guests.length)) return { error: 'Please add your name first (in Latin letters, e.g. Stergios).', status: 400 };
  if (!guests.length) return { name };            // no guest list: everyone's welcome
  const found = findGuest(name, guests);
  if (found?.name) return { name: found.name };
  if (found?.ambiguous) return { error: `There's more than one ${name} on the guest list. Please add your surname too.`, status: 403 };
  return { error: `Sorry, "${name}" isn't on the guest list. Use your name as the hosts know it, in Latin letters.`, status: 403 };
}

// A guest's device id (random, kept on their phone), used so each guest counts once per song.
const cleanVoter = (v) => (typeof v === 'string' && /^[\w-]{8,64}$/.test(v) ? v : '');

// Group duplicate requests (same artist + title, ignoring case/punctuation).
export function groupSongs(requests) {
  const groups = new Map();
  for (const r of requests) {
    const key = songKey(r.artist, r.title);
    if (!groups.has(key)) {
      groups.set(key, { key, artist: r.artist, title: r.title, track: null, ids: [], count: 0, requestedBy: [], notes: [], firstAt: r.createdAt });
    }
    const g = groups.get(key);
    // Show the explicit version when people asked for both.
    if (r.track && (!g.track || (r.track.explicit && !g.track.explicit))) g.track = r.track;
    g.ids.push(r.id);
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

// A song's genre (from the catalog); typed-in songs and songs without one are "Unknown".
export const genreOf = (s) => s.track?.genre || 'Unknown';

export function toCsv(songs) {
  const rows = [['Artist', 'Title', 'Genre', 'Album', 'Length', 'Times requested', 'Requested by', 'Notes', 'Found in catalog', 'Song link', 'Spotify search', 'YouTube search', 'Beatport search']];
  for (const s of songs) {
    const l = links(s);
    const t = s.track || {};
    rows.push([s.artist, s.title, genreOf(s), t.album, formatDuration(t.durationMs), s.count, s.requestedBy.join('; '), s.notes.join(' | '), s.track ? (s.track.source === 'deezer' ? 'Deezer' : 'Apple Music') : 'no (typed manually)', l.listen, l.spotify, l.youtube, l.beatport]);
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
  const checkBuckets = new Map();
  const config = { eventName, musicCountry, musicApi, deezerApi };

  return async function handle(request, ip = '') {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'GET' && pathname === '/health') return json({ ok: true });
    if (method === 'GET' && pathname === '/api/config') return json(config);

    // The guest page checks a name as it's typed: { ok, name } or { ok: false, error }.
    if (method === 'GET' && pathname === '/api/guest-check') {
      if (rateLimited(checkBuckets, ip, 60, 600_000)) return json({ ok: false, error: 'Too many tries, wait a few minutes.' }, 429);
      const guest = await checkGuest(store, url.searchParams.get('name'));
      return json(guest.error ? { ok: false, error: guest.error } : { ok: true, name: guest.name });
    }

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
      const guest = await checkGuest(store, body.name, { required: false });
      if (guest.error) return json({ error: guest.error }, guest.status);
      const name = guest.name;
      const note = clean(body.note, 200);
      const voter = cleanVoter(body.voter);
      let entries = songs.map((song) => {
        const track = cleanTrack(song?.track);
        return {
          id: crypto.randomUUID(),
          artist: track ? track.artist : clean(song?.artist, 120),
          title: track ? track.title : clean(song?.title, 160),
          track,
          name,
          note,
          voter,
          createdAt: new Date().toISOString(),
        };
      });
      if (entries.some((e) => !e.artist || !e.title)) {
        return json({ error: 'Every song needs both an artist and a title.' }, 400);
      }
      // Each guest counts once per song: skip songs this device already asked for.
      let alreadyHad = 0;
      if (voter) {
        const mine = new Set((await store.list()).filter((r) => r.voter === voter).map((r) => songKey(r.artist, r.title)));
        entries = entries.filter((e) => {
          const key = songKey(e.artist, e.title);
          if (mine.has(key)) { alreadyHad++; return false; }
          mine.add(key);
          return true;
        });
      }
      if (rateLimited(submitBuckets, ip, maxPerGuestPerHour, 3600_000, entries.length)) {
        return json({ error: 'Whoa, that is a lot of songs! Try again later.' }, 429);
      }
      for (const entry of entries) await store.add(entry);
      return json({ ok: true, added: entries.length, alreadyHad }, 201);
    }

    // What's been requested so far, for guests: counts only, no names or notes.
    if (method === 'GET' && pathname === '/api/public/songs') {
      const voter = cleanVoter(url.searchParams.get('voter'));
      const requests = await store.list();
      const mine = new Set(requests.filter((r) => voter && r.voter === voter).map((r) => songKey(r.artist, r.title)));
      return json(groupSongs(requests).map((s) => ({
        key: s.key,
        artist: s.artist,
        title: s.title,
        count: s.count,
        mine: mine.has(s.key),
        track: s.track && {
          source: s.track.source, id: s.track.id, album: s.track.album, artwork: s.track.artwork,
          explicit: s.track.explicit, clean: s.track.clean, genre: s.track.genre, previewUrl: s.track.previewUrl,
        },
      })));
    }

    // 👍 on a song someone already requested (or take your 👍 back): { key, voter, name, remove }.
    if (method === 'POST' && pathname === '/api/votes') {
      let body;
      try {
        body = JSON.parse((await request.text()).slice(0, MAX_BODY) || '{}');
      } catch {
        return json({ error: 'Invalid JSON' }, 400);
      }
      const voter = cleanVoter(body.voter);
      if (!voter) return json({ error: 'Missing device id.' }, 400);
      const requests = await store.list();
      const song = groupSongs(requests).find((s) => s.key === body.key);
      if (!song) return json({ error: 'That song is no longer on the list.' }, 404);
      const mine = requests.filter((r) => r.voter === voter && songKey(r.artist, r.title) === song.key);
      if (body.remove) {
        for (const r of mine) await store.remove(r.id);
        return json({ ok: true, count: song.count - mine.length });
      }
      if (mine.length) return json({ ok: true, count: song.count, already: true });
      const guest = await checkGuest(store, body.name);
      if (guest.error) return json({ error: guest.error }, guest.status);
      const name = guest.name;
      if (rateLimited(submitBuckets, ip, maxPerGuestPerHour, 3600_000)) {
        return json({ error: 'Whoa, that is a lot of songs! Try again later.' }, 429);
      }
      await store.add({ id: crypto.randomUUID(), artist: song.artist, title: song.title, track: song.track, name, note: '', voter, createdAt: new Date().toISOString() });
      return json({ ok: true, count: song.count + 1 }, 201);
    }

    // Everything below is admin-only.
    const adminRoutes = ['/api/requests', '/api/songs', '/api/guests', '/export.csv', '/export.txt', '/export.json'];
    if (adminRoutes.includes(pathname) || pathname.startsWith('/api/requests/')) {
      const header = request.headers.get('authorization') || '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('key') || '';
      if (!(await keyMatches(provided, adminKey))) return json({ error: 'Wrong admin key.' }, 401);

      // The guest list (one name per entry). An empty list lets everyone in.
      if (pathname === '/api/guests') {
        if (method === 'GET') return json({ names: await loadGuests(store) });
        if (method === 'PUT') {
          let body;
          try { body = JSON.parse((await request.text()).slice(0, MAX_BODY) || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400); }
          const list = Array.isArray(body.names) ? body.names : String(body.names || '').split(/[\n,;]+/);
          const names = [];
          for (const raw of list) {
            const n = toGreeklish(clean(String(raw), 60)).replace(/\s+/g, ' ').trim();
            if (n && !names.some((x) => nameKey(x) === nameKey(n))) names.push(n);
          }
          if (names.length > 500) return json({ error: 'That is a lot of guests! Up to 500 names.' }, 400);
          await store.setSetting('guests', JSON.stringify(names));
          return json({ names });
        }
      }
      if (method === 'DELETE' && pathname.startsWith('/api/requests/')) {
        const id = decodeURIComponent(pathname.slice('/api/requests/'.length));
        return (await store.remove(id)) ? json({ ok: true }) : json({ error: 'Not found' }, 404);
      }
      if (method === 'GET') {
        const requests = await store.list();
        // Exports can be limited to one genre (?genre=Pop), to make one playlist per genre.
        const genre = url.searchParams.get('genre');
        const songsFor = (list) => groupSongs(list).filter((s) => !genre || genreOf(s) === genre);
        const stamp = new Date().toISOString().slice(0, 10);
        const slug = genre ? '-' + genre.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') : '';
        const download = (ext) => ({ 'Content-Disposition': `attachment; filename="song-requests${slug}-${stamp}.${ext}"` });
        switch (pathname) {
          case '/api/requests': return json(requests);
          case '/api/songs': return json(groupSongs(requests).map((s) => ({ ...s, genre: genreOf(s), links: links(s) })));
          case '/export.csv': return text(toCsv(songsFor(requests)), 'text/csv; charset=utf-8', download('csv'));
          case '/export.txt': return text(toTxt(songsFor(requests)), 'text/plain; charset=utf-8', download('txt'));
          case '/export.json': return json(requests, 200, download('json'));
        }
      }
    }

    return json({ error: 'Not found' }, 404);
  };
}
