# SeatNav handover

A live map of free study seats at Dartmouth (ENGS 21, team 28). One radar sensor per seat sends its state to a backend, and a mobile web page shows it on a 3D floor map.
The audience is students, so wording stays short and jargon-free. Only the test bench shows raw sensor details.

## How it fits together

```
ESP32 + LD2410 radar --POST /api/report--> FastAPI (main.py, store.py, SQLite) --/api/seats + WS /ws--> static/ (3D web page)
  seatnav_http.ino      X-Device-Key        on Render: seatnav.onrender.com         served at /
```

- **Firmware** (`seatnav_http.ino`): states FREE → OCCUPIED → AWAY → FREE, with a 30 s heartbeat. "Near" means a radar target within `SEAT_RANGE_CM` (100 cm). The test timings are on; the real timings are commented out. `SEAT_ID` must match a seat ID in a layout file: `seat-01`…`seat-06` for Feldberg, `test-01` for the test bench. The state diagram is in `docs/state-diagram.png`, with an editable `.svg`; to re-render it, use headless Chrome with `--force-device-scale-factor=2 --window-size=1600,1040 --screenshot=...` on the `.svg`.
- **Backend** (`main.py`, `store.py`): a seat goes OFFLINE after 90 s of silence. `/` serves `static/index.html` and `/static/*` serves the rest of the frontend. The backend doesn't know about places; every sensor reports into one pool, and each place's layout picks out its own seats. Every raw report (heartbeats too) is kept in a `reports` table for analysis. `store.py` still has unused MQTT leftovers.
- **Data collector** (`tools/collector.py`): copies everything from `GET /api/log` into `data/collected.db` every 20 s, because Render wipes its disk on each restart. See "Collecting data" below.
- **Frontend** (`static/`): plain HTML/JS with no build step. three.js 0.186.1 comes from jsDelivr through the import map in `index.html`.
  - `index.html`: shell and all CSS. Colour tokens are CSS variables, and `floor.js` reads the `--scene-*` and state colours from them.
  - `app.js`: the place picker, live data (REST snapshot plus WebSocket), header, list view (tiles), seat sheet, "Find a seat" with watch-and-buzz, toasts, demo mode and test-bench debug details. It imports `floor.js` lazily, so the list works without WebGL.
  - `floor.js`: the 3D scene, built entirely from a layout file: walls, brick, windows and glass, carpet texture, furniture builders (`BUILD`), carrels, people (`makePerson`), state visuals, camera presets, taps.
  - `places.json`: the place picker list. Only entries with a `layout` can be opened; the others show "Soon". Testing places are never remembered as the default.
  - `layout/feldberg-1.json`: the Feldberg ground floor. Coordinates are pixels of `layout/feldberg-1-plan.png`, at 0.033 m per pixel.
  - `layout/test-bench.json`: one desk and one sensor (`test-01`) for testing and showcasing. Coordinates are in cm; `"testing": true` turns on the debug wording.
  - `cards.html`: the old card dashboard, kept for debugging.
- **Expo app** (`seatnav-app/`): the earlier native prototype, no longer the target. Expo Go from the App Store stops at SDK 54, and this app is on SDK 57. The reference photos of the floor are in `seatnav-app/assets/*.jfif`.

## Layout file cheat-sheet

- `compartments`: blocks of seats with `seats` rows (top to bottom, `[west, east]`).
  - A block with `"inactive": true` is drawn but shows "Coming soon".
  - `"panels": false` gives plain desks with no carrel panels.
  - In Feldberg only the east block (`seat-01`…`seat-06`) is live. The four blocks are 2.7 m apart, centred on the elevator; the original sketch was too tight.
