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

// A guest list line: "Stergios Plakas, @stergiosplakas", "Stergios Plakas" or just "@tolarazz".
export function parseGuestLine(line) {
  const text = String(line || '');
  const username = ((text.match(/@([A-Za-z0-9._]{1,40})/) || [])[1] || '').toLowerCase();
  const name = toGreeklish(clean(text.replace(/@[A-Za-z0-9._]+/g, ' ').replace(/,/g, ' '), 60)).replace(/\s+/g, ' ').trim();
  if (!name && !username) return null;
  return { name: name || '@' + username, username };
}
const guestLine = (g) => (g.username && g.name !== '@' + g.username ? `${g.name}, @${g.username}` : g.name);

// Finds who a guest is from what they typed: their Instagram username (with or without @),
// their full name, or a first name only one guest has. Returns { guest }, { ambiguous: true } or null.
export function findGuest(typed, guests) {
  const handle = String(typed || '').trim().replace(/^@/, '').toLowerCase();
  const byUsername = guests.find((g) => g.username && g.username === handle);
  if (byUsername) return { guest: byUsername };
  const key = nameKey(typed);
  if (!key) return null;
  const named = guests.filter((g) => !g.name.startsWith('@'));
  const first = key.split(' ')[0];   // a unique first name is enough, even with a misspelt surname
  const byFirst = named.filter((g) => nameKey(g.name).split(' ')[0] === first);
  // Just a first name that several guests share (Maria Lapikou, Mariaa): ask for more.
  if (!key.includes(' ') && byFirst.length > 1) return { ambiguous: true };
  const full = named.find((g) => nameKey(g.name) === key);
  if (full) return { guest: full };
  if (byFirst.length === 1) return { guest: byFirst[0] };
  return byFirst.length > 1 ? { ambiguous: true } : null;
}

async function loadSetting(store, key, fallback) {
  try {
    const value = JSON.parse((await store.getSetting?.(key)) || 'null');
    return value ?? fallback;
  } catch {
    return fallback;
  }
}
async function loadGuests(store) {
  const list = await loadSetting(store, 'guests', []);
  return (Array.isArray(list) ? list : []).map((g) => (typeof g === 'string' ? { name: g, username: '' } : g));
}
// Which phone each guest joined from: { "Stergios Plakas": "<device id>" }.
const loadClaims = async (store) => loadSetting(store, 'claims', {});

