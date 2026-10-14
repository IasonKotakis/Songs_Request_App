// Runs the app on Cloudflare Workers. Requests are stored in a D1 database (binding "DB").
// The pages in public/ are served by Cloudflare as static assets before this code runs.

import { createApp } from './src/app.js';

function d1Store(db) {
  const fromRow = (r) => ({
    id: r.id,
    artist: r.artist,
    title: r.title,
    track: r.track ? JSON.parse(r.track) : null,
    name: r.name,
    note: r.note,
    voter: r.voter || '',
    createdAt: r.created_at,
  });
  return {
    async list() {
      const { results } = await db.prepare('SELECT * FROM requests ORDER BY created_at, rowid').all();
      return results.map(fromRow);
    },
    async add(e) {
      await db
        .prepare('INSERT INTO requests (id, artist, title, track, name, note, voter, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
        .bind(e.id, e.artist, e.title, e.track ? JSON.stringify(e.track) : null, e.name, e.note, e.voter || '', e.createdAt)
        .run();
    },
    async remove(id) {
      const result = await db.prepare('DELETE FROM requests WHERE id = ?1').bind(id).run();
      return result.meta.changes > 0;
    },
  };
}

let app;

export default {
  async fetch(request, env) {
    if (!env.ADMIN_KEY) {
      return new Response('ADMIN_KEY is not set. Run: npx wrangler secret put ADMIN_KEY', { status: 500 });
    }
    app ??= createApp({
      store: d1Store(env.DB),
      adminKey: env.ADMIN_KEY,
      eventName: env.EVENT_NAME,
      musicCountry: env.MUSIC_COUNTRY,
      musicApi: env.MUSIC_API,
      deezerApi: env.DEEZER_API,
      maxPerGuestPerHour: Number(env.MAX_PER_GUEST_PER_HOUR) || undefined,
    });
    return app(request, request.headers.get('CF-Connecting-IP') || '');
  },
};
