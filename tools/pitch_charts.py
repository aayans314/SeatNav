"""
Charts and headline numbers for the SeatNav pitch, made from the collector's export.

  python tools/collector.py export     refresh data/export/ first
  python tools/pitch_charts.py         writes docs/pitch/*.png and docs/pitch/PITCH_STATS.txt

Needs pandas and matplotlib (the backend itself doesn't).

Seats 02 and 04 are left out of the usage charts: their radars report a still
object about 30 cm away at night, when every other seat reads empty
(see chart 5). Usage numbers therefore come from seats 01, 03, 05 and 06.
"""

from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.dates as mdates
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.patches import FancyBboxPatch, PathPatch, Rectangle
from matplotlib.path import Path as MPath

ROOT = Path(__file__).resolve().parent.parent
EXPORT = ROOT / "data" / "export"
OUT = ROOT / "docs" / "pitch"
TZ = "America/New_York"

SEATS = ["seat-01", "seat-02", "seat-03", "seat-04", "seat-05", "seat-06"]
RELIABLE = ["seat-01", "seat-03", "seat-05", "seat-06"]
FLAGGED = {"seat-02": "some false detections at night",
           "seat-04": "false detections every night"}

# palette (dataviz reference palette, light mode, white slide background)
SURFACE = "#ffffff"
INK = "#0b0b0b"
INK_2 = "#52514e"
MUTED = "#898781"
GRID = "#e1e0d9"
BASELINE = "#c3c2b7"
BLUE = "#2a78d6"          # "taken" everywhere
OFFLINE = "#b5b4ad"       # sensor offline / no data (always labelled)
NIGHT = "#f4f4f1"
TILE = "#f9f9f7"
RAMP = ["#f5f9fe", "#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"]

W, H, DPI = 12, 6.75, 200   # 2400 x 1350 px, 16:9
SOURCE = "Source: SeatNav pilot, Feldberg Library (Dartmouth), Nov 7–12, 2026"

plt.rcParams.update({
    "font.family": ["Segoe UI", "DejaVu Sans"],
    "font.size": 13,
    "axes.edgecolor": BASELINE,
    "axes.labelcolor": INK_2,
    "xtick.color": INK_2,
    "ytick.color": INK_2,
    "xtick.labelsize": 13,
    "ytick.labelsize": 13,
    "axes.spines.top": False,
    "axes.spines.right": False,
})


# ---------- data ----------

def load():
    iv = pd.read_csv(EXPORT / "intervals.csv")
    iv = iv[iv.seat_id.isin(SEATS)].copy()
    hr = pd.read_csv(EXPORT / "hourly.csv")
    hr = hr[hr.seat_id.isin(SEATS)].copy()
    hr["hour"] = pd.to_datetime(hr.hour_local)
    hr["taken"] = hr.OCCUPIED_s + hr.AWAY_s
    hr["known"] = hr.FREE_s + hr.taken
    rp = pd.read_csv(EXPORT / "reports.csv")
    rp["t"] = pd.to_datetime(rp.time_local)
    return iv, hr, rp


def local(ts):
    """Unix seconds -> naive local datetimes (what matplotlib should plot)."""
    if np.isscalar(ts):
        return pd.to_datetime(ts, unit="s", utc=True).tz_convert(TZ).tz_localize(None)
    idx = pd.DatetimeIndex(pd.to_datetime(np.asarray(ts, dtype=float), unit="s", utc=True))
    return idx.tz_convert(TZ).tz_localize(None)


def day_short(t):
    return f"{t:%a %b} {t.day}"            # Sat Nov 7  (no-padding strftime codes don't work on Windows)


def day_tiny(t):
    return f"{t:%a} {t.day}"               # Sat 7


def clock(t):
    return f"{t.hour % 12 or 12}:{t:%M} {'AM' if t.hour < 12 else 'PM'}"


def end_of_pilot(iv):
    """When the last sensor went offline for good (the sensors were taken down)."""
    ends = []
    for _, d in iv.groupby("seat_id"):
        last = d.sort_values("start_ts").iloc[-1]
        ends.append(last.start_ts if last.state == "OFFLINE" else last.end_ts)
    return max(ends)


