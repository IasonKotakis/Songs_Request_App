// Runs the Cloudflare Worker against a stand-in for D1 built on Node's SQLite
// (D1 is SQLite), using the real migration file.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker.js';

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  const dir = new URL('../migrations/', import.meta.url);
  for (const file of fs.readdirSync(dir).sort()) db.exec(fs.readFileSync(new URL(file, dir), 'utf8'));
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind: (...p) => ((params = p), stmt),
        all: async () => ({ results: db.prepare(sql).all(...params) }),
        first: async () => db.prepare(sql).get(...params) ?? null,
        run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } }),
      };
      return stmt;
    },
  };
}

const env = { DB: fakeD1(), ADMIN_KEY: 'k', EVENT_NAME: 'CF Party', MUSIC_COUNTRY: 'GR' };
const call = (p, opts = {}) => worker.fetch(new Request('https://song-requests.example.workers.dev' + p, opts), env);
const adminCall = (p, opts = {}) => call(p, { ...opts, headers: { Authorization: 'Bearer k' } });

test('worker: config, submit, list, export, delete on D1', async () => {
  assert.deepStrictEqual(await (await call('/api/config')).json(), { eventName: 'CF Party', musicCountry: 'GR', musicApi: 'https://itunes.apple.com', deezerApi: 'https://api.deezer.com' });

  const track = { source: 'apple', id: '42', artist: 'Robyn', title: 'Dancing On My Own', album: 'Body Talk', artwork: '', durationMs: 280000, explicit: false, url: 'https://music.apple.com/x?i=42', previewUrl: '', clean: false, genre: '' };
  const submit = (body) => call('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.strictEqual((await submit({ track, name: 'Ana' })).status, 201);
  assert.strictEqual((await submit({ artist: 'robyn', title: 'dancing on my own', note: 'peak time' })).status, 201);
  assert.strictEqual((await submit({ artist: 'Daft Punk', title: 'Aerodynamic' })).status, 201);

  assert.strictEqual((await call('/api/requests')).status, 401);
  const all = await (await adminCall('/api/requests')).json();
  assert.strictEqual(all.length, 3);
  assert.deepStrictEqual(all[0].track, track);
  assert.strictEqual(all[1].track, null);

  const songs = await (await adminCall('/api/songs')).json();
  assert.strictEqual(songs[0].count, 2);
  assert.deepStrictEqual(songs[0].notes, ['peak time']);
  assert.strictEqual(await (await adminCall('/export.txt')).text(), 'Robyn - Dancing On My Own\nDaft Punk - Aerodynamic\n');

  assert.strictEqual((await adminCall('/api/requests/' + all[2].id, { method: 'DELETE' })).status, 200);
  assert.strictEqual((await adminCall('/api/requests/' + all[2].id, { method: 'DELETE' })).status, 404);
  assert.strictEqual((await (await adminCall('/api/requests')).json()).length, 2);
});

test('worker: refuses to run without an admin key', async () => {
  const res = await worker.fetch(new Request('https://x.workers.dev/api/config'), { DB: fakeD1() });
  assert.strictEqual(res.status, 500);
});

test('worker: votes are stored with the device id on D1', async () => {
  const send = (path, body) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  await send('/api/requests', { artist: 'Robyn', title: 'Hang With Me', name: 'Ana', voter: 'device-ana-123' });
  const key = (await (await call('/api/public/songs')).json()).find((s) => s.title === 'Hang With Me').key;
  assert.strictEqual((await (await send('/api/votes', { key, voter: 'device-bo-1234', name: 'Bo' })).json()).count, 2);
  assert.strictEqual((await (await send('/api/votes', { key, voter: 'device-bo-1234', name: 'Bo' })).json()).already, true);
  const mine = (await (await call('/api/public/songs?voter=device-bo-1234')).json()).find((s) => s.key === key);
  assert.strictEqual(mine.mine, true);
});

test('worker: the guest list is stored in D1 settings', async () => {
  const put = await call('/api/guests', { method: 'PUT', headers: { Authorization: 'Bearer k', 'Content-Type': 'application/json' }, body: JSON.stringify({ names: ['Jim', 'Stergios'] }) });
  assert.deepStrictEqual((await put.json()).names, ['Jim', 'Stergios']);
  assert.deepStrictEqual(await (await adminCall('/api/guests')).json(), { names: ['Jim', 'Stergios'] });
  assert.deepStrictEqual(await (await call('/api/guest-check?name=jimmy')).json(), { ok: false, error: 'Sorry, "jimmy" isn\'t on the guest list. Use your name as the hosts know it, in Latin letters.' });
  assert.deepStrictEqual(await (await call('/api/guest-check?name=%CE%A3%CF%84%CE%AD%CF%81%CE%B3%CE%B9%CE%BF%CF%82')).json(), { ok: true, name: 'Stergios' });
});
