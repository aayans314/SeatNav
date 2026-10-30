/*
  SeatNav web app: picks a place, loads its floor layout and the live seat data, and
  drives the header, the list, the seat sheet, the place picker and (once loaded) the
  3D view in floor.js.

  Data:
    static/places.json                    places in the picker; open ones point at a layout file
    GET /api/seats + WS /ws               live state of every sensor (each place only shows its own seats)
    GET /api/seats/{id}/usage, /history   the seat sheet
  URL options: ?place=<id>  ?view=floor|top  ?seat=<seat id>  ?list  ?demo (made-up data, nothing sent)

  Wording is for students: short, no sensor jargon. A layout with "testing": true
  (the sensor test bench) also shows raw sensor details for debugging.
*/

const params = new URLSearchParams(location.search);
const DEMO = params.has('demo');
const PLACE_KEY = 'seatnav.place';

const LABEL = { FREE: 'Free', OCCUPIED: 'Taken', AWAY: 'Away', OFFLINE: 'Unavailable', INACTIVE: 'Coming soon' };
const ORDER = { FREE: 0, AWAY: 1, OCCUPIED: 2, OFFLINE: 3, INACTIVE: 4 };   // free seats first
const ICONS = {
  FREE: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.2 4.2L19 7" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  OCCUPIED: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="7.5" r="4" fill="currentColor"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0z" fill="currentColor"/></svg>',
  AWAY: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M12 7.5V12l3 2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  OFFLINE: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v9" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>',
  INACTIVE: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 12h12" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>',
};

let places = null;              // places.json
let place = null;               // the place being shown
let layout = null;
let testing = false;            // test bench: show raw sensor details
let seatList = [];              // [{ seatId, inactive }] of this place, in layout order
const seats = new Map();        // seat_id -> latest seat from the backend
let clockOffset = 0;            // server time minus this device's time (s)
let floor = null;               // the 3D view, once floor.js has loaded
let selectedId = null;

const $ = (id) => document.getElementById(id);
const serverNow = () => Date.now() / 1000 + clockOffset;

// ---------- wording ----------

function seatName(id) {
  if (layout.seat_names && layout.seat_names[id]) return layout.seat_names[id];
  const m = /^seat-0*(\d+)$/.exec(id);
  return m ? 'Seat ' + m[1] : id;
}

function pinText(id) {
  const m = /^seat-0*(\d+)$/.exec(id);
  return m ? m[1] : seatName(id).charAt(0).toUpperCase();
}

function minutes(seconds) {
  const m = Math.floor(seconds / 60);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min';
}

