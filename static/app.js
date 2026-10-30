/*
  SeatNav live floor map: loads the floor layout and the live seat data, and drives
  the summary, the list, the seat detail sheet and (once loaded) the 3D view in floor.js.

  Data comes from the backend:
    GET /api/seats + WS /ws               live state of every sensor
    GET /api/seats/{id}/usage, /history   the detail sheet
  Add ?demo to the URL to see the map with made-up data (nothing is sent to the server).
*/

const LAYOUT_URL = '/static/layout/feldberg-1.json';
const DEMO = new URLSearchParams(location.search).has('demo');

const LABEL = { FREE: 'Free', OCCUPIED: 'Occupied', AWAY: 'Away', OFFLINE: 'Sensor offline', INACTIVE: 'Not monitored yet' };
const ORDER = { FREE: 0, AWAY: 1, OCCUPIED: 2, OFFLINE: 3, INACTIVE: 4 };   // list order: free seats first
const ICONS = {
  FREE: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  OCCUPIED: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.5" r="4" fill="currentColor"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0z" fill="currentColor"/></svg>',
  AWAY: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  OFFLINE: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>',
  INACTIVE: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
};

let layout = null;
let carrels = [];               // [{ seatId, inactive }] in layout order
const seats = new Map();        // seat_id -> latest seat from the backend
let clockOffset = 0;            // server time minus this device's time (s)
let floor = null;               // the 3D view, once floor.js has loaded
let selectedId = null;

const $ = (id) => document.getElementById(id);
const serverNow = () => Date.now() / 1000 + clockOffset;

// ---------- helpers ----------

function seatName(id) {
  const m = /^seat-0*(\d+)$/.exec(id);
  return m ? 'Seat ' + m[1] : id;
}

function duration(seconds) {
  if (seconds == null || seconds < 0) return '';
  if (seconds < 60) return 'under a minute';
  const m = Math.floor(seconds / 60);
  if (m < 60) return m + ' min';
  return Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}

