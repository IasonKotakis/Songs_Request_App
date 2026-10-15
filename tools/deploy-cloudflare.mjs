// Puts the app online on Cloudflare (Workers + D1), or updates it. Run with `npm run cf:deploy`
// or double-click deploy-cloudflare.bat. Safe to run again any time: it only does what's missing.
//
// Steps: log in to Cloudflare → find or create the "song-requests" database → write
// wrangler.deploy.jsonc (the repo's wrangler.jsonc + your database id; kept out of git) →
// apply database migrations → deploy → set the dashboard password the first time.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deployConfig, findDatabaseId } from './cloudflare-config.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRANGLER = path.join(ROOT, 'node_modules', 'wrangler', 'bin', 'wrangler.js');
const DB_NAME = 'song-requests';   // as in wrangler.jsonc
const DEPLOY_CONFIG = 'wrangler.deploy.jsonc';
const STATE_FILE = path.join(ROOT, '.cloudflare-state.json');

const say = (text) => console.log(`\n=== ${text}`);
function wrangler(args, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [WRANGLER, ...args], {
    cwd: ROOT,
    stdio: capture ? ['inherit', 'pipe', 'pipe'] : 'inherit',
    encoding: 'utf8',
  });
  return { ok: result.status === 0, out: `${result.stdout || ''}${result.stderr || ''}` };
}
function stop(message) {
  console.error(`\n✗ ${message}\n`);
  process.exit(1);
}

function main() {
  // Cloudflare's tool (wrangler) needs Node.js 22 or newer.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (nodeMajor < 22) {
    stop(`Cloudflare's tool needs Node.js 22 or newer, and this computer has ${process.versions.node}.
  1. Download the "LTS" version from https://nodejs.org and install it (it replaces the old one).
  2. Restart your computer.
  3. Run this again.`);
  }
  if (!fs.existsSync(WRANGLER)) stop('Cloudflare\'s tool isn\'t installed yet. Run "npm install" in this folder first.');
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  const saveState = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

  say('1/5 Logging in to Cloudflare');
  const who = wrangler(['whoami'], { capture: true });
  if (!who.ok || /not authenticated|not logged in/i.test(who.out)) {
    console.log('A browser window will open: log in to (or sign up for) your free Cloudflare account and press "Allow".');
    if (!wrangler(['login']).ok) stop('Logging in didn\'t work. Run this again to retry.');
  } else {
    console.log('Already logged in.');
  }

  say('2/5 Setting up the database');
  let id = findDatabaseId(wrangler(['d1', 'list', '--json'], { capture: true }).out);
  if (!id) {
    console.log(`Creating the "${DB_NAME}" database (free)...`);
    if (!wrangler(['d1', 'create', DB_NAME], { capture: true }).ok) stop('Could not create the database. Run this again to retry.');
    id = findDatabaseId(wrangler(['d1', 'list', '--json'], { capture: true }).out);
    if (!id) stop('The database was created but could not be found. Run this again.');
  }
  console.log(`Database ready (${id}).`);
  fs.writeFileSync(path.join(ROOT, DEPLOY_CONFIG), deployConfig(fs.readFileSync(path.join(ROOT, 'wrangler.jsonc'), 'utf8'), id));

  say('3/5 Updating the database tables (type "y" and Enter if asked)');
  if (!wrangler(['d1', 'migrations', 'apply', DB_NAME, '--remote', '-c', DEPLOY_CONFIG]).ok) stop('Updating the database failed. Run this again to retry.');

  say('4/5 Putting the app online');
  console.log('If asked to pick a workers.dev subdomain, choose a short name: it becomes part of your link.');
  if (!wrangler(['deploy', '-c', DEPLOY_CONFIG]).ok) stop('Deploying failed. Run this again to retry.');

  say('5/5 Dashboard password');
  if (state.passwordSet) {
    console.log('Already set. (To change it: npm run cf:password)');
  } else {
    console.log('Choose the password for the DJ dashboard and type it below (it won\'t show while you type), then press Enter.');
    if (!wrangler(['secret', 'put', 'ADMIN_KEY', '-c', DEPLOY_CONFIG]).ok) stop('Setting the password failed. Run this again to retry.');
    state.passwordSet = true;
    saveState();
  }

  console.log(`
✓ Done! Your app is online at the https://song-requests.<your-subdomain>.workers.dev address shown above.
  Next:
  1. Open that address with /admin at the end, log in with your password.
  2. Paste the guest list into "Guest list" and press Save. Until then nobody can request songs.
  3. Share the QR code. To publish later changes, run this again.
`);
}

main();