def states_at(iv, seat, ts):
    d = iv[iv.seat_id == seat].sort_values("start_ts")
    idx = np.searchsorted(d.start_ts.values, ts, side="right") - 1
    i2 = np.clip(idx, 0, None)
    inside = (idx >= 0) & (ts < d.end_ts.values[i2])
    return np.where(inside, d.state.values[i2], "NONE")


def compute(iv, hr, rp):
    s = {}
    start, end = iv.start_ts.min(), end_of_pilot(iv)
    s["start"], s["end"] = start, end
    s["days"] = (end - start) / 86400

    # per-seat time in each state, up to the end of the pilot
    d = iv[iv.start_ts < end].copy()
    d["dur"] = d.end_ts.clip(upper=end) - d.start_ts
    p = d.pivot_table(index="seat_id", columns="state", values="dur", aggfunc="sum").fillna(0)
    for col in ("FREE", "OCCUPIED", "AWAY", "OFFLINE", "NO_DATA"):
        if col not in p:
            p[col] = 0.0
    p["taken"] = p.OCCUPIED + p.AWAY
    p["known"] = p.FREE + p.taken
    p["all"] = p.known + p.OFFLINE + p.NO_DATA
    p["taken_pct"] = 100 * p.taken / p.known
    s["per_seat"] = p
    s["uptime"] = 100 * p.known.sum() / p["all"].sum()
    longest_off = d[d.state.isin(["OFFLINE", "NO_DATA"])].sort_values("dur").iloc[-1]
    s["longest_off"] = longest_off
    s["uptime_wo_longest"] = 100 * p.known.sum() / (p["all"].sum() - longest_off.dur)

    # weekday (Mon-Thu) profile by hour of day, reliable seats
    wk = hr[hr.seat_id.isin(RELIABLE) & (hr.hour.dt.dayofweek < 5)]
    g = wk.groupby(wk.hour.dt.hour)[["taken", "known"]].sum()
    s["profile"] = (100 * g.taken / g.known).reindex(range(24))
    s["peak_hour"] = int(s["profile"].idxmax())

    # day x hour grid, reliable seats
    rel = hr[hr.seat_id.isin(RELIABLE)]
    grid = rel.groupby(rel.hour)[["taken", "known"]].sum()
    s["grid"] = grid
    wkd = rel[rel.hour.dt.dayofweek < 5]
    by = wkd.groupby([wkd.hour.dt.date, wkd.hour.dt.hour])[["taken", "known"]].sum()
    pct = by.taken / by.known
    s["busiest_by_day"] = {day: int(g.droplevel(0).idxmax()) for day, g in pct.groupby(level=0)}
    core = wk[(wk.hour.dt.hour >= 11) & (wk.hour.dt.hour < 18)]
    s["core_share"] = 100 * core.taken.sum() / wk.taken.sum()

    # how many of the 4 reliable seats were taken at once, minute by minute, weekdays
    mins = pd.date_range(local(start).normalize(), local(end), freq="1min", tz=None)
    mins = mins[mins.dayofweek < 5]
    ts = (mins.tz_localize(TZ) + pd.Timedelta(seconds=30)).asi8 / 1e9
    taken = np.zeros(len(ts))
    known = np.zeros(len(ts))
    for seat in RELIABLE:
        st = states_at(iv, seat, ts)
        taken += np.isin(st, ["OCCUPIED", "AWAY"])
        known += np.isin(st, ["OCCUPIED", "AWAY", "FREE"])
    peak = (mins.hour == s["peak_hour"]) & (known == len(RELIABLE))
    s["peak_minutes"] = int(peak.sum())
    s["peak_all_full_pct"] = 100 * float((taken[peak] == len(RELIABLE)).mean())
    s["peak_avg_taken"] = float(taken[peak].mean())

    # night check: share of 2-6 AM reports where the radar said someone was near
    night = rp[(rp.t.dt.hour >= 2) & (rp.t.dt.hour < 6)]
    s["night_near"] = (100 * night.groupby("seat_id").near.mean()).reindex(SEATS).fillna(0)
    n4 = night[(night.seat_id == "seat-04") & (night.near == 1)]
    s["night_04_still"] = {"median": n4.still_cm.median(), "p10": n4.still_cm.quantile(0.1),
                           "p90": n4.still_cm.quantile(0.9), "n": len(n4)}
    s["night_dates"] = sorted(night.t.dt.date.unique())

    s["n_reports"] = len(rp)
    s["reports_from"] = rp.t.min()
    return s


