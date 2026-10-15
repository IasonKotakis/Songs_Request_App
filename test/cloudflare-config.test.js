import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { deployConfig, findDatabaseId } from '../tools/cloudflare-config.mjs';

test('deploy config gets the real database id', () => {
  const base = fs.readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8');
  const out = deployConfig(base, 'abcd-1234');
  assert.match(out, /"database_id": "abcd-1234"/);
  assert.strictEqual(out.replace('abcd-1234', '00000000-0000-0000-0000-000000000000'), base);
});

test('database id is found in wrangler output, even after warnings', () => {
  const out = '\u001b[33m▲ [WARNING] Proxy environment variables detected.\u001b[0m\n\n[\n  { "uuid": "u-1", "name": "other" },\n  { "uuid": "u-2", "name": "song-requests" }\n]\n';
  assert.strictEqual(findDatabaseId(out), 'u-2');
  assert.strictEqual(findDatabaseId('[WARNING] nothing\n[]'), null);
  assert.strictEqual(findDatabaseId('error'), null);
});