function ago(ts) {
  if (!ts) return 'never';
  const s = Math.max(0, Math.round(serverNow() - ts));
  return s < 60 ? s + ' s ago' : minutes(s) + ' ago';
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

// one short line under a seat's state; raw sensor details on the test bench only
function detail(c, state) {
  const seat = seats.get(c.seatId);
  if (testing && !c.inactive) {
    if (!seat) return 'No data from this sensor yet';
    const bits = ['Last heard ' + ago(seat.last_seen)];
    if (seat.rssi != null) bits.push(seat.rssi + ' dBm');
    if (seat.near != null) bits.push(seat.near ? 'someone near' : 'nobody near');
    return bits.join(' · ');
  }
  if (!seat || !seat.state_since || (state !== 'FREE' && state !== 'OCCUPIED' && state !== 'AWAY')) return '';
  const held = serverNow() - seat.state_since;
  if (state === 'AWAY') {
    // the sensor frees an away seat after away_timeout_min
    const left = layout.away_timeout_min * 60 - held;
    return left > 60 ? 'Frees in ≤ ' + Math.ceil(left / 60) + ' min' : 'May free up soon';
  }
  return held < 60 ? 'Just now' : 'For ' + minutes(held);
}

function badge(state) {
  return '<span class="badge" data-state="' + state + '">' + ICONS[state] + '</span>';
}

function counts() {
  const n = { FREE: 0, OCCUPIED: 0, AWAY: 0, OFFLINE: 0 };
  seatList.filter((c) => !c.inactive).forEach((c) => n[stateOf(c)]++);
  return n;
}

// ---------- rendering ----------

function render() {
  const n = counts();
  const reporting = n.FREE + n.OCCUPIED + n.AWAY;
  $('freeCount').textContent = reporting ? n.FREE : '–';
  $('freeText').textContent = !reporting ? 'No live data' : n.FREE === 1 ? 'seat free' : 'seats free';
  $('tally').textContent = reporting
    ? [n.OCCUPIED ? n.OCCUPIED + ' taken' : '', n.AWAY ? n.AWAY + ' away' : ''].filter(Boolean).join(' · ') || 'Everything is free'
    : '';
  renderList(n);
  if (floor) floor.setStates(new Map(seatList.map((c) => [c.seatId, stateOf(c)])));
  if (selectedId) renderSheetHeader();
}

function renderList(n) {
  const live = seatList.filter((c) => !c.inactive);
  const total = live.length || 1;
  $('listSummary').innerHTML =
    '<div class="bar">' + ['FREE', 'AWAY', 'OCCUPIED', 'OFFLINE'].filter((k) => n[k])
      .map((k) => '<span data-state="' + k + '" style="flex:' + n[k] / total + '"></span>').join('') + '</div>' +
    '<p>' + ['FREE', 'OCCUPIED', 'AWAY', 'OFFLINE'].filter((k) => n[k]).map((k) => n[k] + ' ' + LABEL[k].toLowerCase()).join(' · ') + '</p>';

  const ul = $('listItems');
  ul.textContent = '';
  live.map((c) => ({ c, state: stateOf(c) }))
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || a.c.seatId.localeCompare(b.c.seatId, undefined, { numeric: true }))
    .forEach(({ c, state }) => {
      const li = document.createElement('li');
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'tile';
      tile.dataset.state = state;
      tile.innerHTML = '<span class="tile-num"></span><span class="tile-state">' + badge(state) + LABEL[state] + '</span><span class="tile-sub"></span>';
      tile.querySelector('.tile-num').textContent = seatName(c.seatId);
      tile.querySelector('.tile-sub').textContent = detail(c, state);
      tile.setAttribute('aria-label', seatName(c.seatId) + ', ' + LABEL[state]);
      tile.addEventListener('click', () => select(c.seatId));
      li.appendChild(tile);
      ul.appendChild(li);
    });

  const soon = seatList.length - live.length;
  $('listSoon').hidden = !soon;
  $('listSoon').innerHTML = badge('INACTIVE') + '<span><b>' + soon + ' more seats</b> coming soon</span>';

  // test bench only: other sensors the backend hears from, to catch a mistyped SEAT_ID
  const here = new Set(seatList.map((c) => c.seatId));
  const others = [...seats.keys()].filter((id) => !here.has(id));
  $('listDebug').hidden = !testing || !others.length;
  $('listDebug').textContent = 'Other sensors reporting: ' + others.join(', ');
}

function decoratePin(pin, { seatId, state, selected }) {
  state = state || 'OFFLINE';
  const key = state + (selected ? '+' : '');
  if (pin.dataset.key === key) return;
  pin.dataset.key = key;
  pin.dataset.state = state;
  pin.classList.toggle('selected', selected);
  pin.innerHTML = ICONS[state] + '<span>' + pinText(seatId) + '</span>';
  pin.setAttribute('aria-label', seatName(seatId) + ': ' + LABEL[state]);
}

// ---------- seat sheet ----------

function renderSheetHeader() {
  const c = seatList.find((x) => x.seatId === selectedId);
  if (!c) return;
  const state = stateOf(c);
  $('sheetTitle').textContent = seatName(c.seatId);
  const chip = $('sheetState');
  chip.dataset.state = state;
  chip.innerHTML = ICONS[state] + '<span></span>';
  chip.querySelector('span').textContent = LABEL[state];
  $('sheetSince').textContent = detail(c, state);
}

