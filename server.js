// Party song requests — a tiny, dependency-free Node server.
//
// Guests open "/" (via QR code) and submit songs.
// The DJ opens "/admin" with ADMIN_KEY to see, delete and export requests.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'requests.json');
const PUBLIC_DIR = path.join(__dirname, 'public');
const EVENT_NAME = process.env.EVENT_NAME || 'The Party';
const ADMIN_KEY = process.env.ADMIN_KEY || '';
const MAX_PER_GUEST_PER_HOUR = Number(process.env.MAX_PER_GUEST_PER_HOUR) || 20;
// Song search uses Apple's free iTunes Search API (no account or key needed).
const MUSIC_API = process.env.MUSIC_API || 'https://itunes.apple.com';
const MUSIC_COUNTRY = process.env.MUSIC_COUNTRY || 'US';

if (!ADMIN_KEY) {
  console.warn('WARNING: ADMIN_KEY is not set. Using "changeme" — set ADMIN_KEY before sharing the link!');
}
const effectiveAdminKey = ADMIN_KEY || 'changeme';

// ---------- storage ----------

function loadRequests() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

let requests = loadRequests();

function saveRequests() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(requests, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}

// ---------- helpers ----------

const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

function clean(value, max) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}

// Group duplicate requests (same artist + title, ignoring case/punctuation).
function groupedSongs() {
  const groups = new Map();
  for (const r of requests) {
    const key = normalize(r.artist) + '|' + normalize(r.title);
    if (!groups.has(key)) {
      groups.set(key, { artist: r.artist, title: r.title, track: null, count: 0, requestedBy: [], notes: [], firstAt: r.createdAt });
    }
    const g = groups.get(key);
    if (!g.track && r.track) g.track = r.track;
    g.count++;
    if (r.name && !g.requestedBy.includes(r.name)) g.requestedBy.push(r.name);
    if (r.note) g.notes.push(r.note);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count || a.firstAt.localeCompare(b.firstAt));
}

const searchQuery = (s) => encodeURIComponent(`${s.artist} ${s.title}`);
const links = (s) => ({
  appleMusic: s.track?.url || '',
  spotify: `https://open.spotify.com/search/${searchQuery(s)}`,
  youtube: `https://www.youtube.com/results?search_query=${searchQuery(s)}`,
  beatport: `https://www.beatport.com/search?q=${searchQuery(s)}`,
});

const csvCell = (v) => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // avoid spreadsheet formula injection
  return '"' + s.replace(/"/g, '""') + '"';
};

