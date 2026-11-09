"""
SeatNav data collector: keeps a copy, on this computer, of everything the
sensors report to the backend, so it can be graphed later.

Why: the backend saves every report in SQLite, but Render wipes its disk
whenever the service restarts or redeploys. This script copies new rows from
the backend every 20 s (GET /api/log). If this computer sleeps or loses Wi-Fi,
nothing is lost: the backend still has the rows and they are fetched on the
next successful poll. Data is only lost if the backend restarts while this
script is not running.

  python tools/collector.py run                         keep collecting (Ctrl+C to stop)
  python tools/collector.py status                      what has been collected, and is it healthy?
  python tools/collector.py export                      write CSV files to data/export/ for graphing
  python tools/collector.py import-snapshot DIR         load history saved before /api/log existed

Options: --server URL (default https://seatnav.onrender.com), --db PATH (default data/collected.db;
         the log and lock files sit next to it: data/collected.log, data/collected.lock)

Before the backend has /api/log (an older deploy) it falls back to the
per-seat history endpoints, which give state changes only (no heartbeats).

Uses only the Python standard library.
"""

import argparse
import csv
import datetime as dt
import json
import logging
import logging.handlers
import os
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
DEFAULT_DB = DATA_DIR / "collected.db"
DEFAULT_SERVER = "https://seatnav.onrender.com"
POLL_S = 20
PAGE = 5000
LEGACY = "legacy"            # source name for data fetched from the old history endpoints
STATES = ("FREE", "OCCUPIED", "AWAY", "OFFLINE")

log = logging.getLogger("collector")

SCHEMA = """
CREATE TABLE IF NOT EXISTS sources (
    source          TEXT PRIMARY KEY,  -- the backend database id (changes when Render restarts), or 'legacy'
    db_created      REAL,              -- when that backend database was created (server clock)
    first_ok        REAL,              -- server time of the first successful fetch
    covered_until   REAL,              -- we hold everything this source had up to this server time
    reports_cursor  INTEGER NOT NULL DEFAULT 0,
    events_cursor   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS reports (
    source    TEXT NOT NULL,
    server_id INTEGER NOT NULL,
    ts        REAL NOT NULL,           -- Unix time (server clock) the backend received the report
    seat_id   TEXT NOT NULL,
    state     TEXT,
    near      INTEGER,
    moving_cm INTEGER,
    still_cm  INTEGER,
    rssi      INTEGER,
    reason    TEXT,
    uptime_s  INTEGER,
    PRIMARY KEY (source, server_id)
);
CREATE INDEX IF NOT EXISTS idx_reports_seat_ts ON reports (seat_id, ts);

CREATE TABLE IF NOT EXISTS events (
    source    TEXT NOT NULL,
    server_id INTEGER,                 -- NULL for 'legacy' rows
    ts        REAL NOT NULL,
    seat_id   TEXT NOT NULL,
    kind      TEXT NOT NULL,           -- 'state' (FREE/OCCUPIED/AWAY) or 'status' (online/offline)
    value     TEXT NOT NULL,
    rssi      INTEGER,
    UNIQUE (source, seat_id, ts, kind, value)
);
CREATE INDEX IF NOT EXISTS idx_events_seat_ts ON events (seat_id, ts);

CREATE TABLE IF NOT EXISTS polls (
    ts          REAL NOT NULL,         -- local clock
    ok          INTEGER NOT NULL,
    mode        TEXT,                  -- 'log' or 'legacy'
    source      TEXT,
    new_reports INTEGER,
    new_events  INTEGER,
    error       TEXT
);
"""


# ---------- helpers ----------