// Who's taking part. Normally only guests on the guest list (requireGuestList); until the hosts add one,
// nobody can request or vote. With requireGuestList off and no list, anyone can, under the name they give.
// A guest must be on the list, and the first phone a guest joins from is locked to them:
// nobody else can use that guest, and that phone can't switch to another guest (the DJ can unlock).
// Returns { name } (as written on the list) or { error, status }.
async function checkGuest(store, rawName, voter, { required = true, requireGuestList = true } = {}) {
  const name = cleanName(rawName);
  const typed = clean(rawName, 60);
  const guests = await loadGuests(store);
  if (!guests.length) {
    if (requireGuestList) return { error: NOT_OPEN_YET, status: 403 };
    if (!name && required) return { error: 'Please add your name first (in Latin letters, e.g. Stergios).', status: 400 };
    return { name };
  }
  if (!typed) return { error: 'Please add your first name or Instagram username first.', status: 400 };
  const found = findGuest(typed, guests);
  if (found?.ambiguous) return { error: `There's more than one ${name} on the guest list. Add your surname, or use your Instagram username.`, status: 403 };
  if (!found) return { error: `Sorry, "${typed}" isn't on the guest list. Use your first name or Instagram username.`, status: 403 };
  const label = found.guest.name;
  if (!voter) return { error: 'Please reload the page and try again.', status: 400 };
  const claims = await loadClaims(store);
  const owner = claims[label];
  if (owner && owner !== voter) return { error: `${label} has already joined on another phone. If that wasn't you, tell the hosts.`, status: 403 };
  const already = Object.keys(claims).find((g) => claims[g] === voter);
  if (already && already !== label) return { error: `This phone has already joined as ${already}.`, status: 403 };
  if (!owner) {
    claims[label] = voter;
    await store.setSetting('claims', JSON.stringify(claims));
  }
  return { name: label };
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

const NOT_OPEN_YET = "Song requests open as soon as the hosts add the guest list. Check back soon!";

export function createApp({ store, adminKey, eventName = 'The Party', musicCountry = 'US', musicApi = 'https://itunes.apple.com', deezerApi = 'https://api.deezer.com', maxPerGuestPerHour = 60, requireGuestList = true }) {
  const submitBuckets = new Map();
  const checkBuckets = new Map();
  const config = { eventName, musicCountry, musicApi, deezerApi };

  return async function handle(request, ip = '') {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'GET' && pathname === '/health') return json({ ok: true });
    // `open`: whether guests can take part yet (false until the hosts add the guest list).
    if (method === 'GET' && pathname === '/api/config') {
      return json({ ...config, open: !requireGuestList || (await loadGuests(store)).length > 0 });
    }

    // A guest says who they are (name or Instagram username) from their phone: { name, voter }.
    // Answers { ok, name, locked } or { ok: false, error }. With a guest list this locks the phone to the guest.
    if (method === 'POST' && pathname === '/api/join') {
      if (rateLimited(checkBuckets, ip, 60, 600_000)) return json({ ok: false, error: 'Too many tries, wait a few minutes.' }, 429);
      let body;
      try { body = JSON.parse((await request.text()).slice(0, MAX_BODY) || '{}'); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
      const guest = await checkGuest(store, body.name, cleanVoter(body.voter), { requireGuestList });
      const locked = (await loadGuests(store)).length > 0;
      return json(guest.error ? { ok: false, error: guest.error } : { ok: true, name: guest.name, locked });
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
      const guest = await checkGuest(store, body.name, cleanVoter(body.voter), { required: false, requireGuestList });
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
          kind: 'request',
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
      const mine = requests.filter((r) => voter && r.voter === voter);
      const votedFor = new Set(mine.map((r) => songKey(r.artist, r.title)));
      const requestedByMe = new Set(mine.filter((r) => r.kind !== 'vote').map((r) => songKey(r.artist, r.title)));
      return json(groupSongs(requests).map((s) => ({
        key: s.key,
        artist: s.artist,
        title: s.title,
        count: s.count,
        mine: votedFor.has(s.key),              // this phone asked for it or 👍'd it
        requestedByMe: requestedByMe.has(s.key), // this phone requested it (that can't be taken back here)
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
        // Only a 👍 can be taken back; a song you requested stays on the list (the DJ can remove it).
        const votes = mine.filter((r) => r.kind === 'vote');
        if (!votes.length && mine.length) return json({ error: 'You requested this one, so it stays on the list.' }, 409);
        for (const r of votes) await store.remove(r.id);
        return json({ ok: true, count: song.count - votes.length });
      }
      if (mine.length) return json({ ok: true, count: song.count, already: true });
      const guest = await checkGuest(store, body.name, cleanVoter(body.voter), { requireGuestList });
      if (guest.error) return json({ error: guest.error }, guest.status);
      const name = guest.name;
      if (rateLimited(submitBuckets, ip, maxPerGuestPerHour, 3600_000)) {
        return json({ error: 'Whoa, that is a lot of songs! Try again later.' }, 429);
      }
      await store.add({ id: crypto.randomUUID(), artist: song.artist, title: song.title, track: song.track, name, note: '', voter, kind: 'vote', createdAt: new Date().toISOString() });
      return json({ ok: true, count: song.count + 1 }, 201);
    }

    // Everything below is admin-only.
    const adminRoutes = ['/api/requests', '/api/songs', '/api/guests', '/api/guests/unlock', '/export.csv', '/export.txt', '/export.json'];
    if (adminRoutes.includes(pathname) || pathname.startsWith('/api/requests/')) {
      const header = request.headers.get('authorization') || '';
      const provided = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('key') || '';
      if (!(await keyMatches(provided, adminKey))) return json({ error: 'Wrong admin key.' }, 401);

      // The guest list (one name per entry). An empty list lets everyone in.
      // The guest list, one guest per line ("Name, @username"), and who has joined from which phone.
      const guestInfo = async () => {
        const guests = await loadGuests(store);
        const claims = await loadClaims(store);
        return { names: guests.map(guestLine), joined: guests.map((g) => g.name).filter((n) => claims[n]) };
      };
      if (pathname === '/api/guests') {
        if (method === 'GET') return json(await guestInfo());
        if (method === 'PUT') {
          let body;
          try { body = JSON.parse((await request.text()).slice(0, MAX_BODY) || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400); }
          const lines = Array.isArray(body.names) ? body.names : String(body.names || '').split(/[\n;]+/);
          const guests = [];
          for (const line of lines) {
            const g = parseGuestLine(line);
            if (g && !guests.some((x) => nameKey(x.name) === nameKey(g.name) || (g.username && x.username === g.username))) guests.push(g);
          }
          if (guests.length > 500) return json({ error: 'That is a lot of guests! Up to 500 names.' }, 400);
          await store.setSetting('guests', JSON.stringify(guests));
          // Keep the phone locks of guests who are still on the list.
          const claims = await loadClaims(store);
          const kept = Object.fromEntries(Object.entries(claims).filter(([n]) => guests.some((g) => g.name === n)));
          await store.setSetting('claims', JSON.stringify(kept));
          return json(await guestInfo());
        }
      }
      // Let a guest join again from a different phone.
      if (pathname === '/api/guests/unlock' && method === 'POST') {
        let body;
        try { body = JSON.parse((await request.text()).slice(0, MAX_BODY) || '{}'); } catch { return json({ error: 'Invalid JSON' }, 400); }
        const claims = await loadClaims(store);
        delete claims[body.name];
        await store.setSetting('claims', JSON.stringify(claims));
        return json(await guestInfo());
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