function toCsv() {
  const rows = [['Artist', 'Title', 'Album', 'Length', 'Times requested', 'Requested by', 'Notes', 'Found in catalog', 'Apple Music', 'Spotify search', 'YouTube search', 'Beatport search']];
  for (const s of groupedSongs()) {
    const l = links(s);
    const t = s.track || {};
    rows.push([s.artist, s.title, t.album, formatDuration(t.durationMs), s.count, s.requestedBy.join('; '), s.notes.join(' | '), s.track ? 'yes' : 'no (typed manually)', l.appleMusic, l.spotify, l.youtube, l.beatport]);
  }
  return '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

function formatDuration(ms) {
  if (!ms) return '';
  const sec = Math.round(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

// "Artist - Title" per line: paste straight into TuneMyMusic / Soundiiz / Spotify playlist importers.
const toTxt = () => groupedSongs().map((s) => `${s.artist} - ${s.title}`).join('\n') + '\n';

function isAdmin(req, url) {
  const header = req.headers['authorization'] || '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('key') || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(effectiveAdminKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Sliding-window limiter: buckets maps ip -> recent timestamps.
function rateLimited(buckets, ip, max, windowMs) {
  const now = Date.now();
  const recent = (buckets.get(ip) || []).filter((t) => now - t < windowMs);
  const limited = recent.length >= max;
  if (!limited) recent.push(now);
  buckets.set(ip, recent);
  return limited;
}
const submitBuckets = new Map();
const searchBuckets = new Map();

// ---------- music catalog ----------

function toTrack(r) {
  return {
    id: String(r.trackId),
    artist: r.artistName,
    title: r.trackName,
    album: r.collectionName || '',
    artwork: (r.artworkUrl100 || '').replace('100x100bb', '120x120bb'),
    durationMs: r.trackTimeMillis || 0,
    explicit: r.trackExplicitness === 'explicit',
    url: r.trackViewUrl || '',
  };
}

async function musicApi(pathAndQuery) {
  const res = await fetch(MUSIC_API + pathAndQuery, { signal: AbortSignal.timeout(6000) });
  if (!res.ok) throw new Error(`Music API responded ${res.status}`);
  const data = await res.json();
  return (data.results || []).filter((r) => r.kind === 'song' && r.trackId).map(toTrack);
}

const searchCache = new Map(); // query -> { at, tracks }
async function searchSongs(q) {
  const key = normalize(q);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < 600_000) return hit.tracks;
  const tracks = await musicApi(`/search?media=music&entity=song&limit=8&country=${MUSIC_COUNTRY}&term=${encodeURIComponent(q)}`);
  if (searchCache.size > 500) searchCache.clear();
  searchCache.set(key, { at: Date.now(), tracks });
  return tracks;
}

const lookupTrack = async (id) => (await musicApi(`/lookup?country=${MUSIC_COUNTRY}&id=${id}`))[0] || null;

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  return (fwd ? fwd.split(',')[0] : req.socket.remoteAddress || '').trim();
}

function send(res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(payload);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 10_000) {
        reject(Object.assign(new Error('Body too large'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function serveHtml(res, file) {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, file), 'utf8').replaceAll('{{EVENT_NAME}}', escapeHtml(EVENT_NAME));
  send(res, 200, html, 'text/html; charset=utf-8');
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- routes ----------

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const { pathname } = url;

  if (req.method === 'GET' && pathname === '/') return serveHtml(res, 'index.html');
  if (req.method === 'GET' && pathname === '/admin') return serveHtml(res, 'admin.html');
  if (req.method === 'GET' && pathname === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && pathname === '/vendor/qrcode.js') {
    return send(res, 200, fs.readFileSync(path.join(PUBLIC_DIR, 'vendor', 'qrcode.js')), 'text/javascript; charset=utf-8');
  }

  if (req.method === 'GET' && pathname === '/api/search') {
    const q = clean(url.searchParams.get('q') || '', 100);
    if (q.length < 2) return send(res, 200, []);
    if (rateLimited(searchBuckets, clientIp(req), 120, 60_000)) return send(res, 429, { error: 'Searching too fast, slow down a little.' });
    try {
      return send(res, 200, await searchSongs(q));
    } catch (err) {
      console.error('Song search failed:', err.message);
      return send(res, 502, { error: 'Song search is unavailable right now.' });
    }
  }

  if (req.method === 'POST' && pathname === '/api/requests') {
    const body = await readJson(req);
    if (body.website) return send(res, 201, { ok: true }); // honeypot field: silently drop bots
    if (rateLimited(submitBuckets, clientIp(req), MAX_PER_GUEST_PER_HOUR, 3600_000)) {
      return send(res, 429, { error: 'Whoa, that is a lot of songs! Try again later.' });
    }
    const entry = {
      id: crypto.randomUUID(),
      artist: clean(body.artist, 120),
      title: clean(body.title, 160),
      track: null,
      name: clean(body.name, 60),
      note: clean(body.note, 200),
      createdAt: new Date().toISOString(),
    };
    // A song picked from search: re-fetch it from the catalog so the stored details can be trusted.
    if (/^\d{1,15}$/.test(String(body.trackId || ''))) {
      try {
        entry.track = await lookupTrack(String(body.trackId));
      } catch (err) {
        console.error('Track lookup failed, keeping typed text:', err.message);
      }
      if (entry.track) {
        entry.artist = entry.track.artist;
        entry.title = entry.track.title;
      }
    }
    if (!entry.artist || !entry.title) return send(res, 400, { error: 'Please pick a song, or fill in both artist and song title.' });
    requests.push(entry);
    saveRequests();
    return send(res, 201, { ok: true });
  }

  // Everything below is admin-only.
  const adminRoutes = ['/api/requests', '/api/songs', '/export.csv', '/export.txt', '/export.json'];
  if (adminRoutes.includes(pathname) || pathname.startsWith('/api/requests/')) {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'Wrong admin key.' });

    if (req.method === 'GET' && pathname === '/api/requests') return send(res, 200, requests);
    if (req.method === 'GET' && pathname === '/api/songs') {
      return send(res, 200, groupedSongs().map((s) => ({ ...s, links: links(s) })));
    }
    if (req.method === 'DELETE' && pathname.startsWith('/api/requests/')) {
      const id = decodeURIComponent(pathname.slice('/api/requests/'.length));
      const before = requests.length;
      requests = requests.filter((r) => r.id !== id);
      if (requests.length === before) return send(res, 404, { error: 'Not found' });
      saveRequests();
      return send(res, 200, { ok: true });
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const download = (ext) => ({ 'Content-Disposition': `attachment; filename="song-requests-${stamp}.${ext}"` });
    if (req.method === 'GET' && pathname === '/export.csv') return send(res, 200, toCsv(), 'text/csv; charset=utf-8', download('csv'));
    if (req.method === 'GET' && pathname === '/export.txt') return send(res, 200, toTxt(), 'text/plain; charset=utf-8', download('txt'));
    if (req.method === 'GET' && pathname === '/export.json') return send(res, 200, requests, undefined, download('json'));
  }

  send(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (!err.status) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : 'Server error' });
  });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Song requests for "${EVENT_NAME}" running on http://localhost:${PORT}`);
    console.log(`Admin page: http://localhost:${PORT}/admin`);
  });
}

module.exports = { server, groupedSongs, toCsv, toTxt };
