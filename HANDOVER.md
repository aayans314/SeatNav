# SeatNav handover

Live map of free study carrels on Feldberg Library's ground floor (Dartmouth ENGS 21, team 28).
One radar sensor per carrel sends its state to a backend, and a mobile web page shows it on a 3D floor map.

## How it fits together

```
ESP32 + LD2410 radar --POST /api/report--> FastAPI (main.py, store.py, SQLite) --/api/seats + WS /ws--> static/ (3D web page)
  seatnav_http.ino      X-Device-Key        on Render: engs21-team28.onrender.com         served at /
```

- **Firmware** (`seatnav_http.ino`): states FREE → OCCUPIED → AWAY → FREE, with a 30 s heartbeat. The test timings are on; the real Feldberg timings are commented out. `SEAT_ID` must match a seat ID in the layout file.
- **Backend** (`main.py`, `store.py`): a seat goes OFFLINE after 90 s of silence. `/` serves `static/index.html`, and `/static/*` serves the rest of the frontend. `store.py` still has unused MQTT leftovers (`retained` flags).
- **Frontend** (`static/`): plain HTML/JS with no build step. three.js 0.186.1 comes from jsDelivr through the import map in `index.html`.
  - `index.html`: page shell and all styling. The colour tokens are CSS variables, and `floor.js` reads the `--scene-*` and state colours from them.
  - `app.js`: loads the layout and live data (REST snapshot plus WebSocket with reconnect), then drives the header counts, list, detail sheet (24 h usage and history), toasts, "Find me a seat" and demo mode. It imports `floor.js` lazily, so the list still works without WebGL.
  - `floor.js`: the 3D scene, built entirely from the layout file: walls, windows, glass, furniture, carrels, live state visuals, camera presets, taps.
  - `layout/feldberg-1.json`: **the floor, edited as data.** Coordinates are pixels of `layout/feldberg-1-plan.png`; `metres_per_px` is 0.033.
  - `cards.html`: the old card dashboard, kept for debugging.
- **Expo app** (`seatnav-app/`): the earlier native prototype, not the target any more. Expo Go from the App Store stops at SDK 54, and this app is on SDK 57. The reference photos (`i1`–`i9`, `s`, `t` `.jfif`) live in `seatnav-app/assets/` and are untracked.

## Layout file cheat-sheet (`static/layout/feldberg-1.json`)

- `compartments`: 4 carrel blocks (2 columns × 3 rows; `seats` rows run top to bottom as `[west, east]`).
  - Only blocks **without** `"inactive": true` are live; right now that's the east block nearest Irving, seat-01 to seat-06.
  - To bring another block online, flash its sensors with those seat IDs and delete `inactive`.
  - Blocks are spaced 82 px (2.7 m) apart, symmetric about the elevator (x = 414). The user's sketch had about 0.3 m between facing chairs, so the spacing was widened.
- `furniture`: types `table`, `terminals`, `armchair`, `lounge`, `side_table`, `pillar`, `plant`, `shelves` (`stacks` / `dark` / `reference`) and `counter`. Each builder is in `BUILD` in `floor.js`. Unknown types log a warning.
- `walls`, `windows`, `glass`: line segments. `outline` is the floor slab. `labels`, `tags` ("Coming soon" pills), `entrances` (arrows) and `carrel_view` (the default camera) complete the file.
- Grey items in the user's sketch are future sensor areas: the 3 other carrel blocks, the group tables, the study tables and the Bloomberg terminals. They're tagged "Coming soon". Everything else is decoration.

## Run and test

```
pip install -r requirements.txt
uvicorn main:app --port 8000          # open http://localhost:8000  (add ?demo for fake live data)
curl -X POST localhost:8000/api/report -H "X-Device-Key: dev-key-change-me" -H "Content-Type: application/json" -d '{"seat":"seat-01","state":"FREE"}'
```

- URL options: `?demo`, `?view=floor|top`, and `?seat=seat-03` (opens that carrel; good for a QR sticker on each desk).
- **Screenshots:** headless Chrome works with `--headless=new --use-angle=swiftshader --enable-unsafe-swiftshader --window-size=500,1083 --virtual-time-budget=15000 --screenshot=...`. Windows narrower than about 500 px get cropped. Use `--blink-settings=preferredColorScheme=1` for light mode.
- On this machine FastAPI is in the user site-packages, so don't run Python with `-I`.
- Deploy by committing and pushing; Render redeploys. Render's free tier sleeps after 15 min idle and its disk is ephemeral, so the history resets on each deploy.

## Status (2026-10-30)

**Done and verified in headless Chrome (light and dark):**
- The whole floor in 3D from the new plan, furniture from the photos, 4 compartments with 1 live.
- Pins with an icon for each state; a seated person, bag or empty chair as non-colour cues; a glow in the state colour.
- Header counts, legend, view buttons, "Find me a seat", toasts, demo mode, offline handling.
- The backend serves everything, and the real API was tested with fake reports.

**Not yet verified:**
- Real phones (iOS Safari, Android Chrome): touch gestures, performance, safe areas.
- Tapping a carrel and the detail sheet, the List view and the no-WebGL fallback (these need a click, which headless screenshots can't do).

## Next steps (suggested order)

1. Test on real phones; fix touch and performance issues. If it's slow, consider capping the pixel ratio at 1.5 or turning off shadows on low-end devices.
2. When the MCUs are installed, put their `SEAT_ID`s into `compartments` and switch firmware to the real timings.
3. Add a PWA manifest and icon so it can be added to the home screen. True push alerts for "watching" need a service worker; right now it only buzzes while the page is open.
4. Add a QR code poster at the Irving entrance (`/?view=carrels`) and per-carrel stickers (`/?seat=seat-0N`).
5. Clean-up: remove the MQTT leftovers in `store.py`; tighten CORS before going public; set a real `DEVICE_KEYS` on Render.
6. Busy-times chart: `/api/seats/{id}/usage` already exists. A per-hour aggregate endpoint would allow a "usually free at 3 pm" hint.