function clockTime(ts) {
  const d = new Date(ts * 1000);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function stateOf(c) {
  if (c.inactive) return 'INACTIVE';
  const seat = seats.get(c.seatId);
  return seat ? seat.display_state : 'OFFLINE';
}

function sinceText(c, state) {
  const seat = seats.get(c.seatId);
  if (state === 'INACTIVE') return 'No sensor installed yet';
  if (!seat) return 'No data from this sensor yet';
  if (state === 'OFFLINE') return seat.last_seen ? 'Last heard ' + duration(serverNow() - seat.last_seen) + ' ago' : 'No recent data';
  if (!seat.state_since) return '';
  const held = serverNow() - seat.state_since;
  if (state === 'AWAY') {
    // the sensor frees an AWAY seat after away_timeout_min (15 min in the real firmware timings)
    const left = layout.away_timeout_min * 60 - held;
    return 'Away ' + duration(held) + (left > 60 ? ' · frees up in ≤ ' + Math.ceil(left / 60) + ' min' : ' · may free up any moment');
  }
  return 'For ' + duration(held);
}

function badge(state) {
  return '<span class="badge" data-state="' + state + '">' + ICONS[state] + '</span>';
}

// ---------- rendering ----------

function render() {
  const active = carrels.filter((c) => !c.inactive);
  const count = { FREE: 0, OCCUPIED: 0, AWAY: 0, OFFLINE: 0 };
  active.forEach((c) => count[stateOf(c)]++);
  const reporting = active.length - count.OFFLINE;

  $('freeCount').textContent = reporting ? count.FREE : '–';
  $('freeText').textContent = reporting ? (count.FREE === 1 ? 'carrel free' : 'carrels free') : 'waiting for sensors';
  $('tally').textContent = [count.OCCUPIED + ' occupied', count.AWAY + ' away', count.OFFLINE ? count.OFFLINE + ' offline' : '']
    .filter(Boolean).join(' · ');

  renderList();
  if (floor) floor.setStates(new Map(carrels.map((c) => [c.seatId, stateOf(c)])));
  if (selectedId) renderSheetHeader();
}

function renderList() {
  const rows = carrels.filter((c) => !c.inactive)
    .map((c) => ({ c, state: stateOf(c) }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.c.seatId.localeCompare(b.c.seatId, undefined, { numeric: true }));
  const ul = $('listItems');
  ul.textContent = '';
  for (const { c, state } of rows) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'row';
    btn.dataset.state = state;
    btn.innerHTML = badge(state) + '<span class="row-main"><b></b><span class="row-sub"></span></span><span class="row-state"></span>';
    btn.querySelector('b').textContent = seatName(c.seatId);
    btn.querySelector('.row-sub').textContent = sinceText(c, state);
    btn.querySelector('.row-state').textContent = LABEL[state];
    btn.addEventListener('click', () => select(c.seatId));
    li.appendChild(btn);
    ul.appendChild(li);
  }

  const notes = [];
  const ghosts = carrels.filter((c) => c.inactive);
  if (ghosts.length) notes.push(ghosts.length + ' more carrels (' + ghosts.map((c) => seatName(c.seatId).replace('Seat ', '')).join(', ') + ') are not monitored yet.');
  const placed = new Set(carrels.map((c) => c.seatId));
  const unplaced = [...seats.keys()].filter((id) => !placed.has(id));
  if (unplaced.length) notes.push('Also reporting, but not on the map yet: ' + unplaced.join(', ') + '. Add them to the layout file.');
  $('listNote').textContent = notes.join(' ');
}

function decoratePin(pin, { seatId, state, selected }) {
  state = state || 'OFFLINE';
  const key = state + (selected ? '+' : '');
  if (pin.dataset.key !== key) {
    pin.dataset.key = key;
    pin.dataset.state = state;
    pin.classList.toggle('selected', selected);
    pin.innerHTML = ICONS[state] + '<span>' + seatName(seatId).replace('Seat ', '') + '</span>';
    pin.setAttribute('aria-label', seatName(seatId) + ': ' + LABEL[state]);
  }
}

// ---------- detail sheet ----------

function renderSheetHeader() {
  const c = carrels.find((x) => x.seatId === selectedId);
  if (!c) return;
  const state = stateOf(c);
  $('sheetTitle').textContent = seatName(c.seatId);
  const chip = $('sheetState');
  chip.dataset.state = state;
  chip.innerHTML = ICONS[state] + '<span></span>';
  chip.querySelector('span').textContent = LABEL[state];
  $('sheetSince').textContent = sinceText(c, state);
}

async function select(seatId) {
  selectedId = seatId;
  if (floor) floor.select(seatId);
  const sheet = $('sheet');
  if (!seatId) {
    sheet.hidden = true;
    return;
  }
  if (floor) setListOpen(false);    // show the map behind the sheet
  sheet.hidden = false;
  renderSheetHeader();

  const body = $('sheetBody');
  const c = carrels.find((x) => x.seatId === seatId);
  if (!c || c.inactive) {
    body.innerHTML = '<p class="muted">This carrel doesn\'t have a sensor yet, so SeatNav can\'t tell whether it\'s free. It will light up here once one is installed.</p>';
    return;
  }
  body.innerHTML = '<p class="muted">Loading the last 24 hours…</p>';
  try {
    const base = '/api/seats/' + encodeURIComponent(seatId);
    const [usage, history] = DEMO ? demoDetails(seatId) : await Promise.all([
      fetch(base + '/usage?hours=24').then((r) => r.json()),
      fetch(base + '/history?hours=24').then((r) => r.json()),
    ]);
    if (selectedId === seatId) renderDetails(usage, history);
  } catch (e) {
    if (selectedId === seatId) body.innerHTML = '<p class="muted">Couldn\'t load this seat\'s history (' + e.message + ').</p>';
  }
}

function renderDetails(usage, history) {
  const body = $('sheetBody');
  const known = usage.percent.OCCUPIED + usage.percent.AWAY + usage.percent.FREE;
  const bar = ['OCCUPIED', 'AWAY', 'FREE'].filter((k) => usage.percent[k] > 0)
    .map((k) => '<span data-state="' + k + '" style="flex:' + usage.percent[k] + '"></span>').join('');
  const changes = (history.events || []).filter((e) => e.kind === 'state').slice(-6).reverse();
  body.innerHTML =
    '<h3>Last 24 hours</h3>' +
    (known ? '<div class="bar">' + bar + '</div><p class="muted">Occupied ' + usage.percent.OCCUPIED + '% · away ' +
      usage.percent.AWAY + '% · free ' + usage.percent.FREE + '%</p>' : '<p class="muted">No data yet.</p>') +
    '<h3>Recent changes</h3>' +
    (changes.length
      ? '<ul class="changes">' + changes.map((e) => '<li><time>' + clockTime(e.ts) + '</time>' + badge(e.value) + LABEL[e.value] + '</li>').join('') + '</ul>'
      : '<p class="muted">No changes in the last 24 hours.</p>');
}

// ---------- live data ----------

function setConn(text, ok) {
  $('conn').textContent = text;
  $('conn').classList.toggle('ok', ok);
}

function applySnapshot(data) {
  clockOffset = data.server_time - Date.now() / 1000;
  seats.clear();
  data.seats.forEach((s) => seats.set(s.seat_id, s));
  render();
}

function announce(seat) {
  const c = carrels.find((x) => x.seatId === seat.seat_id);
  if (c && !c.inactive) $('announce').textContent = seatName(seat.seat_id) + ' is now ' + LABEL[seat.display_state].toLowerCase();
}

// ---------- "Find me a seat", watching, and toasts ----------

let watching = false;     // the user asked to be told when a carrel frees up
let toastTimer = null;

function toast(text, seatId = null) {
  const el = $('toast');
  el.textContent = text;
  el.dataset.seat = seatId || '';
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
}

function seatChanged(before, seat) {
  announce(seat);
  const c = carrels.find((x) => x.seatId === seat.seat_id);
  if (!before || !c || c.inactive || seat.display_state !== 'FREE') return;
  toast(seatName(seat.seat_id) + ' just freed up. Tap to see it.', seat.seat_id);
  if (watching) {
    watching = false;
    $('findBtn').textContent = 'Find me a seat';
    if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
  }
}

function findSeat() {
  const free = carrels.filter((c) => !c.inactive && stateOf(c) === 'FREE');
  if (free.length) {
    select(free[0].seatId);
    return;
  }
  watching = !watching;
  $('findBtn').textContent = watching ? 'Watching…' : 'Find me a seat';
  toast(watching ? 'No free carrels right now. Keep this page open and it will buzz when one frees up.' : 'Stopped watching.');
}

async function refresh() {
  try {
    const res = await fetch('/api/seats');
    if (!res.ok) throw new Error('the server answered ' + res.status);
    applySnapshot(await res.json());
  } catch (e) {
    setConn('Server unreachable', false);
  }
}

function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  ws.onopen = () => setConn('Live', true);
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'snapshot') applySnapshot(msg);
    if (msg.type === 'seat') {
      const before = seats.get(msg.seat.seat_id);
      seats.set(msg.seat.seat_id, msg.seat);
      if (!before || before.display_state !== msg.seat.display_state) seatChanged(before, msg.seat);
      render();
    }
  };
  ws.onclose = () => {
    setConn('Reconnecting…', false);
    setTimeout(connect, 3000);
  };
}

