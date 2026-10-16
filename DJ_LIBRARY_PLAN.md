# DJ Music Library Plan (personal project)

Status: tree design agreed; next step is placing the artist list into folders.

## Goal
Build a USB music library that is easy to navigate by hand, then import into
Rekordbox for analysis (BPM/key) and playlist/My Tag filtering. Folders are the
filing system; Rekordbox playlists and tags are the performance navigation.

## Pipeline per batch of new tracks
1. Downloads land in `00_INBOX/`.
2. **MusicBrainz Picard**: fix artist/title/album/year tags, embed cover art,
   save `cover.jpg`, rename to `Artist - Title (Mix).ext`, move into genre folder.
3. **OneTagger**: pull genre, BPM, key, label from Beatport/Traxsource/Discogs.
4. Import into **Rekordbox**, analyze, assign My Tags + colour, build playlists.
5. Master library lives on the computer; the USB is a copy. Keep a backup.

## Format targets
- Prefer FLAC (or AIFF for old CDJs). Minimum 320 kbps MP3. No 24-bit hi-res.
- Check suspicious files with Spek (fake 320/FLAC has a ~16 kHz cutoff).
- 128 GB stick holds roughly 2,500 club-length FLAC tracks. Leave 5–10% free.
- FAT32 for older CDJs, exFAT for CDJ-3000 era.

## Tree principles
- Max two levels: `Genre/Sub-folder/Track`. Never deeper.
- Number top-level folders in play-priority order (`01_`, `02_` ...).
- Folders answer one question: **what is the dominant sound?** One track, one home.
- Sub-folder axis may differ per genre: House/Techno/Disco split by style,
  Hip-Hop splits by era. Use whatever you reach for in a booth.
- A sub-folder exists only once it has ~30+ tracks; otherwise tracks sit at
  genre level. Split a folder only past ~300 tracks.
- Hybrid sub-genres (e.g. "Afro Deep Tech House") are NOT folders. Dominant
  element picks the folder; the other flavours become Rekordbox My Tags.
- Never put BPM/key/energy in folder or file names. Rekordbox stores those.
- 4–6 top-level genres, 3–5 sub-folders each. Do not mirror Beatport's list.
- Always keep `00_INBOX/` and `99_Archive/`.

## Tiebreaker rule for hybrids (decide in 5 seconds, then move on)
Drums first, then mood:
Afro percussion > tech-house drums (Tech House) > deep mood (Deep House)
> driving 4/4 kick (Techno). If still unsure, first fitting folder in list order.
Indie House vs Deep House: Ibiza-terrace feel = Deep House; festival/guitar
feel = Indie Dance.

## Agreed tree (v1)
```
DJ_MUSIC/
├── 00_INBOX/
├── 01_House/
│   ├── Tech House/              Mau P, Dom Dolla, Fisher
│   ├── Deep House/              early Solomun (Diynamic era)
│   ├── Afro House/              Keinemusik, Black Coffee, &ME
│   ├── Melodic House & Techno/  recent Solomun, Tale Of Us, ARTBAT
│   └── Vocal & Pop House/       radio-friendly crossovers
├── 02_Techno/
│   ├── Melodic/
│   ├── Peak Time/
│   └── Hard & Industrial/
├── 03_Electronic/               not straight house/techno
│   ├── Indie Dance & Indie House/   Bicep, Jamie xx, Moderat
│   ├── Electro & Breaks/
│   ├── Electronica & Downtempo/     Bonobo, Four Tet (warm-up)
│   └── Progressive & Trance/
├── 04_Disco/                    "music that does a disco job"
│   ├── Classic Disco (70s-80s)/
│   ├── Nu-Disco & Disco House/      Purple Disco Machine, Dimitri From Paris
│   ├── Italo Disco/
│   ├── French House & Filter/       Daft Punk, Cassius, Stardust
│   └── Electro Swing/
├── 05_Hip-Hop & RnB/            split by era; also tag YEAR in file
│   ├── 90s/
│   ├── 2000s/
│   ├── 2010s/
│   ├── 2020s/
│   └── RnB & Slow Jams/
├── 06_Open Format/
│   ├── Pop & Charts/
│   ├── Throwbacks (80s-00s)/
│   └── Edits & Mashups/
└── 99_Archive/
```

## Artist placement notes
- Artists don't belong to folders; tracks do. Solomun splits: Diynamic-era
  deep house vs. newer melodic house & techno.
- Mau P -> Tech House. Dom Dolla -> Tech House (keep simple unless you play two
  kinds of Dom Dolla sets).
- Afro House stays under House, not Electronic.
- Electro Swing and Italo sit under Disco for practical reasons, not taxonomy.

## Rekordbox layer (on top of folders)
- Genre tag = folder path, e.g. `House / Afro House`.
- My Tags for flavours/energy: Vocal, Percussive, Dark, Deep, Tech, Warm-Up, Build, Peak.
- Colour = energy (e.g. blue warm-up, yellow build, red peak).

## Genre lookup sources (best to worst for electronic)
Beatport (genre + BPM + key) > Traxsource/Juno > Discogs "Style" >
Music Genre Finder / Tunebat (BPM/key second opinion) > Spotify/Apple/Deezer/Tidal
(rarely show per-track genre). When sources disagree, your ears + fixed list win.

## Open items
- [ ] User to send artist list (grouped roughly as they think of them) so each
      artist can be placed and over/under-populated folders flagged.
- [ ] Brunello – "Ghost Dance" (Mellow Circus, 2025, 125 BPM, 6:12): Beatport says
      Melodic House & Techno (one page says Indie Tech). Not on Discogs. Place by ear.
- [ ] Decide whether Vocal & Pop House is needed or folds into Open Format.
- [ ] Benjo Selecta workbook: not found online; user may paste it for comparison.