# ---------- drawing helpers ----------

def figure(title, subtitle, plot_rect=(0.09, 0.14, 0.86, 0.62)):
    fig = plt.figure(figsize=(W, H), dpi=DPI, facecolor=SURFACE)
    fig.text(0.04, 0.925, title, fontsize=26, fontweight="semibold", color=INK, va="bottom")
    fig.text(0.04, 0.875, subtitle, fontsize=14, color=INK_2, va="bottom")
    fig.text(0.04, 0.03, SOURCE, fontsize=10.5, color=MUTED)
    ax = fig.add_axes(plot_rect, facecolor=SURFACE) if plot_rect else None
    return fig, ax


def save(fig, name):
    OUT.mkdir(parents=True, exist_ok=True)
    fig.savefig(OUT / name, dpi=DPI, facecolor=SURFACE)
    plt.close(fig)
    print("wrote", OUT / name)


def _px(ax):
    (x0, y0), (x1, y1) = ax.transData.transform([(0, 0), (1, 1)])
    return abs(x1 - x0), abs(y1 - y0)


def rounded_bar(ax, pos, thickness, value, color, horizontal=False, r_px=8):
    """A bar with a rounded data end and a square baseline end."""
    if value <= 0:
        return
    k = 0.5523
    pxx, pxy = _px(ax)
    if not horizontal:
        rx, ry = r_px / pxx, r_px / pxy
        rx, ry = min(rx, thickness / 2), min(ry, value)
        l, r, t = pos - thickness / 2, pos + thickness / 2, value
        verts = [(l, 0), (l, t - ry), (l, t - ry + k * ry), (l + rx - k * rx, t), (l + rx, t),
                 (r - rx, t), (r - rx + k * rx, t), (r, t - ry + k * ry), (r, t - ry), (r, 0), (l, 0)]
    else:
        rx, ry = r_px / pxx, r_px / pxy
        ry, rx = min(ry, thickness / 2), min(rx, value)
        b, t, e = pos - thickness / 2, pos + thickness / 2, value
        verts = [(0, b), (e - rx, b), (e - rx + k * rx, b), (e, b + ry - k * ry), (e, b + ry),
                 (e, t - ry), (e, t - ry + k * ry), (e - rx + k * rx, t), (e - rx, t), (0, t), (0, b)]
    codes = [MPath.MOVETO, MPath.LINETO, MPath.CURVE4, MPath.CURVE4, MPath.CURVE4,
             MPath.LINETO, MPath.CURVE4, MPath.CURVE4, MPath.CURVE4, MPath.LINETO, MPath.CLOSEPOLY]
    ax.add_patch(PathPatch(MPath(verts, codes), facecolor=color, edgecolor="none", zorder=3))


def hour_label(h):
    return {0: "12 AM", 12: "12 PM"}.get(h, f"{h % 12} {'AM' if h < 12 else 'PM'}")


def legend_chip(fig, x, y, color, text, edge=None):
    fig.add_artist(FancyBboxPatch((x, y - 0.006), 0.014, 0.024, boxstyle="round,pad=0,rounding_size=0.003",
                                  transform=fig.transFigure, facecolor=color,
                                  edgecolor=edge or "none", linewidth=0.8))
    fig.text(x + 0.02, y + 0.006, text, fontsize=12.5, color=INK_2, va="center")


def seat_name(seat):
    return "Seat " + seat.split("-")[1]


# ---------- charts ----------