// ---------- demo mode (?demo): made-up data, nothing sent to the server ----------

function demoSeat(id, state, since) {
  return { seat_id: id, state, display_state: state, live: true, rssi: -60, last_seen: Date.now() / 1000, state_since: since };
}

function startDemo() {
  setConn('Demo data', true);
  const ids = carrels.filter((c) => !c.inactive).map((c) => c.seatId);
  const start = ['FREE', 'OCCUPIED', 'AWAY', 'OCCUPIED', 'FREE', 'OCCUPIED'];
  ids.forEach((id, i) => seats.set(id, demoSeat(id, start[i % start.length], Date.now() / 1000 - 120 - i * 340)));
  render();
  const next = { FREE: 'OCCUPIED', OCCUPIED: 'AWAY', AWAY: 'FREE' };
  setInterval(() => {
    const id = ids[Math.floor(Math.random() * ids.length)];
    const before = seats.get(id);
    seats.set(id, demoSeat(id, next[before.display_state] || 'FREE', Date.now() / 1000));
    seatChanged(before, seats.get(id));
    render();
  }, 4000);
}

function demoDetails(seatId) {
  const occupied = 35 + (parseInt(seatId.replace(/\D/g, ''), 10) % 5) * 8;
  const now = Date.now() / 1000;
  return [
    { percent: { OCCUPIED: occupied, AWAY: 9, FREE: 100 - occupied - 9 } },
    { events: [['OCCUPIED', 5400], ['AWAY', 3100], ['OCCUPIED', 2700], ['FREE', 900]].map(([value, ago]) => ({ kind: 'state', value, ts: now - ago })) },
  ];
}

