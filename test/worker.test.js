// Runs the Cloudflare Worker against a stand-in for D1 built on Node's SQLite
// (D1 is SQLite), using the real migration file.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker.js';

function fakeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(new URL('../migrations/0001_create_requests.sql', import.meta.url), 'utf8'));
  return {
    prepare(sql) {
      let params = [];
      const stmt = {
        bind: (...p) => ((params = p), stmt),
        all: async () => ({ results: db.prepare(sql).all(...params) }),
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
  assert.deepStrictEqual(await (await call('/api/config')).json(), { eventName: 'CF Party', musicCountry: 'GR', musicApi: 'https://itunes.apple.com' });

  const track = { id: '42', artist: 'Robyn', title: 'Dancing On My Own', album: 'Body Talk', artwork: '', durationMs: 280000, explicit: false, url: 'https://music.apple.com/x?i=42', previewUrl: '' };
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
