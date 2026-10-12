# 🎶 Party Song Requests

A tiny app that lets guests scan a QR code and drop in song requests before (and during) the party.
The DJ gets a dashboard where they can see every request and export the list to build a playlist.

- **Guest page** (`/`): a mobile-friendly form with artist, title, optional name and note. Guests can send as many songs as they like.
- **DJ dashboard** (`/admin`, protected by a key):
  - the QR code for the guest page, ready to download or print as a poster
  - all requests, with duplicates grouped and counted as votes, most-requested first
  - one-click Spotify / YouTube / Beatport search links for each song
  - **Export .txt**: one `Artist - Title` per line. Paste it into [TuneMyMusic](https://www.tunemymusic.com/) or [Soundiiz](https://soundiiz.com/) to turn it into a Spotify / Apple Music / Tidal playlist in one step.
  - **Export .csv**: a spreadsheet with votes, who asked, notes and search links, for sourcing tracks (for example, buying them on Beatport).
  - delete spam or joke requests

No database and no npm dependencies. Requests are saved to `data/requests.json`.

## Run it locally

```bash
ADMIN_KEY=pick-a-secret EVENT_NAME="Iason's Birthday" npm start
# guests:  http://localhost:3000/
# you:     http://localhost:3000/admin
```

Requires Node 18 or newer. Run `npm test` for the tests.

## Put it online so guests can scan the QR

Guests will use it in the days before the party, so it needs to run on a public host. The host also **needs persistent storage**, otherwise requests are lost on every restart or redeploy. Set `DATA_DIR` to the mounted volume's path.

**Railway** (simple option):
1. Create a new project from this GitHub repo.
2. Add a **Volume** mounted at `/data`.
3. Set the variables `ADMIN_KEY`, `EVENT_NAME` and `DATA_DIR=/data`.
4. Generate a public domain, open `https://<your-domain>/admin`, and print the QR code.

**Fly.io / Render / any Docker host:** a `Dockerfile` is included. It stores data in `/data`, so mount a volume or disk there.

> Tip: download **Export .json** (`/export.json?key=…`) now and then as a backup.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `ADMIN_KEY` | `changeme` | Password for the DJ dashboard and exports. **Change this!** |
| `EVENT_NAME` | `The Party` | Shown on the pages |
| `PORT` | `3000` | HTTP port |
| `DATA_DIR` | `./data` | Folder where `requests.json` is stored |
| `MAX_PER_GUEST_PER_HOUR` | `20` | Basic spam limit, counted per IP address |

## Credits

The QR code is generated in the browser with [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), bundled in `public/vendor/`.