// ---------- page ----------

function setListOpen(open) {
  document.body.classList.toggle('list-open', open);
  $('listBtn').setAttribute('aria-pressed', String(open));
}

function wireUi() {
  $('legend').innerHTML = ['FREE', 'OCCUPIED', 'AWAY', 'OFFLINE', 'INACTIVE']
    .map((s) => '<li data-state="' + s + '">' + badge(s) + LABEL[s] + '</li>').join('');
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    setListOpen(false);
    document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
    if (floor) floor.setView(button.dataset.view);
  }));
  $('listBtn').addEventListener('click', () => setListOpen(!document.body.classList.contains('list-open')));
  $('sheetClose').addEventListener('click', () => select(null));
  $('findBtn').addEventListener('click', findSeat);
  $('toast').addEventListener('click', () => {
    if ($('toast').dataset.seat) select($('toast').dataset.seat);
    $('toast').hidden = true;
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') select(null); });
}

async function startFloor() {
  try {
    const { createFloor } = await import('/static/floor.js');
    floor = createFloor($('scene'), layout, { onSelect: select, decoratePin });
    render();
    // ?view=floor or ?view=top opens a different preset (handy for a QR code at the entrance)
    const start = new URLSearchParams(location.search).get('view');
    const button = start && document.querySelector('[data-view="' + CSS.escape(start) + '"]');
    if (button) {
      document.querySelectorAll('[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
      floor.setView(start, true);
    }
  } catch (err) {
    console.error('3D view unavailable:', err);
    document.body.classList.add('no-3d');
    $('fallbackNote').hidden = false;
    setListOpen(true);
  }
  // ?seat=seat-03 opens that carrel straight away (e.g. from a QR sticker on the desk)
  const deepLink = new URLSearchParams(location.search).get('seat');
  if (deepLink && carrels.some((c) => c.seatId === deepLink)) select(deepLink);
}

async function main() {
  wireUi();
  try {
    layout = await (await fetch(LAYOUT_URL)).json();
  } catch (e) {
    $('freeText').textContent = 'couldn\'t load the floor layout';
    return;
  }
  $('floorName').textContent = layout.name;
  carrels = layout.compartments.flatMap((comp) =>
    comp.seats.flat().filter(Boolean).map((seatId) => ({ seatId, inactive: !!comp.inactive })));
  render();
  if (DEMO) startDemo();
  else {
    refresh();
    connect();
  }
  startFloor();
  setInterval(render, 15000);      // keeps "for X min" and the away countdown current
}

main();