- `furniture`: types `table`, `terminals`, `armchair`, `lounge`, `side_table`, `pillar`, `plant`, `shelves` (`stacks` / `dark` / `reference`), `counter` (`style: "cabinet"` for dark cabinets), `whiteboard`, `cart`, `book_display`, `garland` and `person` (staff, e.g. the smiling person at the front desk). Each one is a function in `BUILD` in `floor.js`.
- `rooms`: areas with no seats (conference room, restrooms and elevator, study rooms, offices, Murdough, the Byrne exit room), drawn as blank blocks.
  - Walls are 1.9 m with a grey gradient set by the `--room-top` / `--room-bottom` CSS tokens, so they follow the light/dark theme. Room walls are drawn slightly thicker than normal walls, so old walls under them don't flicker.
  - Edges listed in `curtain_edges` get white curtains behind glass (edge i runs from outline point i to point i+1).
  - There are no labels or decorations on rooms, on purpose: the map is for students, so it carries as few words as possible.
- `rugs`: decorative area rugs (`at`, `size_m`, `color`). The test bench has one; Feldberg has none, because the real floor has none.
- Map wording: Feldberg only labels Front desk, Murdough, Bloomberg Terminals, the "Coming soon" tags and the exits (To Irving / To Byrne, with arrows outside the doors).
- Other keys:
  - `walls`, `brick`, `windows` (dark frames) and `glass` (white frames) are line segments.
  - `outline` is the floor slab.
  - `labels`, `tags` ("Coming soon" pills) and `entrances` (arrows) add annotations.
  - `seat_names` gives custom display names.
  - `carrel_view` is the default camera.
  - `away_timeout_min` must match the firmware.

## Run and test

```
pip install -r requirements.txt
uvicorn main:app --port 8000          # http://localhost:8000
curl -X POST localhost:8000/api/report -H "X-Device-Key: dev-key-change-me" -H "Content-Type: application/json" -d '{"seat":"test-01","state":"FREE"}'
```

- **URL options:**

| Option | Effect |
|---|---|
| `?place=feldberg\|test` | opens that place |
| `?demo` | fake live data; nothing is sent to the server |
| `?view=floor\|top` | starts in that camera view |
| `?seat=seat-03` | opens that seat (for a QR sticker on the desk) |
| `?list` | opens the list view |
| `?places` | opens the place picker |

- **Screenshots:** headless Chrome works with `--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=500,1083 --virtual-time-budget=15000 --screenshot=...`. Windows narrower than about 500 px get cropped. `--blink-settings=preferredColorScheme=1` gives light mode. Occasionally a run fails to fetch `floor.js` from the CDN; running it again fixes it.
- On this machine FastAPI is in the user site-packages, so don't run Python with `-I`.
  - That global install no longer starts the app: FastAPI 0.111 there is paired with a newer Starlette that dropped `on_startup`.
  - Test in a throwaway venv instead: `python -m venv venv` then `venv\Scripts\pip install -r requirements.txt httpx`. That matches what Render installs (FastAPI 0.162 / Starlette 1.10 on 2026-11-09).
- Deploy by committing and pushing; Render redeploys. Render's free tier sleeps after 15 min idle and its disk is ephemeral, so the history resets on each deploy. The sensors' heartbeats keep it awake.
- The GitHub repo is now `aayans314/SeatNav`; the old `ENGS21-Team28` URL redirects.

## Collecting data

```
python tools/collector.py run       # keep running; copies new rows every 20 s (log: data/collected.log)
python tools/collector.py status    # last successful poll, rows per seat, backend restarts seen
python tools/collector.py export    # data/export/: reports, events, intervals (timelines), hourly (% taken)
```