def chart_glance(s):
    fig, _ = figure("SeatNav pilot at a glance",
                    "Six radar sensors on one block of study carrels at Feldberg Library", plot_rect=None)
    peak = s["peak_hour"]
    p = s["per_seat"]
    tiles = [
        ("Live data collected", f"{s['days']:.1f} days",
         f"{day_short(local(s['start']))} – {day_short(local(s['end']))}, 2026"),
        ("Desk sensors", "6", "one block of carrels, ground floor"),
        ("Sensor check-ins", f"{s['n_reports']:,}",
         f"every 30 s per sensor, since {day_short(s['reports_from'])}"),
        ("Sensor uptime", f"{s['uptime']:.1f}%",
         f"{s['uptime_wo_longest']:.1f}% leaving out one sensor\nthat was unplugged for "
         f"{s['longest_off'].dur / 3600:.0f} h"),
        ("Busiest hour (weekdays)", f"{hour_label(peak).split()[0]}–{hour_label(peak + 1)}",
         f"seats taken {s['profile'][peak]:.0f}% of the time"),
        ("Free seat at the busiest hour", f"{100 - s['peak_all_full_pct']:.0f}%",
         f"of the time, at least 1 of the\n{len(RELIABLE)} tracked seats was free"),
    ]
    cols, x0, y0, tw, th, gx, gy = 3, 0.04, 0.44, 0.293, 0.32, 0.0225, 0.04
    for i, (label, value, note) in enumerate(tiles):
        c, r = i % cols, i // cols
        x, y = x0 + c * (tw + gx), y0 - r * (th + gy)
        fig.add_artist(FancyBboxPatch((x, y), tw, th, boxstyle="round,pad=0,rounding_size=0.012",
                                      transform=fig.transFigure, facecolor=TILE,
                                      edgecolor=GRID, linewidth=1))
        fig.text(x + 0.022, y + th - 0.06, label, fontsize=14, color=INK_2)
        fig.text(x + 0.022, y + th - 0.19, value, fontsize=40, fontweight="semibold", color=INK)
        fig.text(x + 0.022, y + 0.035, note, fontsize=11.5, color=INK_2, va="bottom", linespacing=1.4)
    save(fig, "0-pilot-at-a-glance.png")


def chart_timeline(iv, s):
    fig, ax = figure("Five days of live seat data",
                     "Each row is one desk sensor. Blue = someone at the desk (or stepped away briefly).",
                     plot_rect=(0.09, 0.13, 0.70, 0.62))
    t0 = local(s["start"]).normalize() + pd.Timedelta(hours=12)
    t1 = local(s["end"]).normalize() + pd.Timedelta(hours=23, minutes=59)
    num = mdates.date2num
    ax.set_xlim(num(t0), num(t1))
    ax.set_ylim(len(SEATS) - 0.4, -0.6)
    day = t0.normalize()
    while day <= t1:
        ax.axvspan(num(max(day, t0)), num(day + pd.Timedelta(hours=6)), color=NIGHT, zorder=0, linewidth=0)
        if day >= t0:
            ax.axvline(num(day), color=GRID, linewidth=0.8, zorder=1)
        if day + pd.Timedelta(hours=12) >= t0:
            ax.text(num(day + pd.Timedelta(hours=12)), len(SEATS) - 0.15, day_tiny(day),
                    ha="center", va="top", fontsize=13, color=INK_2)
        day += pd.Timedelta(days=1)
    for row, seat in enumerate(SEATS):
        ax.axhline(row + 0.24, color=GRID, linewidth=0.6, zorder=1)
        d = iv[iv.seat_id == seat]
        for states, color in ((["OCCUPIED", "AWAY"], BLUE), (["OFFLINE", "NO_DATA"], OFFLINE)):
            seg = d[d.state.isin(states) & (d.start_ts < s["end"])]
            starts = num(local(seg.start_ts))
            ends = num(local(seg.end_ts.clip(upper=s["end"])))
            ax.broken_barh(list(zip(starts, ends - starts)), (row - 0.22, 0.44),
                           facecolors=color, edgecolor="none", zorder=2)
        if seat in FLAGGED:
            ax.annotate(FLAGGED[seat], xy=(1.01, row), xycoords=("axes fraction", "data"),
                        fontsize=12, color=INK_2, va="center")
    ax.set_yticks(range(len(SEATS)), [seat_name(x) for x in SEATS])
    ax.tick_params(axis="y", length=0, pad=8)
    ax.set_xticks([])
    for side in ("left", "bottom"):
        ax.spines[side].set_visible(False)
    legend_chip(fig, 0.09, 0.80, BLUE, "Taken")
    legend_chip(fig, 0.18, 0.80, OFFLINE, "Sensor offline")
    legend_chip(fig, 0.32, 0.80, NIGHT, "Midnight–6 AM", edge=GRID)
    save(fig, "1-week-timeline.png")


