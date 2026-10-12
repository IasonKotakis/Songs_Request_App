const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// Fake of Apple's iTunes Search API, answering in its real response format.
const catalog = [
  { kind: 'song', trackId: 697195787, artistName: 'Daft Punk', trackName: 'One More Time', collectionName: 'Discovery',
    artworkUrl100: 'https://example.com/a/100x100bb.jpg', trackTimeMillis: 320357, trackExplicitness: 'notExplicit',
    trackViewUrl: 'https://music.apple.com/us/album/one-more-time/697194953?i=697195787' },
  { kind: 'music-video', trackId: 5, artistName: 'Daft Punk', trackName: 'One More Time (Video)' },
];
let musicApiUp = true;
const fakeMusicApi = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (!musicApiUp) { res.writeHead(503); return res.end(); }
  let results = [];
  if (u.pathname === '/search') results = catalog.filter((t) => `${t.artistName} ${t.trackName}`.toLowerCase().includes(u.searchParams.get('term').toLowerCase()));
  if (u.pathname === '/lookup') results = catalog.filter((t) => String(t.trackId) === u.searchParams.get('id'));
  res.writeHead(200, { 'Content-Type': 'text/javascript' });
  res.end(JSON.stringify({ resultCount: results.length, results }));
});

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'songs-'));
process.env.ADMIN_KEY = 'secret';
let server;

let base;
before(async () => {
  await new Promise((r) => fakeMusicApi.listen(0, r));
  process.env.MUSIC_API = `http://localhost:${fakeMusicApi.address().port}`;
  ({ server } = require('../server'));
  await new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }));
});
after(() => { server.close(); fakeMusicApi.close(); });

const post = (body) => fetch(base + '/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const admin = (p, opts = {}) => fetch(base + p, { ...opts, headers: { Authorization: 'Bearer secret' } });

test('guest page loads', async () => {
  const res = await fetch(base + '/');
  assert.strictEqual(res.status, 200);
  assert.match(await res.text(), /Request a song/);
});

test('rejects incomplete requests', async () => {
  assert.strictEqual((await post({ artist: 'Only artist' })).status, 400);
});

test('stores, groups duplicates and exports', async () => {
  assert.strictEqual((await post({ artist: 'Daft Punk', title: 'One More Time', name: 'Ana' })).status, 201);
  assert.strictEqual((await post({ artist: 'daft punk', title: 'One more time!', name: 'Bo' })).status, 201);
  assert.strictEqual((await post({ artist: 'Robyn', title: 'Dancing On My Own' })).status, 201);

  const songs = await (await admin('/api/songs')).json();
  assert.strictEqual(songs.length, 2);
  assert.strictEqual(songs[0].count, 2);
  assert.deepStrictEqual(songs[0].requestedBy, ['Ana', 'Bo']);

  const txt = await (await admin('/export.txt')).text();
  assert.strictEqual(txt, 'Daft Punk - One More Time\nRobyn - Dancing On My Own\n');

  const csv = await (await admin('/export.csv')).text();
  assert.match(csv, /"Daft Punk","One More Time","","","2","Ana; Bo"/);

  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'requests.json'), 'utf8'));
  assert.strictEqual(saved.length, 3);
});

test('admin endpoints require the key', async () => {
  assert.strictEqual((await fetch(base + '/api/requests')).status, 401);
  assert.strictEqual((await fetch(base + '/export.txt?key=wrong')).status, 401);
  assert.strictEqual((await fetch(base + '/export.txt?key=secret')).status, 200);
});

test('admin can delete a request', async () => {
  const all = await (await admin('/api/requests')).json();
  assert.strictEqual((await admin('/api/requests/' + all[2].id, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await (await admin('/api/requests')).json()).length, all.length - 1);
});

test('search returns songs only, in a simple shape', async () => {
  const tracks = await (await fetch(base + '/api/search?q=one%20more')).json();
  assert.strictEqual(tracks.length, 1);
  assert.deepStrictEqual(tracks[0], {
    id: '697195787', artist: 'Daft Punk', title: 'One More Time', album: 'Discovery',
    artwork: 'https://example.com/a/120x120bb.jpg', durationMs: 320357, explicit: false,
    url: 'https://music.apple.com/us/album/one-more-time/697194953?i=697195787',
  });
  assert.deepStrictEqual(await (await fetch(base + '/api/search?q=o')).json(), []);
});

test('a picked song is verified against the catalog, not trusted from the browser', async () => {
  const res = await post({ trackId: '697195787', artist: 'Fake', title: 'Spoofed', name: 'Cy' });
  assert.strictEqual(res.status, 201);
  const all = await (await admin('/api/requests')).json();
  const last = all.at(-1);
  assert.strictEqual(last.artist, 'Daft Punk');
  assert.strictEqual(last.title, 'One More Time');
  assert.strictEqual(last.track.album, 'Discovery');

  // It merges with the typed-in request for the same song and lends it the catalog details.
  const songs = await (await admin('/api/songs')).json();
  const daft = songs.find((s) => s.artist === 'Daft Punk');
  assert.strictEqual(daft.count, 3);
  assert.match(daft.links.appleMusic, /music\.apple\.com/);
  assert.match(await (await admin('/export.csv')).text(), /"Discovery","5:20"/);
});

test('search outage: search reports it, and requests fall back to the typed text', async () => {
  musicApiUp = false;
  try {
    assert.strictEqual((await fetch(base + '/api/search?q=something%20new')).status, 502);
    assert.strictEqual((await post({ trackId: '123', artist: 'Robyn', title: 'Hang With Me' })).status, 201);
    const last = (await (await admin('/api/requests')).json()).at(-1);
    assert.strictEqual(last.title, 'Hang With Me');
    assert.strictEqual(last.track, null);
  } finally {
    musicApiUp = true;
  }
});