- To start it in the background, double-click `tools/start-collector.cmd` in File Explorer. Started that way, it doesn't depend on any terminal or editor. Step-by-step instructions are in `DATA_COLLECTION.txt`.
- Standard library only; one collector at a time (lock file), so starting it twice is harmless. It also asks Windows not to idle-sleep while it runs.
- Until `/api/log` exists on the server (an older deploy), it falls back to the per-seat history endpoints, which give state changes only. `import-snapshot DIR` loads history saved with curl.
- If this computer sleeps or goes offline, nothing is lost: the backend keeps every row since its last restart, and the collector catches up. Data is lost only if Render restarts while the collector isn't running.
- `GET /api/export/reports.csv` and `/api/export/events.csv` (`?hours=`) download what the backend has right now, straight from a browser.
- `intervals.csv` marks `NO_DATA` where Render restarted between polls. `hourly.csv`'s `taken_pct` counts OCCUPIED and AWAY as taken.
- `data/` is git-ignored.
- `python tools/pitch_charts.py` (needs pandas and matplotlib) turns `data/export/` into the pitch charts and `PITCH_STATS.txt` in `docs/pitch/`. Seats 02 and 04 are left out of its usage charts (see the status below).

## Status (2026-11-12)

**Pilot data run: finished.** Six Feldberg sensors (`seat-01`…`seat-06`) reported from Sat 2026-11-07 about 13:00 until they were taken down on Thu 2026-11-12 about 20:15. That's 5.3 days.
- They ran the test timings with the 100 cm range; `seatnav_http.ino` is the flashed version, apart from the per-sensor `SEAT_ID`.
- The collector caught everything: Render never restarted during the run. The data is only on the laptop that ran it, in `data/collected.db` (git-ignored). The Sat–Mon part has state changes only, saved before raw logging existed (`data/pre-deploy/`).
- Results are in `docs/pitch/`: 96.8% uptime, weekday peak 1–2 PM (54% of seat time taken), seat 01 used 4× as much as seat 06.

**Sensor problems found in the data:**
- `seat-04` reports a still object at exactly 30 cm between 2 and 6 AM every night (46% of night check-ins), so it shows as taken almost all the time. `seat-02` does the same on some nights (10%).
- All the other seats read 0% at night. Both sensors need re-mounting or re-aiming and re-testing.
- Seat 01 shows activity early on Monday (about 3–10 AM) that may not be real.

**Known mismatch:** `layout/feldberg-1.json` has `away_timeout_min: 15`, but the flashed firmware frees an AWAY seat after 60 s.

**Kept out of the public repo on purpose:** `docs/SeatNav_BusinessPlan.pdf` and `docs/BUSINESS_PLAN_REVIEW.txt` (notes on improving the plan).

## Status (2026-10-30)

**Done and verified in headless Chrome:**
- The Feldberg floor with 4 compartments (1 live) and furniture modelled on the photos, including the front desk with its staff member, cabinets, glass office and carts.
- The 3 seats facing the brick wall, and the carpet texture.
- People with clothes, hair and a face.
- The place picker (Feldberg live, other Dartmouth libraries and study spaces listed as coming soon, plus a Testing section).
- The test bench, with debug wording.
- The list view, short student-facing wording, Find a seat, toasts and demo mode.

**Not verified:**
- Real phones (touch, performance, safe areas).
- Tapping a seat and the seat sheet; the no-WebGL fallback.
- The place list was partly confirmed online (Baker-Berry, Rauner, Sherman, Matthews-Fuller). The other entries should be checked against https://www.library.dartmouth.edu/visit before launch.

## Next steps

1. Test on real phones and tune: cap the pixel ratio and turn shadows off on low-end devices if needed.
2. Switch the firmware to the real timings and keep `away_timeout_min` in the layout in sync. Fix the `seat-02` / `seat-04` false detections: re-mount or re-aim and re-test. Consider a backend check that flags any seat that stays taken all night.
3. Add a PWA manifest and icon (add to home screen); real push alerts for "watching" need a service worker.
4. Add QR posters (`/?place=feldberg`) and per-seat stickers (`/?seat=seat-0N`).
5. Clean-up: remove the MQTT leftovers in `store.py`, tighten CORS, and set a real `DEVICE_KEYS` on Render.
6. For data that survives Render restarts without a laptop, point the backend at a hosted database (e.g. Render Postgres) instead of SQLite on the ephemeral disk.