def chart_busiest_hours(s):
    prof = s["profile"]
    fig, ax = figure("Seats fill up after lunch",
                     "Share of time seats were taken, by hour of day · weekdays, Nov 9–12 · "
                     "seats 01, 03, 05, 06")
    ax.set_xlim(-0.7, 23.7)
    top = 20 * np.ceil(prof.max() / 20)
    ax.set_ylim(0, top * 1.1)
    ax.set_yticks(np.arange(0, top + 1, 20), [f"{v:.0f}%" for v in np.arange(0, top + 1, 20)])
    ax.yaxis.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    ax.spines["left"].set_visible(False)
    ax.tick_params(axis="y", length=0)
    ax.set_xticks(range(0, 24, 3), [hour_label(h) for h in range(0, 24, 3)])
    ax.tick_params(axis="x", length=0, pad=8)
    fig.canvas.draw()
    for h, v in prof.items():
        rounded_bar(ax, h, 0.56, float(v), BLUE)
    pk = s["peak_hour"]
    ax.text(pk, prof[pk] + top * 0.025, f"{prof[pk]:.0f}%", ha="center", va="bottom",
            fontsize=15, fontweight="semibold", color=INK)
    ax.text(pk, prof[pk] + top * 0.095, hour_label(pk), ha="center", va="bottom", fontsize=12, color=INK_2)
    fig.text(0.04, 0.065, "The small early-morning bars come from one sensor (seat 01) on Monday and Tuesday "
             "mornings; the data can't tell whether someone was really there.", fontsize=11, color=MUTED)
    save(fig, "2-busiest-hours.png")


def chart_heatmap(s):
    grid = s["grid"]
    days = sorted({h.normalize() for h in grid.index})
    peaks = sorted(set(s["busiest_by_day"].values()))
    fig, ax = figure(f"Every weekday, the busiest hour was {' or '.join(hour_label(h) for h in peaks)}",
                     "Share of time seats were taken, by day and hour · seats 01, 03, 05, 06",
                     plot_rect=(0.12, 0.2, 0.83, 0.58))
    cmap = LinearSegmentedColormap.from_list("blue", RAMP)
    ax.set_xlim(0, 24)
    ax.set_ylim(len(days), 0)
    gap = 0.06
    for r, day in enumerate(days):
        for h in range(24):
            key = day + pd.Timedelta(hours=h)
            if key in grid.index and grid.loc[key, "known"] >= 3600:
                v = grid.loc[key, "taken"] / grid.loc[key, "known"]
                color = cmap(v)
            else:
                color = GRID
            ax.add_patch(Rectangle((h + gap / 2, r + gap), 1 - gap, 1 - 2 * gap,
                                   facecolor=color, edgecolor="none"))
    ax.set_yticks([r + 0.5 for r in range(len(days))], [day_short(d) for d in days])
    ax.set_xticks([h + 0.5 for h in range(0, 24, 3)], [hour_label(h) for h in range(0, 24, 3)])
    ax.tick_params(length=0, pad=8)
    for side in ("left", "bottom"):
        ax.spines[side].set_visible(False)
    # scale legend
    cax = fig.add_axes((0.62, 0.075, 0.25, 0.022))
    cax.imshow(np.linspace(0, 1, 256)[None, :], aspect="auto", cmap=cmap, extent=(0, 100, 0, 1))
    cax.set_yticks([])
    cax.set_xticks([0, 50, 100], ["0%", "50%", "100% taken"])
    cax.tick_params(length=0, labelsize=11.5, pad=4)
    for sp in cax.spines.values():
        sp.set_visible(False)
    legend_chip(fig, 0.47, 0.086, GRID, "No data")
    save(fig, "3-day-by-hour-heatmap.png")