def open_db(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")   # lets status/export read while 'run' writes
    conn.executescript(SCHEMA)
    conn.commit()
    return conn


class NotFound(Exception):
    pass


def get_json(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "seatnav-collector/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise NotFound(url) from e
        raise


def local(ts):
    return "" if ts is None else dt.datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M:%S")


def source_row(conn, source):
    return conn.execute("SELECT * FROM sources WHERE source = ?", (source,)).fetchone()


def ensure_source(conn, source, db_created=None):
    conn.execute(
        "INSERT OR IGNORE INTO sources (source, db_created) VALUES (?, ?)", (source, db_created)
    )


def mark_covered(conn, source, server_time):
    conn.execute(
        """UPDATE sources SET
               first_ok = COALESCE(first_ok, ?),
               covered_until = MAX(COALESCE(covered_until, 0), ?)
           WHERE source = ?""",
        (server_time, server_time, source),
    )


def insert_events(conn, source, events):
    before = conn.total_changes
    conn.executemany(
        """INSERT OR IGNORE INTO events (source, server_id, ts, seat_id, kind, value, rssi)
           VALUES (?, ?, ?, ?, ?, ?, ?)""",
        [(source, e.get("id"), e["ts"], e["seat_id"], e["kind"], e["value"], e.get("rssi"))
         for e in events],
    )
    return conn.total_changes - before


def insert_reports(conn, source, reports):
    before = conn.total_changes
    conn.executemany(
        """INSERT OR IGNORE INTO reports (source, server_id, ts, seat_id, state, near, moving_cm,
                                          still_cm, rssi, reason, uptime_s)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        [(source, r["id"], r["ts"], r["seat_id"], r.get("state"), r.get("near"),
          r.get("moving_cm"), r.get("still_cm"), r.get("rssi"), r.get("reason"), r.get("uptime_s"))
         for r in reports],
    )
    return conn.total_changes - before


# ---------- fetching ----------

def latest_source(conn):
    row = conn.execute(
        "SELECT source FROM sources WHERE source != ? ORDER BY first_ok DESC LIMIT 1", (LEGACY,)
    ).fetchone()
    return row["source"] if row else None


def poll_log(conn, server):
    """Fetch new rows from /api/log. Returns (source, new_reports, new_events).
    Raises NotFound if the backend doesn't have /api/log yet."""
    expected = latest_source(conn)
    new_r = new_e = 0
    switches = 0
    for _ in range(10000):                                  # pages; a safety bound, never reached
        row = source_row(conn, expected) if expected else None
        r_after = row["reports_cursor"] if row else 0
        e_after = row["events_cursor"] if row else 0
        q = urllib.parse.urlencode({"reports_after": r_after, "events_after": e_after, "limit": PAGE})
        data = get_json(f"{server}/api/log?{q}")
        source = data["db_id"]

        if source != expected:
            # A new backend database (Render restarted or redeployed): read it from the start.
            switches += 1
            if switches > 3:                                # two instances answering during a swap
                raise RuntimeError("backend database id keeps changing; will retry")
            ensure_source(conn, source, data.get("db_created"))
            conn.commit()
            log.info("backend database %s (created %s); reading it from the start",
                     source, local(data.get("db_created")))
            expected = source
            continue

        reports, events = data["reports"], data["events"]
        new_r += insert_reports(conn, source, reports)
        new_e += insert_events(conn, source, events)
        if reports:
            conn.execute("UPDATE sources SET reports_cursor = ? WHERE source = ?",
                         (max(r["id"] for r in reports), source))
        if events:
            conn.execute("UPDATE sources SET events_cursor = ? WHERE source = ?",
                         (max(e["id"] for e in events), source))
        more = data["reports_more"] or data["events_more"]
        if not more:
            mark_covered(conn, source, data["server_time"])
        conn.commit()
        if not more:
            return source, new_r, new_e
    raise RuntimeError("too many pages")


def poll_legacy(conn, server):
    """For a backend without /api/log: state changes from the per-seat history endpoints."""
    seats = get_json(f"{server}/api/seats")
    server_time = seats["server_time"]                      # taken before the history requests
    ensure_source(conn, LEGACY)
    row = source_row(conn, LEGACY)
    if row["covered_until"]:
        hours = (server_time - row["covered_until"]) / 3600 + 0.25   # 15 min overlap
        hours = min(2160.0, max(0.25, hours))
    else:
        hours = 2160.0
    new_e = 0
    for seat in seats["seats"]:
        sid = urllib.parse.quote(seat["seat_id"], safe="")
        hist = get_json(f"{server}/api/seats/{sid}/history?hours={hours:.4f}")
        events = [dict(e, seat_id=seat["seat_id"]) for e in hist["events"]]
        new_e += insert_events(conn, LEGACY, events)
    mark_covered(conn, LEGACY, server_time)
    conn.commit()
    return LEGACY, 0, new_e


# ---------- run ----------

def keep_awake():
    """Ask Windows not to sleep while this runs (doesn't keep the screen on,
    and closing the lid still sleeps). Released automatically when we exit."""
    if sys.platform == "win32":
        import ctypes
        ES_CONTINUOUS, ES_SYSTEM_REQUIRED = 0x80000000, 0x00000001
        ctypes.windll.kernel32.SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)


def single_instance(lock_path):
    """Returns an open lock file, or None if another collector already runs."""
    f = open(lock_path, "a+")
    try:
        if sys.platform == "win32":
            import msvcrt
            f.seek(0)
            msvcrt.locking(f.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def setup_logging(log_path):
    log_path.parent.mkdir(parents=True, exist_ok=True)
    handler = logging.handlers.RotatingFileHandler(
        log_path, maxBytes=2_000_000, backupCount=3, encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(handler)
    if sys.stderr is not None:                               # pythonw has no console
        log.addHandler(logging.StreamHandler())
    log.setLevel(logging.INFO)


def cmd_run(args):
    setup_logging(args.db.with_suffix(".log"))             # data/collected.log
    lock = single_instance(args.db.with_suffix(".lock"))
    if lock is None:
        log.info("another collector is already running; exiting")
        return 0
    conn = open_db(args.db)
    log.info("collector started (pid %d), server %s, database %s", os.getpid(), args.server, args.db)

    mode = None
    fail_streak, last_fail_log = 0, 0.0
    hour_r = hour_e = 0
    hour_start = time.time()
    while True:
        started = time.monotonic()
        keep_awake()
        try:
            try:
                source, nr, ne = poll_log(conn, args.server)
                new_mode = "log"
            except NotFound:
                source, nr, ne = poll_legacy(conn, args.server)
                new_mode = "legacy"
            if new_mode != mode:
                log.info("mode: %s", "GET /api/log (every report)" if new_mode == "log"
                         else "legacy history endpoints (state changes only; backend not updated yet)")
                mode = new_mode
            if fail_streak:
                log.info("working again after %d failed polls", fail_streak)
                fail_streak = 0
            hour_r += nr
            hour_e += ne
            conn.execute("INSERT INTO polls (ts, ok, mode, source, new_reports, new_events) "
                         "VALUES (?, 1, ?, ?, ?, ?)", (time.time(), mode, source, nr, ne))
            conn.commit()
        except KeyboardInterrupt:
            log.info("stopped")
            return 0
        except Exception as e:  # network down, Render restarting, laptop waking up, ...
            try:
                conn.rollback()
            except Exception:
                pass
            fail_streak += 1
            msg = f"{type(e).__name__}: {e}"[:300]
            if fail_streak == 1 or time.time() - last_fail_log > 600:
                log.warning("poll failed (%d in a row): %s", fail_streak, msg)
                last_fail_log = time.time()
            try:
                conn.execute("INSERT INTO polls (ts, ok, mode, error) VALUES (?, 0, ?, ?)",
                             (time.time(), mode, msg))
                conn.commit()
            except Exception:
                pass

        if time.time() - hour_start >= 3600:
            log.info("last hour: %d new reports, %d new events", hour_r, hour_e)
            hour_r = hour_e = 0
            hour_start = time.time()

        try:
            time.sleep(max(1.0, POLL_S - (time.monotonic() - started)))
        except KeyboardInterrupt:
            log.info("stopped")
            return 0


# ---------- status ----------

def cmd_status(args):
    conn = open_db(args.db)
    now = time.time()
    print(f"Database: {args.db}")
    last_ok = conn.execute("SELECT * FROM polls WHERE ok = 1 ORDER BY ts DESC LIMIT 1").fetchone()
    last_any = conn.execute("SELECT * FROM polls ORDER BY ts DESC LIMIT 1").fetchone()
    if last_ok:
        print(f"Last successful poll: {local(last_ok['ts'])} ({int(now - last_ok['ts'])} s ago), "
              f"mode {last_ok['mode']}")
    else:
        print("No successful poll yet.")
    if last_any and not last_any["ok"]:
        print(f"Latest poll FAILED at {local(last_any['ts'])}: {last_any['error']}")
    fails = conn.execute("SELECT COUNT(*) FROM polls WHERE ok = 0 AND ts > ?", (now - 3600,)).fetchone()[0]
    oks = conn.execute("SELECT COUNT(*) FROM polls WHERE ok = 1 AND ts > ?", (now - 3600,)).fetchone()[0]
    print(f"Polls in the last hour: {oks} ok, {fails} failed")

    print("\nBackend databases (a new one appears each time Render restarts):")
    for s in conn.execute("SELECT * FROM sources ORDER BY first_ok"):
        print(f"  {s['source']:<18} created {local(s['db_created']) or '?':<19}  "
              f"have everything up to {local(s['covered_until']) or 'nothing yet'}")

    print("\nPer seat:")
    print(f"  {'seat':<10}{'reports':>9}{'events':>8}  {'first data':<20}{'last event':<20}value")
    seats = [r[0] for r in conn.execute(
        "SELECT seat_id FROM events UNION SELECT seat_id FROM reports ORDER BY 1")]
    for seat in seats:
        nr = conn.execute("SELECT COUNT(*) FROM reports WHERE seat_id = ?", (seat,)).fetchone()[0]
        ne = conn.execute("SELECT COUNT(*) FROM events WHERE seat_id = ?", (seat,)).fetchone()[0]
        first = conn.execute(
            "SELECT MIN(ts) FROM (SELECT ts FROM events WHERE seat_id = ? "
            "UNION ALL SELECT ts FROM reports WHERE seat_id = ?)", (seat, seat)).fetchone()[0]
        last = conn.execute("SELECT ts, value FROM events WHERE seat_id = ? ORDER BY ts DESC LIMIT 1",
                            (seat,)).fetchone()
        print(f"  {seat:<10}{nr:>9}{ne:>8}  {local(first):<20}{local(last['ts']) if last else '':<20}"
              f"{last['value'] if last else ''}")
    return 0


# ---------- export ----------

def build_intervals(conn):
    """Per seat, contiguous stretches of one state: FREE / OCCUPIED / AWAY / OFFLINE,
    plus NO_DATA where the backend restarted and we can't know what happened.
    Each stretch ends at the latest time we have complete data for."""
    sources = [r for r in conn.execute(
        """SELECT s.source, s.covered_until, MIN(e.ts) AS start
           FROM sources s JOIN events e ON e.source = s.source
           GROUP BY s.source ORDER BY start""")]
    seats = [r[0] for r in conn.execute("SELECT DISTINCT seat_id FROM events ORDER BY 1")]
    out = []
    for seat in seats:
        segs = []                      # [state, start, end]
        prev_end = None
        for src in sources:
            evs = conn.execute(
                """SELECT ts, kind, value FROM events WHERE seat_id = ? AND source = ?
                   ORDER BY ts, CASE kind WHEN 'status' THEN 0 ELSE 1 END""",
                (seat, src["source"])).fetchall()
            if not evs:
                continue
            first = evs[0]["ts"]
            # Sources may overlap by a few seconds while Render swaps instances.
            while segs and segs[-1][1] >= first:
                segs.pop()
            if segs and segs[-1][2] > first:
                segs[-1][2] = first
            if prev_end is not None and first > prev_end:
                segs.append(["NO_DATA", prev_end, first])
            cur, start, known = None, None, None
            for e in evs:
                if e["kind"] == "state":
                    known = new = e["value"]
                elif e["value"] == "offline":
                    new = "OFFLINE"
                else:
                    new = known or "NO_DATA"          # back online: same state as before
                if new != cur:
                    if cur is not None and e["ts"] > start:
                        segs.append([cur, start, e["ts"]])
                    cur, start = new, e["ts"]
            end = max(src["covered_until"] or evs[-1]["ts"], evs[-1]["ts"])
            if end > start:
                segs.append([cur, start, end])
            prev_end = end
        # merge neighbours with the same state (e.g. across a backend restart)
        merged = []
        for s in segs:
            if merged and merged[-1][0] == s[0] and abs(merged[-1][2] - s[1]) < 1e-6:
                merged[-1][2] = s[2]
            else:
                merged.append(list(s))
        out += [(seat, *s) for s in merged]
    return out


def hourly(intervals):
    """Seconds per state for each seat and local clock hour."""
    table = {}
    for seat, state, start, end in intervals:
        t = start
        while t < end:
            hour = dt.datetime.fromtimestamp(t).replace(minute=0, second=0, microsecond=0)
            nxt = (hour + dt.timedelta(hours=1)).timestamp()
            stop = min(end, nxt)
            row = table.setdefault((hour, seat), {s: 0.0 for s in (*STATES, "NO_DATA")})
            row[state] += stop - t
            t = stop
    return table


def cmd_export(args):
    conn = open_db(args.db)
    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    with open(out / "reports.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["time_local", "ts", "seat_id", "state", "near", "moving_cm", "still_cm",
                    "rssi", "reason", "uptime_s", "source"])
        n_reports = 0
        for r in conn.execute("SELECT * FROM reports ORDER BY ts"):
            w.writerow([local(r["ts"]), f"{r['ts']:.3f}", r["seat_id"], r["state"], r["near"],
                        r["moving_cm"], r["still_cm"], r["rssi"], r["reason"], r["uptime_s"], r["source"]])
            n_reports += 1

    with open(out / "events.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["time_local", "ts", "seat_id", "kind", "value", "rssi", "source"])
        n_events = 0
        # the same event can be stored under two sources during a Render swap; keep one
        for r in conn.execute(
                """SELECT ts, seat_id, kind, value, MAX(rssi) AS rssi, MIN(source) AS source
                   FROM events GROUP BY seat_id, ts, kind, value ORDER BY ts"""):
            w.writerow([local(r["ts"]), f"{r['ts']:.3f}", r["seat_id"], r["kind"], r["value"],
                        r["rssi"], r["source"]])
            n_events += 1

    intervals = build_intervals(conn)
    with open(out / "intervals.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["seat_id", "state", "start_local", "end_local", "start_ts", "end_ts", "duration_s"])
        for seat, state, start, end in intervals:
            w.writerow([seat, state, local(start), local(end), f"{start:.3f}", f"{end:.3f}",
                        f"{end - start:.1f}"])

    with open(out / "hourly.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["hour_local", "seat_id", "FREE_s", "OCCUPIED_s", "AWAY_s", "OFFLINE_s",
                    "NO_DATA_s", "taken_pct"])
        for (hour, seat), s in sorted(hourly(intervals).items()):
            known = s["FREE"] + s["OCCUPIED"] + s["AWAY"]
            taken = f"{100 * (s['OCCUPIED'] + s['AWAY']) / known:.1f}" if known else ""
            w.writerow([hour.strftime("%Y-%m-%d %H:00"), seat, *(f"{s[k]:.0f}" for k in
                        ("FREE", "OCCUPIED", "AWAY", "OFFLINE", "NO_DATA")), taken])

    print(f"Wrote to {out}:")
    print(f"  reports.csv    {n_reports} raw reports (every heartbeat and change)")
    print(f"  events.csv     {n_events} state changes and online/offline events")
    print(f"  intervals.csv  {len(intervals)} stretches of one state per seat (for timelines)")
    print("  hourly.csv     seconds in each state per seat per hour; taken_pct = (OCCUPIED+AWAY) / known time")
    return 0


# ---------- import ----------

def cmd_import_snapshot(args):
    """Load history-<seat>.json + seats.json files saved from the old endpoints with curl."""
    conn = open_db(args.db)
    d = Path(args.dir)
    seats = json.loads((d / "seats.json").read_text(encoding="utf-8"))
    ensure_source(conn, LEGACY)
    total = 0
    for f in sorted(d.glob("history-*.json")):
        hist = json.loads(f.read_text(encoding="utf-8"))
        events = [dict(e, seat_id=hist["seat_id"]) for e in hist["events"]]
        total += insert_events(conn, LEGACY, events)
    # seats.json was saved last, so the history files cover up to (just under) its server_time;
    # the first legacy poll overlaps by 15 min anyway.
    mark_covered(conn, LEGACY, seats["server_time"] - 60)
    conn.commit()
    print(f"Imported {total} new events from {d}")
    return 0


def main():
    p = argparse.ArgumentParser(description="Collect SeatNav sensor data for graphs.")
    p.add_argument("--server", default=os.getenv("SEATNAV_SERVER", DEFAULT_SERVER))
    p.add_argument("--db", type=Path, default=DEFAULT_DB)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("run")
    sub.add_parser("status")
    e = sub.add_parser("export")
    e.add_argument("--out", type=Path, default=DATA_DIR / "export")
    i = sub.add_parser("import-snapshot")
    i.add_argument("dir")
    args = p.parse_args()
    args.server = args.server.rstrip("/")
    return {"run": cmd_run, "status": cmd_status, "export": cmd_export,
            "import-snapshot": cmd_import_snapshot}[args.cmd](args)


if __name__ == "__main__":
    sys.exit(main())