async function select(seatId) {
  selectedId = seatId;
  if (floor) floor.select(seatId);
  const sheet = $('sheet');
  if (!seatId) {
    sheet.hidden = true;
    return;
  }
  if (floor) setListOpen(false);   // show the map behind the sheet
  sheet.hidden = false;
  renderSheetHeader();

  const body = $('sheetBody');
  const c = seatList.find((x) => x.seatId === seatId);
  if (!c || c.inactive) {
    body.innerHTML = '<p class="muted">Live status for this seat is coming soon.</p>';
    return;
  }
  body.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const base = '/api/seats/' + encodeURIComponent(seatId);
    const [usage, history] = DEMO ? demoDetails(seatId) : await Promise.all([
      fetch(base + '/usage?hours=24').then((r) => r.json()),
      fetch(base + '/history?hours=24').then((r) => r.json()),
    ]);
    if (selectedId === seatId) renderDetails(seatId, usage, history);
  } catch (e) {
    if (selectedId === seatId) body.innerHTML = '<p class="muted">History isn\'t available right now.</p>';
  }
}

function renderDetails(seatId, usage, history) {
  const p = usage.percent || {};
  const known = (p.OCCUPIED || 0) + (p.AWAY || 0) + (p.FREE || 0);
  const bar = ['OCCUPIED', 'AWAY', 'FREE'].filter((k) => p[k] > 0)
    .map((k) => '<span data-state="' + k + '" style="flex:' + p[k] + '"></span>').join('');
  const changes = (history.events || []).filter((e) => e.kind === 'state').slice(-6).reverse();
  let html =
    '<h3>Last 24 hours</h3>' +
    (known ? '<div class="bar">' + bar + '</div><p class="muted">Taken ' + p.OCCUPIED + '% · away ' + p.AWAY + '% · free ' + p.FREE + '%</p>'
      : '<p class="muted">No history yet.</p>') +
    '<h3>Recent changes</h3>' +
    (changes.length
      ? '<ul class="changes">' + changes.map((e) => '<li><time>' + clockTime(e.ts) + '</time>' + badge(e.value) + LABEL[e.value] + '</li>').join('') + '</ul>'
      : '<p class="muted">No changes today.</p>');

  const seat = seats.get(seatId);
  if (testing && seat) {
    const rows = [
      ['Sensor ID', seat.seat_id], ['Last heard', ago(seat.last_seen)], ['Signal', seat.rssi != null ? seat.rssi + ' dBm' : '–'],
      ['Someone near', seat.near == null ? '–' : seat.near ? 'yes' : 'no'],
      ['Moving target', seat.moving_cm != null ? seat.moving_cm + ' cm' : '–'], ['Still target', seat.still_cm != null ? seat.still_cm + ' cm' : '–'],
      ['State since', seat.state_since ? clockTime(seat.state_since) : '–'],
    ];
    html += '<h3>Sensor</h3><dl class="debug">' + rows.map(([k, v]) => '<dt>' + k + '</dt><dd>' + v + '</dd>').join('') + '</dl>';
  }
  $('sheetBody').innerHTML = html;
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

async function refresh() {
  try {
    const res = await fetch('/api/seats');
    if (!res.ok) throw new Error(res.status);
    applySnapshot(await res.json());
  } catch (e) {
    setConn('Offline', false);
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

// ---------- "Find a seat", watching, toasts ----------

let watching = false;     // the user asked to be told when a seat frees up
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
  const c = seatList.find((x) => x.seatId === seat.seat_id);
  if (!c || c.inactive) return;                 // not a seat of this place
  $('announce').textContent = seatName(seat.seat_id) + ' is now ' + LABEL[seat.display_state].toLowerCase();
  if (!before || seat.display_state !== 'FREE') return;
  toast(seatName(seat.seat_id) + ' is free', seat.seat_id);
  if (watching) {
    watching = false;
    $('findBtn').textContent = 'Find a seat';
    if (navigator.vibrate) navigator.vibrate([150, 80, 150]);
  }
}

function findSeat() {
  const free = seatList.filter((c) => !c.inactive && stateOf(c) === 'FREE');
  if (free.length) {
    select(free[0].seatId);
    return;
  }
  watching = !watching;
  $('findBtn').textContent = watching ? 'Watching…' : 'Find a seat';
  toast(watching ? 'Nothing free yet. We\'ll buzz you.' : 'Stopped watching');
}

// ---------- demo mode (?demo): made-up data, nothing sent to the server ----------

function demoSeat(id, state, since) {
  return { seat_id: id, state, display_state: state, live: true, rssi: -60, near: state === 'OCCUPIED', last_seen: Date.now() / 1000, state_since: since };
}

function startDemo() {
  setConn('Demo', true);
  const ids = seatList.filter((c) => !c.inactive).map((c) => c.seatId);
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
  const taken = 35 + (parseInt(seatId.replace(/\D/g, ''), 10) % 5) * 8;
  const now = Date.now() / 1000;
  return [
    { percent: { OCCUPIED: taken, AWAY: 9, FREE: 100 - taken - 9 } },
    { events: [['OCCUPIED', 5400], ['AWAY', 3100], ['OCCUPIED', 2700], ['FREE', 900]].map(([value, ago]) => ({ kind: 'state', value, ts: now - ago })) },
  ];
}

// ---------- place picker ----------

function allPlaces() {
  return places.groups.flatMap((g) => g.places);
}

function storedPlace() {
  try { return localStorage.getItem(PLACE_KEY); } catch (e) { return null; }
}

function choosePlace() {
  const open = (id) => allPlaces().find((p) => p.id === id && p.layout);
  return open(params.get('place')) || open(storedPlace()) || open(places.default);
}

function openPlace(id) {
  const target = allPlaces().find((p) => p.id === id);
  if (!target || !target.layout) return;
  if (!target.testing) {
    try { localStorage.setItem(PLACE_KEY, id); } catch (e) { /* private mode: just don't remember */ }
  }
  location.search = '?place=' + encodeURIComponent(id) + (DEMO ? '&demo' : '');
}

function renderPlaces() {
  const n = counts();
  const here = testing || !(n.FREE + n.OCCUPIED + n.AWAY) ? 'Viewing' : n.FREE + ' free';
  $('placesBody').innerHTML = places.groups.map((g) =>
    '<h3>' + g.title + '</h3><ul>' + g.places.map((p) => {
      const current = p.id === place.id;
      const pill = current ? '<span class="pill current">' + here + '</span>'
        : p.layout ? '<span class="pill live">' + (p.testing ? 'Test' : 'Live') + '</span>'
          : '<span class="pill">Soon</span>';
      return '<li><button type="button" class="place" data-place="' + p.id + '"' + (p.layout ? '' : ' disabled') + '>' +
        '<span class="place-main"><b>' + p.name + '</b><small>' + p.detail + '</small></span>' + pill + '</button></li>';
    }).join('') + '</ul>').join('');
}

function setPlacesOpen(open) {
  if (open) renderPlaces();
  $('places').hidden = !open;
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
  $('placeBtn').addEventListener('click', () => setPlacesOpen(true));
  $('placesClose').addEventListener('click', () => setPlacesOpen(false));
  $('placesBody').addEventListener('click', (e) => {
    const button = e.target.closest('[data-place]');
    if (!button || button.disabled) return;
    if (button.dataset.place === place.id) setPlacesOpen(false);
    else openPlace(button.dataset.place);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('places').hidden) setPlacesOpen(false);
    else select(null);
  });
}

async function startFloor() {
  try {
    const { createFloor } = await import('/static/floor.js');
    floor = createFloor($('scene'), layout, { onSelect: select, decoratePin });
    render();
    const start = params.get('view');
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
  // ?seat=seat-03 opens that seat straight away (e.g. from a QR sticker on the desk)
  const deepLink = params.get('seat');
  if (deepLink && seatList.some((c) => c.seatId === deepLink)) select(deepLink);
}

async function main() {
  wireUi();
  try {
    places = await (await fetch('/static/places.json')).json();
    place = choosePlace();
    layout = await (await fetch(place.layout)).json();
  } catch (e) {
    $('freeText').textContent = 'Couldn\'t load this place';
    return;
  }
  testing = !!layout.testing;
  document.body.classList.toggle('testing', testing);
  $('testBadge').hidden = !testing;
  $('placeName').textContent = place.name;
  document.title = 'SeatNav · ' + place.name;
  seatList = layout.compartments.flatMap((comp) =>
    comp.seats.flat().filter(Boolean).map((seatId) => ({ seatId, inactive: !!comp.inactive })));
  render();
  if (params.has('list')) setListOpen(true);
  if (params.has('places')) setPlacesOpen(true);
  if (DEMO) startDemo();
  else {
    refresh();
    connect();
  }
  startFloor();
  setInterval(render, testing ? 5000 : 15000);   // keeps "for X min" current; faster on the test bench
}

main();
