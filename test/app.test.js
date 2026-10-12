const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'songs-'));
process.env.ADMIN_KEY = 'secret';
const { server } = require('../server');

let base;
before(() => new Promise((r) => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
after(() => server.close());

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
  assert.match(csv, /"Daft Punk","One More Time","2","Ana; Bo"/);

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
