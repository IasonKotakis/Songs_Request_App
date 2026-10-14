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
  source: 'apple', id: '697195787', artist: 'Daft Punk', title: 'One More Time', album: 'Discovery',
  artwork: 'https://is1-ssl.mzstatic.com/image/thumb/a/120x120bb.jpg', durationMs: 320357, explicit: false,
  url: 'https://music.apple.com/us/album/one-more-time/697194953?i=697195787',
  previewUrl: 'https://audio-ssl.itunes.apple.com/itunes-assets/AudioPreview/a/b.m4a',
  clean: false,
  genre: 'Electronic',
};

test('guest and admin pages load, config gives the party name', async () => {
  assert.match(await (await fetch(base + '/')).text(), /Request songs/);
  assert.match(await (await fetch(base + '/admin')).text(), /DJ Dashboard/);
  assert.strictEqual((await fetch(base + '/vendor/qrcode.js')).status, 200);
  assert.strictEqual((await fetch(base + '/background.jpg')).status, fs.existsSync(new URL('../public/background.jpg', import.meta.url)) ? 200 : 404);
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
  assert.strictEqual(songs[0].ids.length, 2); // the dashboard's ✕ removes all of a song's requests

  const txt = await (await admin('/export.txt')).text();
  assert.strictEqual(txt, 'Daft Punk - One More Time\nRobyn - Dancing On My Own\n');
  assert.match(await (await admin('/export.csv')).text(), /"Daft Punk","One More Time","Unknown","","","2","Ana; Bo"/);

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
  assert.strictEqual(daft.links.listen, pickedTrack.url);
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

test('songs picked from Deezer keep Deezer links; links to other sites are dropped', async () => {
  const deezer = {
    source: 'deezer', id: '350171311', artist: 'Kendrick Lamar', title: 'DNA.', album: 'DAMN.',
    artwork: 'https://cdn-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg', durationMs: 177000, explicit: true, clean: false,
    url: 'https://www.deezer.com/track/350171311', genre: 'Rap/Hip Hop', previewUrl: 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/abc.mp3?hdnea=exp=1',
  };
  await post({ songs: [{ track: deezer }, { track: { ...deezer, id: '1', artwork: 'https://mzstatic.com.evil.example/a.jpg', url: 'https://music.apple.com/x' } }] });
  const [a, b] = (await (await admin('/api/requests')).json()).slice(-2).map((r) => r.track);
  assert.deepStrictEqual(a, deezer);
  assert.strictEqual(b.artwork, '');
  assert.strictEqual(b.url, '');
  const song = (await (await admin('/api/songs')).json()).find((x) => x.title === 'DNA.');
  assert.match(await (await admin('/export.csv')).text(), /"Deezer","https:\/\/www\.deezer\.com\/track\/350171311"/);
  assert.ok(song.track.explicit);
});

test('songs carry a genre, and exports can be limited to one genre', async () => {
  const songs = await (await admin('/api/songs')).json();
  assert.strictEqual(songs.find((x) => x.title === 'One More Time').genre, 'Electronic');
  assert.strictEqual(songs.find((x) => x.title === 'Hang With Me').genre, 'Unknown');

  const res = await admin('/export.txt?genre=' + encodeURIComponent('Rap/Hip Hop'));
  assert.strictEqual(await res.text(), 'Kendrick Lamar - DNA.\n');
  assert.match(res.headers.get('content-disposition'), /song-requests-rap-hip-hop-/);
  const csv = await (await admin('/export.csv?genre=Electronic')).text();
  assert.match(csv, /"Artist","Title","Genre"/);
  assert.ok(csv.includes('"One More Time","Electronic"') && !csv.includes('DNA.'));
  assert.strictEqual(await (await admin('/export.txt?genre=Unknown')).text(), toTxtTitles(songs.filter((x) => x.genre === 'Unknown')));
});
const toTxtTitles = (list) => list.map((x) => `${x.artist} - ${x.title}`).join('\n') + '\n';

const vote = (body) => fetch(base + '/api/votes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const publicSongs = async (voter = '') => (await fetch(base + '/api/public/songs?voter=' + voter)).json();

test('guests see what was requested (counts only), upvote once, and can take it back', async () => {
  await post({ songs: [{ artist: 'Outkast', title: 'Hey Ya!' }], name: 'Eve', note: 'secret note', voter: 'device-eve-1' });
  let hey = (await publicSongs('device-eve-1')).find((s) => s.title === 'Hey Ya!');
  assert.deepStrictEqual([hey.count, hey.mine], [1, true]);
  assert.ok(!('requestedBy' in hey) && !('notes' in hey) && !JSON.stringify(hey).includes('Eve'));

  // Someone else 👍s it: needs a name, counts once however often they tap.
  assert.strictEqual((await vote({ key: hey.key, voter: 'device-finn-1' })).status, 400);
  assert.strictEqual((await (await vote({ key: hey.key, voter: 'device-finn-1', name: 'Finn' })).json()).count, 2);
  assert.strictEqual((await (await vote({ key: hey.key, voter: 'device-finn-1', name: 'Finn' })).json()).already, true);
  hey = (await publicSongs('device-finn-1')).find((s) => s.title === 'Hey Ya!');
  assert.deepStrictEqual([hey.count, hey.mine], [2, true]);
  const dash = (await (await admin('/api/songs')).json()).find((s) => s.title === 'Hey Ya!');
  assert.deepStrictEqual([dash.count, dash.requestedBy], [2, ['Eve', 'Finn']]);

  // Re-requesting a song you already asked for doesn't count twice.
  const again = await (await post({ songs: [{ artist: 'outkast', title: 'hey ya' }], name: 'Finn', voter: 'device-finn-1' })).json();
  assert.deepStrictEqual([again.added, again.alreadyHad], [0, 1]);

  // Taking the 👍 back.
  assert.strictEqual((await (await vote({ key: hey.key, voter: 'device-finn-1', remove: true })).json()).count, 1);
  assert.strictEqual((await publicSongs()).find((s) => s.title === 'Hey Ya!').count, 1);
  assert.strictEqual((await vote({ key: 'nope|nope', voter: 'device-finn-1', name: 'Finn' })).status, 404);
});

test('guest names are stored in Greeklish', async () => {
  await post({ songs: [{ artist: 'Vegas', title: 'Ki Ego Gia Sena' }], name: 'Στέργιος', voter: 'device-greek-1' });
  const key = (await publicSongs()).find((s) => s.title === 'Ki Ego Gia Sena').key;
  await vote({ key, voter: 'device-greek-2', name: 'Άγγελος 🎉' });
  const song = (await (await admin('/api/songs')).json()).find((s) => s.title === 'Ki Ego Gia Sena');
  assert.deepStrictEqual(song.requestedBy, ['Stergios', 'Aggelos']);
  assert.strictEqual((await vote({ key, voter: 'device-greek-3', name: '🎉🎉' })).status, 400);
});
