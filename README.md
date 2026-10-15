# 🎶 Party Song Requests

A tiny app that lets guests scan a QR code and drop in song requests before (and during) the party.
The DJ gets a dashboard where they can see every request and export the list to build a playlist.

- **Guest page** (`/`): a mobile-friendly page. Guests search for songs and see a dropdown with album art, similar to Spotify's search. They tap ▶ to hear a ~30-second preview, so they know they've got the right song, and tap + to add it to their list. They can keep searching and adding, then send the whole list with one button. When a song has both versions, the explicit one is listed first, marked **E**, with the **Clean** one right under it. Songs missing from the catalog can be typed in by hand. An unsent list is kept if they close the page. Guests give their name (converted to Greeklish if typed in Greek, e.g. Στέργιος → Stergios); a note for the DJ is optional.
- **🔥 Most requested** (guest page, under the name): the top 5 requested songs ranked 🥇🥈🥉 with their 👍 count, and *Show all* for the full list with a filter box. Guests tap 👍 to agree. Adding a song that's already on the list opens a pop-up with its rank and votes, offering a 👍 instead; after voting, the song's row lights up in the leaderboard with its new count. Each phone counts once per song.
- **DJ dashboard** (`/admin`, protected by a password):
  - the QR code for the guest page, plus the plain link, ready to download or print as a poster
  - all requests, with duplicates grouped and counted as votes, most-requested first
  - refreshes by itself every 20 seconds, shows when it last updated, and says so if loading fails
  - each song's **genre** (from the catalog), with filter buttons per genre. The exports and *Copy list* follow the filter, so you can make one playlist per genre
  - album art, album name and a ▶ 30-second preview for each song, plus a direct **Deezer** link for songs picked from search
  - songs that were typed in by hand are marked **typed**, so you know to double-check them
  - one-click Spotify / YouTube / Beatport search links for each song
  - **Export .txt**: one `Artist - Title` per line. Paste it into [TuneMyMusic](https://www.tunemymusic.com/) or [Soundiiz](https://soundiiz.com/) to turn it into a Spotify / Apple Music / Tidal playlist in one step.
  - **Export .csv**: a spreadsheet with votes, who asked, album, length, notes and links.
  - delete spam or joke requests

Song search uses [Deezer's](https://developers.deezer.com/api) free public catalog, which needs no account or key and includes explicit versions and 30-second previews. If Deezer can't be reached, it falls back to Apple's free [iTunes Search API](https://performance-partners.apple.com/search-api). (Apple's search is only the backup because since late 2025 it has been leaving explicit versions out of its results.) Each guest's phone searches directly, so a busy party never hits a per-address limit. Picked songs are stored with their official catalog names, which makes the `.txt` export match much better when you import it into a playlist.

## Try it on your computer first

1. Install [Node.js](https://nodejs.org): pick the **LTS** download. Restart your computer afterwards.
2. Download the app: on GitHub click **Code → Download ZIP**, then unzip it.
3. **Windows:** open the unzipped folder and double-click **`start-windows.bat`**.
   Windows may warn about an unknown file; click **More info → Run anyway**.
   **Mac / Linux:** open a terminal in the folder and run `npm start`.

A window opens showing the app's addresses, and your browser opens the DJ dashboard (password `changeme`). Keep that window open while testing; closing it stops the app.

**Skip re-downloading after every change (Windows):** install [Git for Windows](https://git-scm.com/download/win) (default options are fine), open PowerShell and run once:

```
cd $HOME\Documents
git clone https://github.com/IasonKotakis/Songs_Request_App.git
```

From then on, double-click `start-windows.bat` in `Documents\Songs_Request_App`. It fetches the latest version each time before starting.

**To test the QR code with your phone:** put the phone on the same Wi-Fi. The window prints a line like `http://192.168.1.23:3000/admin`. Open *that* address on your computer (not `localhost`), and scan the QR code shown there. If the phone can't load the page, allow Node.js through the Windows firewall when it asks.

**Getting `ENOENT` / error `-4058` from npm?** The terminal isn't in the app's folder. Unzipping on Windows often creates a folder inside a folder with the same name; go into the inner one, where `package.json` is. Or just use `start-windows.bat`.

## Put it online for free with Cloudflare

This runs on Cloudflare Workers with a D1 database. A party's worth of traffic stays well inside the free plan. You don't need a domain: Cloudflare gives you a free address like `https://song-requests.<your-name>.workers.dev`.

One-time setup, in a terminal in this folder:

1. `npm install`: installs Cloudflare's `wrangler` tool.
2. `npm run cf:login`: opens your browser to log in to (or sign up for) a free Cloudflare account.
3. `npm run cf:create-db`: creates the database and prints a `database_id`. Copy it into `wrangler.jsonc`, replacing the `00000000-…` placeholder.
4. In `wrangler.jsonc`, set `EVENT_NAME` to your party's name. Optionally set `MUSIC_COUNTRY` (e.g. `GR`, `GB`), the country for the backup Apple search.
5. `npm run cf:migrate`: creates the table in the database.
6. `npm run cf:deploy`: puts the app online and prints its address.
7. `npm run cf:password`: sets your dashboard password (it asks you to type it). Until you do this the site shows an error, which is on purpose.

Then open `https://<your-address>/admin`, log in, and print or share the QR code.

To change something later (e.g. the party name), edit `wrangler.jsonc` and run `npm run cf:deploy` again. Requests are kept.

**Try the Cloudflare version locally:** create a file called `.dev.vars` containing `ADMIN_KEY=changeme`, then run `npm run cf:dev` and open http://localhost:8787.

> Tip: download **Export .json** (`/export.json?key=…`) now and then as a backup.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `ADMIN_KEY` | `changeme` locally; must be set on Cloudflare | Password for the DJ dashboard and exports |
| `EVENT_NAME` | `The Party` | Shown on the pages |
| `MUSIC_COUNTRY` | `US` | Country catalog for the backup Apple search (two-letter code). Deezer uses the guest's own country automatically. |
| `MAX_PER_GUEST_PER_HOUR` | `60` | Basic spam limit: songs per hour from one IP address |
| `PORT`, `DATA_DIR` | `3000`, `./data` | Node version only: port, and where `requests.json` is saved |

On Cloudflare, `ADMIN_KEY` is a secret (`npm run cf:password`) and the rest go under `vars` in `wrangler.jsonc`. Locally, they are environment variables, e.g. `ADMIN_KEY=secret EVENT_NAME="My Party" npm start`.

## How it's built

- `src/app.js`: all the app logic, shared by both versions
- `worker.js`: Cloudflare version (stores requests in D1, schema in `migrations/`)
- `server.js` + `src/node-server.js`: Node version for local testing or any Docker host (stores requests in `data/requests.json`)
- `start-windows.bat`: double-click starter for Windows
- `public/`: the guest page and the dashboard
- `npm test` runs the tests for both versions

The QR code is generated in the browser with [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT), bundled in `public/vendor/`.