def chart_seats(s):
    p = s["per_seat"].loc[RELIABLE].sort_values("taken_pct", ascending=False)
    hi, lo = p.iloc[0], p.iloc[-1]
    ratio = hi.taken_pct / lo.taken_pct
    fig, ax = figure(f"One block of carrels, {ratio:.0f}× difference in use",
                     "Share of monitored time each seat was taken, Nov 7–12 · seats 02 and 04 left out "
                     "(false detections)", plot_rect=(0.12, 0.16, 0.8, 0.6))
    n = len(p)
    ax.set_ylim(n - 0.5, -0.5)
    top = 10 * np.ceil((p.taken_pct.max() + 5) / 10)
    ax.set_xlim(0, top)
    ax.set_xticks(np.arange(0, top + 1, 10), [f"{v:.0f}%" for v in np.arange(0, top + 1, 10)])
    ax.xaxis.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    ax.set_yticks(range(n), [seat_name(x) for x in p.index])
    ax.tick_params(length=0, pad=8)
    ax.spines["left"].set_color(BASELINE)
    ax.spines["bottom"].set_visible(False)
    fig.canvas.draw()
    for i, (seat, row) in enumerate(p.iterrows()):
        rounded_bar(ax, i, 0.42, row.taken_pct, BLUE, horizontal=True)
        ax.text(row.taken_pct + top * 0.012, i, f"{row.taken_pct:.0f}%  ({row.taken / 3600:.0f} h)",
                va="center", fontsize=14, color=INK)
    save(fig, "4-seat-popularity.png")


def chart_sensor_check(s):
    nn = s["night_near"]
    dates = s["night_dates"]
    fig, ax = figure("Our data caught a misbehaving sensor",
                     f"Share of 2–6 AM check-ins where the radar said someone was at the desk · nights of "
                     f"{dates[0]:%b} {dates[0].day}–{dates[-1].day}", plot_rect=(0.12, 0.2, 0.57, 0.56))
    n = len(SEATS)
    ax.set_ylim(n - 0.5, -0.5)
    ax.set_xlim(0, 60)
    ax.set_xticks(range(0, 61, 20), [f"{v}%" for v in range(0, 61, 20)])
    ax.xaxis.grid(True, color=GRID, linewidth=0.6)
    ax.set_axisbelow(True)
    ax.set_yticks(range(n), [seat_name(x) for x in SEATS])
    ax.tick_params(length=0, pad=8)
    ax.spines["left"].set_color(BASELINE)
    ax.spines["bottom"].set_visible(False)
    fig.canvas.draw()
    for i, seat in enumerate(SEATS):
        v = float(nn[seat])
        if round(v) > 0:                       # a 0% label gets no hair-thin sliver
            rounded_bar(ax, i, 0.42, v, BLUE, horizontal=True)
        ax.text(v + 0.8, i, f"{v:.0f}%", va="center", fontsize=14, color=INK)
    still = s["night_04_still"]
    fig.text(0.77, 0.66, "Seat 04", fontsize=15, fontweight="semibold", color=INK)
    fig.text(0.77, 0.47,
             f"Every night, its radar kept\nreporting a still object\n{still['median']:.0f} cm away, while the other\n"
             "seats read empty. Seat 02 did\nthe same on some nights.",
             fontsize=13, color=INK_2, linespacing=1.5)
    fig.text(0.77, 0.25, "Next steps", fontsize=15, fontweight="semibold", color=INK)
    fig.text(0.77, 0.11, "Re-mount and re-test those two\nsensors; automatically flag any\n"
             "seat that stays taken all night.", fontsize=13, color=INK_2, linespacing=1.5)
    save(fig, "5-sensor-check.png")


