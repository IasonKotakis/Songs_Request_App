import { test, before, after } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'songs-'));
process.env.ADMIN_KEY = 'secret';
process.env.EVENT_NAME = 'Test Party';
let server, base;

before(async () => {
  ({ server } = await import('../src/node-server.js'));
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const post = (body) => fetch(base + '/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const admin = (p, opts = {}) => fetch(base + p, { ...opts, headers: { Authorization: 'Bearer secret' } });

// What the guest page sends after picking a song from Apple's search.
const pickedTrack = {
  id: '697195787', artist: 'Daft Punk', title: 'One More Time', album: 'Discovery',
  artwork: 'https://is1-ssl.mzstatic.com/image/thumb/a/120x120bb.jpg', durationMs: 320357, explicit: false,
  url: 'https://music.apple.com/us/album/one-more-time/697194953?i=697195787',
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/a/b.m4a',
  clean: false,
};

test('guest and admin pages load, config gives the party name', async () => {
  assert.match(await (await fetch(base + '/')).text(), /Request songs/);
  assert.match(await (await fetch(base + '/admin')).text(), /DJ Dashboard/);
  assert.strictEqual((await fetch(base + '/vendor/qrcode.js')).status, 200);
  const config = await (await fetch(base + '/api/config')).json();
  assert.strictEqual(config.eventName, 'Test Party');
  assert.strictEqual(config.musicCountry, 'US');
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
  assert.match(await (await admin('/export.csv')).text(), /"Daft Punk","One More Time","","","2","Ana; Bo"/);

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
  assert.strictEqual((await admin('/api/requests/nope', { method: 'DELETE' })).status, 404);
});

test('a picked song keeps its catalog details and merges with typed-in requests', async () => {
  assert.strictEqual((await post({ track: pickedTrack, artist: 'ignored', title: 'ignored', name: 'Cy' })).status, 201);
  const last = (await (await admin('/api/requests')).json()).at(-1);
  assert.strictEqual(last.title, 'One More Time');
  assert.deepStrictEqual(last.track, pickedTrack);

  const daft = (await (await admin('/api/songs')).json()).find((s) => s.artist === 'Daft Punk');
  assert.strictEqual(daft.count, 3);
  assert.strictEqual(daft.links.appleMusic, pickedTrack.url);
  assert.match(await (await admin('/export.csv')).text(), /"Discovery","5:20"/);
});

test('picked-song details are sanitised: only Apple links, bad tracks fall back to typed text', async () => {
  const evil = { ...pickedTrack, id: '1', artwork: 'https://evil.example/x.jpg', url: 'javascript:alert(1)', previewUrl: 'https://apple.com.evil.example/a.m4a', durationMs: 'lots' };
  await post({ track: evil });
  const t = (await (await admin('/api/requests')).json()).at(-1).track;
  assert.strictEqual(t.artwork, '');
  assert.strictEqual(t.url, '');
  assert.strictEqual(t.previewUrl, '');
  assert.strictEqual(t.durationMs, 0);

  await post({ track: { id: 'not-a-number', artist: 'X', title: 'Y' }, artist: 'Robyn', title: 'Hang With Me' });
  const last = (await (await admin('/api/requests')).json()).at(-1);
  assert.strictEqual(last.title, 'Hang With Me');
  assert.strictEqual(last.track, null);
});

test('a guest can send their whole list at once', async () => {
  const before = (await (await admin('/api/requests')).json()).length;
  const res = await post({
    songs: [{ track: { ...pickedTrack, id: '7', title: 'Digital Love' } }, { artist: 'Robyn', title: 'Call Your Girlfriend' }],
    name: 'Dee', note: 'for the dancefloor',
  });
  assert.strictEqual(res.status, 201);
  assert.strictEqual((await res.json()).added, 2);
  const all = await (await admin('/api/requests')).json();
  assert.strictEqual(all.length, before + 2);
  assert.deepStrictEqual(all.slice(-2).map((r) => [r.title, r.name, r.note]), [
    ['Digital Love', 'Dee', 'for the dancefloor'], ['Call Your Girlfriend', 'Dee', 'for the dancefloor'],
  ]);
});

test('a list with a broken song is rejected as a whole, and lists are capped', async () => {
  const before = (await (await admin('/api/requests')).json()).length;
  assert.strictEqual((await post({ songs: [{ artist: 'A', title: 'B' }, { artist: 'only artist' }] })).status, 400);
  assert.strictEqual((await post({ songs: [] })).status, 400);
  const tooMany = Array.from({ length: 31 }, (_, i) => ({ artist: 'A', title: 'Song ' + i }));
  assert.strictEqual((await post({ songs: tooMany })).status, 400);
  assert.strictEqual((await (await admin('/api/requests')).json()).length, before);
});

test('clean versions are flagged, and the dashboard shows the explicit version when both were asked for', async () => {
  const humble = { ...pickedTrack, artist: 'Kendrick Lamar', title: 'HUMBLE.', album: 'DAMN.', url: 'https://music.apple.com/x?i=2' };
  await post({ songs: [{ track: { ...humble, id: '1', clean: true } }, { track: { ...humble, id: '2', explicit: true, clean: true } }] });
  const all = await (await admin('/api/requests')).json();
  assert.deepStrictEqual(all.slice(-2).map((r) => [r.track.explicit, r.track.clean]), [[false, true], [true, false]]);
  const song = (await (await admin('/api/songs')).json()).find((x) => x.title === 'HUMBLE.');
  assert.strictEqual(song.count, 2);
  assert.strictEqual(song.track.id, '2');
});
