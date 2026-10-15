// The app on Node, with requests saved to a JSON file. Started by server.js.
// For Cloudflare, see worker.js.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp } from './app.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'requests.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

// Requests are kept in memory and saved to a JSON file.
function fileStore() {
  let requests = [];
  try {
    requests = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const save = () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(requests, null, 2));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  };
  return {
    list: async () => requests.map((r) => ({ ...r, track: r.track || null, voter: r.voter || '', kind: r.kind || 'request' })),
    add: async (entry) => {
      requests.push(entry);
      save();
    },
    remove: async (id) => {
      const before = requests.length;
      requests = requests.filter((r) => r.id !== id);
      if (requests.length === before) return false;
      save();
      return true;
    },
    // Settings (e.g. the guest list) live in their own small file.
    getSetting: async (key) => readSettings()[key] ?? null,
    setSetting: async (key, value) => {
      const settings = { ...readSettings(), [key]: value };
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(SETTINGS_FILE + '.tmp', JSON.stringify(settings, null, 2));
      fs.renameSync(SETTINGS_FILE + '.tmp', SETTINGS_FILE);
    },
  };
}

const app = createApp({
  store: fileStore(),
  adminKey: process.env.ADMIN_KEY || 'changeme',
  eventName: process.env.EVENT_NAME,
  musicCountry: process.env.MUSIC_COUNTRY,
  musicApi: process.env.MUSIC_API,
  deezerApi: process.env.DEEZER_API,
  maxPerGuestPerHour: Number(process.env.MAX_PER_GUEST_PER_HOUR) || undefined,
  // Only guests on the guest list can take part; REQUIRE_GUEST_LIST=false opens it to anyone with the link.
  requireGuestList: process.env.REQUIRE_GUEST_LIST !== 'false',
});

// The pages in public/ (on Cloudflare these are served as static assets).
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/admin': ['admin.html', 'text/html; charset=utf-8'],
  '/admin.html': ['admin.html', 'text/html; charset=utf-8'],
  '/vendor/qrcode.js': ['vendor/qrcode.js', 'text/javascript; charset=utf-8'],
  '/greeklish.js': ['greeklish.js', 'text/javascript; charset=utf-8'],
  '/background.jpg': ['background.jpg', 'image/jpeg'], // the party photo, optional
  '/background-dark.jpg': ['background-dark.jpg', 'image/jpeg'], // its dark-mode version
};

function readBody(req, limit = 64_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('Request too large.'), { status: 413 }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const file = STATIC[url.pathname];
    const filePath = file && path.join(ROOT, 'public', file[0]);
    if (req.method === 'GET' && file && fs.existsSync(filePath)) {
      res.writeHead(200, { 'Content-Type': file[1], 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(filePath));
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method);
    const request = new Request(url, { method: req.method, headers: req.headers, body: hasBody ? await readBody(req) : undefined });
    const fwd = req.headers['x-forwarded-for'];
    const ip = (fwd ? fwd.split(',')[0] : req.socket.remoteAddress || '').trim();
    const response = await app(request, ip);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) res.writeHead(err.status || 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.status ? err.message : 'Server error' }));
  }
});