def write_stats(s):
    p = s["per_seat"]
    pk = s["peak_hour"]
    rel = p.loc[RELIABLE].sort_values("taken_pct", ascending=False)
    lines = [
        "SEATNAV PILOT: NUMBERS FOR THE PITCH",
        "====================================",
        f"Made by tools/pitch_charts.py from data/export/ (Feldberg Library, {len(SEATS)} sensors).",
        "",
        "HEADLINE NUMBERS",
        f"- Live data: {s['days']:.1f} days, {day_short(local(s['start']))} {clock(local(s['start']))} to "
        f"{day_short(local(s['end']))} {clock(local(s['end']))} (when the sensors were taken down).",
        f"- Sensor check-ins collected: {s['n_reports']:,} (every 30 s per sensor, since "
        f"{day_short(s['reports_from'])}; earlier days have state changes only).",
        f"- Uptime: {s['uptime']:.1f}% overall; {s['uptime_wo_longest']:.1f}% without "
        f"{seat_name(s['longest_off'].seat_id).lower()}'s {s['longest_off'].dur / 3600:.1f} h offline stretch "
        f"({day_short(local(s['longest_off'].start_ts))} {clock(local(s['longest_off'].start_ts))} – "
        f"{day_short(local(s['longest_off'].start_ts + s['longest_off'].dur))} "
        f"{clock(local(s['longest_off'].start_ts + s['longest_off'].dur))}).",
        f"- Busiest weekday hour: {hour_label(pk)}–{hour_label(pk + 1)}, seats taken {s['profile'][pk]:.0f}% of the time.",
        f"- At that hour, all {len(RELIABLE)} tracked seats were full only {s['peak_all_full_pct']:.0f}% of the time,",
        f"  so a free seat existed {100 - s['peak_all_full_pct']:.0f}% of the time "
        f"(average {s['peak_avg_taken']:.1f} of {len(RELIABLE)} seats taken; {s['peak_minutes']} minutes measured).",
        "- Busiest hour on each weekday: "
        + ", ".join(f"{d:%a} {hour_label(h)}" for d, h in s["busiest_by_day"].items()) + ".",
        f"- {s['core_share']:.0f}% of weekday seat use fell between 11 AM and 6 PM.",
        "- Share of monitored time each seat was taken:",
    ]
    for seat, row in p.iterrows():
        flag = f"   <- unreliable: {FLAGGED[seat]}" if seat in FLAGGED else ""
        lines.append(f"    {seat_name(seat)}: {row.taken_pct:5.1f}%  ({row.taken / 3600:.1f} h of "
                     f"{row.known / 3600:.1f} h){flag}")
    lines += [
        f"- Most vs least used reliable seat: {seat_name(rel.index[0])} {rel.iloc[0].taken_pct:.0f}% vs "
        f"{seat_name(rel.index[-1])} {rel.iloc[-1].taken_pct:.0f}% "
        f"({rel.iloc[0].taken_pct / rel.iloc[-1].taken_pct:.1f}x), in the same block of six carrels.",
        "- Night check (2–6 AM, share of check-ins with someone 'near'): "
        + ", ".join(f"{seat_name(k)} {v:.0f}%" for k, v in s["night_near"].items()) + ".",
        f"  Seat 04's night readings ({s['night_04_still']['n']} check-ins) are a still object at "
        f"{s['night_04_still']['median']:.0f} cm (10th-90th percentile {s['night_04_still']['p10']:.0f}-"
        f"{s['night_04_still']['p90']:.0f} cm).",
        "",
        "TALKING POINTS",
        "- It works in a real library: six sensors ran for five days with ~97% uptime.",
        "- The data shows when the library is busy (weekday early afternoons) and which",
        "  seats students prefer. That's the seat-level planning data libraries can't get today.",
        "- Even at the busiest hour there was usually a free seat. Students just can't see",
        "  it, which is the problem the live map solves.",
        "- We caught a sensor problem from the data itself (seat 04 'taken' every night).",
        "  That's how SeatNav would monitor its own sensors at scale.",
        "",
        "CAVEATS (say them if asked)",
        "- Small pilot: 6 seats, 5 days, one library, one block of carrels.",
        "- Usage charts use the 4 reliable seats (01, 03, 05, 06); seats 02 and 04 are left out.",
        "- The sensors ran the TEST timings (a seat counts as free 60 s after someone",
        "  leaves; the real setting would hold it for 15 min). Hours 'taken' would be a little higher",
        "  with the real timings.",
        "- Seat 01 shows early-morning activity on Mon (about 3–10 AM, flickering until ~5:30)",
        "  and Tue (about 6–7 AM). It could be a person, cleaning staff or noise; the data can't tell.",
        "- 'Taken' = occupied or briefly stepped away (OCCUPIED + AWAY).",
    ]
    (OUT / "PITCH_STATS.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("wrote", OUT / "PITCH_STATS.txt")


def main():
    iv, hr, rp = load()
    s = compute(iv, hr, rp)
    chart_glance(s)
    chart_timeline(iv, s)
    chart_busiest_hours(s)
    chart_heatmap(s)
    chart_seats(s)
    chart_sensor_check(s)
    write_stats(s)


if __name__ == "__main__":
    main()
