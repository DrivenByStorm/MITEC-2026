"""Rule-based buildup planner.

Given the surveyed terrain, the number of P3 units and the crew available, it decides:
  1. WHERE units go: rows on mapped ground flat enough to build on, grouped into blocks,
     packed as close to the site office as the terrain allows;
  2. HOW MANY RELAYS and where: every unit within machine-link range of at least two relays
     (so one failure never cuts a work area off), all chained to the gateway;
  3. WHAT FLEET and CREW: starts with one crew of each kind, then keeps adding to whichever
     stage is the schedule bottleneck while people remain;
  4. HOW LONG it should take, and what limits it.
The number of units is always the build manager's input; the planner never changes it (it
only warns if the mapped ground can't fit them all).

Plans are plain dicts with camelCase keys, matching the UI's SitePlan type.
"""

from __future__ import annotations

import base64
import math
import time
from dataclasses import dataclass

import numpy as np

from ..twin.network import ASSET_RANGE_M, RELAY_RANGE_M
from .assumptions import ASSUMPTIONS

UNIT_HALF_W = 6  # P3 footprint used for layout, meters (12 x 8)
UNIT_HALF_H = 4
RELAY_GRID_M = 90
REDUNDANCY = 2
STAGES = ("Piling", "Setting units", "Trenching", "Electrical")


@dataclass
class PlannerContext:
    heights: np.ndarray  # float32, row-major
    coverage: np.ndarray  # uint8, 1 where the survey mapped the ground
    cols: int
    rows: int
    cell_m: float
    perimeter: list[dict]  # NW, NE, SE, SW
    launch: dict


def plan_site(unit_count: float, crew_size: float, ctx: PlannerContext, A: dict = ASSUMPTIONS) -> dict:
    warnings: list[str] = []
    cols, rows, cell = ctx.cols, ctx.rows, ctx.cell_m
    launch = ctx.launch
    unit_count = max(0, round(unit_count))
    crew_size = max(0, round(crew_size))

    # ---------- ground classification ----------
    office = {"x": launch["x"] - 70, "y": launch["y"] - 60, "w": 140, "h": 120}
    laydown = {"x": launch["x"] + 85, "y": launch["y"] - 80, "w": 190, "h": 160}
    nw, se = ctx.perimeter[0], ctx.perimeter[2]
    slope = _slope_grid(ctx)
    cx = ((np.arange(cols) + 0.5) * cell)[None, :]
    cy = ((np.arange(rows) + 0.5) * cell)[:, None]
    sb = A["boundarySetbackM"]
    inside = (cx >= nw["x"] + sb) & (cx <= se["x"] - sb) & (cy >= nw["y"] + sb) & (cy <= se["y"] - sb)
    reserved = _in_rect_grid(cx, cy, office, 25) | _in_rect_grid(cx, cy, laydown, 25)
    cov = ctx.coverage.reshape(rows, cols) == 1
    steep = slope.reshape(rows, cols) > A["maxSlopePct"]
    g = np.zeros((rows, cols), dtype=np.uint8)
    g[cov] = 1
    g[cov & (~inside | reserved)] = 3
    g[cov & steep] = 2
    ground = g.ravel()

    # ---------- slots: a lattice of possible unit positions anchored on the launch point ----------
    SX, SY = A["slotSpacingM"], A["rowSpacingM"]
    slots: list[dict] = []
    i_min, i_max = math.ceil((nw["x"] - launch["x"]) / SX), math.floor((se["x"] - launch["x"]) / SX)
    j_min, j_max = math.ceil((nw["y"] - launch["y"]) / SY), math.floor((se["y"] - launch["y"]) / SY)
    pad = 3
    hg = ctx.heights.reshape(rows, cols)
    sg = slope.reshape(rows, cols)
    for j in range(j_min, j_max + 1):
        for i in range(i_min, i_max + 1):
            x = launch["x"] + i * SX
            y = launch["y"] + j * SY
            c0, c1 = math.floor((x - UNIT_HALF_W - pad) / cell), math.floor((x + UNIT_HALF_W + pad) / cell)
            r0, r1 = math.floor((y - UNIT_HALF_H - pad) / cell), math.floor((y + UNIT_HALF_H + pad) / cell)
            if c0 < 0 or r0 < 0 or c1 >= cols or r1 >= rows:
                continue
            if not (g[r0 : r1 + 1, c0 : c1 + 1] == 1).all():
                continue
            hb = hg[r0 : r1 + 1, c0 : c1 + 1]
            if float(hb.max()) - float(hb.min()) <= A["maxFootprintReliefM"]:
                slots.append({"i": i, "j": j, "x": x, "y": y, "slopeMax": float(sg[r0 : r1 + 1, c0 : c1 + 1].max())})

    # Fill whole blocks, nearest the office first (how crews actually sequence the work).
    capacity = A["blockRows"] * A["blockSlots"]

    def bkey(s):
        return (s["i"] // A["blockSlots"], s["j"] // A["blockRows"])

    by_block: dict[tuple, list] = {}
    for s in slots:
        by_block.setdefault(bkey(s), []).append(s)
    ranked = []
    for lst in by_block.values():
        bx = sum(s["x"] for s in lst) / len(lst)
        by = sum(s["y"] for s in lst) / len(lst)
        fill = len(lst) / capacity
        ranked.append((math.hypot(bx - launch["x"], by - launch["y"]) * (1 + 0.6 * (1 - fill)), lst))
    ranked.sort(key=lambda t: t[0])

    def slot_score(s):
        return math.hypot(s["x"] - launch["x"], s["y"] - launch["y"]) * (1 + 0.5 * s["slopeMax"] / A["maxSlopePct"])

    chosen: list[dict] = []
    min_useful = math.ceil(capacity * 0.1)  # first pass skips nearly-empty blocks
    for pass_ in (0, 1):
        for _, lst in ranked:
            if len(chosen) >= unit_count:
                break
            sparse = len(lst) < min_useful
            if (pass_ == 0 and sparse) or (pass_ == 1 and not sparse):
                continue
            chosen.extend(sorted(lst, key=slot_score)[: unit_count - len(chosen)])
    if len(chosen) < unit_count:
        warnings.append(
            f"Only {len(chosen)} of {unit_count} units fit on mapped ground flatter than {A['maxSlopePct']}%. "
            "Map more of the site in the survey, or build in phases."
        )

    # ---------- blocks (named in build order, A first) ----------
    groups: dict[tuple, list] = {}
    for s in chosen:
        groups.setdefault(bkey(s), []).append(s)
    units: list[dict] = []
    blocks: list[dict] = []
    for n, ((bi, bj), lst) in enumerate(groups.items()):
        bid = _block_label(n)
        items = [{**s, "row": s["j"] - bj * A["blockRows"] + 1, "slot": s["i"] - bi * A["blockSlots"] + 1} for s in lst]
        # row by row, alternating direction so machines don't backtrack
        items.sort(key=lambda s: (s["row"], s["slot"] if s["row"] % 2 else -s["slot"]))
        for s in items:
            units.append({"id": f"{bid}-{s['row']:02d}-{s['slot']:02d}", "block": bid, "row": s["row"], "slot": s["slot"], "x": s["x"], "y": s["y"]})
        xs = [s["x"] for s in items]
        ys = [s["y"] for s in items]
        blocks.append(
            {
                "id": bid,
                "x": min(xs) - UNIT_HALF_W - 6,
                "y": min(ys) - UNIT_HALF_H - 8,
                "w": max(xs) - min(xs) + 2 * UNIT_HALF_W + 12,
                "h": max(ys) - min(ys) + 2 * UNIT_HALF_H + 16,
                "rows": len({s["row"] for s in items}),
                "slots": len({s["slot"] for s in items}),
                "unitCount": len(items),
            }
        )

    # ---------- trench & haul distances ----------
    hub = _center(laydown)
    trench_m = 0.0
    for b in blocks:
        by_row: dict[int, list[float]] = {}
        for u in units:
            if u["block"] == b["id"]:
                by_row.setdefault(u["row"], []).append(u["x"])
        for xs in by_row.values():
            trench_m += max(xs) - min(xs) + SX
        trench_m += b["h"]  # spine along the block
        trench_m += abs(b["x"] + b["w"] / 2 - office["x"]) + abs(b["y"] + b["h"] / 2 - office["y"])  # feeder
    mean_haul_m = (sum(math.hypot(u["x"] - hub["x"], u["y"] - hub["y"]) for u in units) / len(units)) * 1.2 if units else 0.0

    # ---------- relays ----------
    gateway = {"x": office["x"] + 20, "y": office["y"] + 20}
    relays, uncovered = _plan_relays(units, [_center(office), _center(laydown)], gateway, ctx, nw, se)
    if uncovered > 0:
        warnings.append(f"{uncovered} work location(s) could only be covered by one relay; the mapped ground ran out for a second.")

    # ---------- fleet & crew ----------
    fp = _size_fleet(len(units), trench_m, mean_haul_m, crew_size, A)
    warnings.extend(fp["warnings"])
    c, th = fp["c"], fp["thPerCrane"]
    N = len(units)
    link_only = sum(1 for r in relays if r["linkOnly"])
    fleet = [
        {"key": "pile", "name": "Pile-driving robot", "kind": "robot", "count": c["pile"],
         "why": f"{N} units × {A['pilesPerUnit']} piles = {N * A['pilesPerUnit']} piles at {A['pileRobotPilesPerDay']} per robot per day."},
        {"key": "crane", "name": "Crane", "kind": "machine", "count": c["crane"],
         "why": f"Sets about {A['craneUnitsPerDay']} units a day each, matched to the piling rate."},
        {"key": "telehandler", "name": "Telehandler", "kind": "machine", "count": c["crane"] * th,
         "why": f"Average haul {round(mean_haul_m)} m from the laydown yard, so each crane needs {th} to keep it fed."},
        {"key": "trencher", "name": "Trencher", "kind": "machine", "count": c["trench"],
         "why": f"{trench_m / 1000:.1f} km of cable trench at {A['trencherMPerDay']} m per trencher per day."},
        {"key": "rover", "name": "Layout rover", "kind": "robot", "count": int(A["layoutRovers"]),
         "why": "Autonomous rovers stake each row's pile positions before piling and check the piles after; they bid for row tasks over the mesh."},
        {"key": "drone", "name": "Survey drone", "kind": "drone", "count": 1, "why": "As-built survey of each block once it's piled; reused from the survey fleet."},
        {"key": "relay", "name": "Solar relay mast", "kind": "network", "count": len(relays),
         "why": f"Every unit within {ASSET_RANGE_M} m of at least {REDUNDANCY} relays; {link_only} extra to chain far relays back to the gateway (hops ≤ {RELAY_RANGE_M} m)."},
        {"key": "loraGateway", "name": "LoRa gateway", "kind": "network", "count": max(1, math.ceil(len(relays) / 2)), "why": "On every other relay mast, for worker tags."},
        {"key": "tag", "name": "Worker tag (LoRa + UWB)", "kind": "wearable", "count": fp["crewUsed"], "why": "One per person on site, for position and proximity stops."},
    ]

    pts = [{"x": u["x"], "y": u["y"]} for u in units] + relays + _corners(office) + _corners(laydown)
    return {
        "input": {"unitCount": unit_count, "crewSize": crew_size},
        "createdAt": int(time.time() * 1000),
        "units": units,
        "blocks": blocks,
        "relays": relays,
        "gateway": gateway,
        "office": office,
        "laydown": laydown,
        "trenchM": trench_m,
        "meanHaulM": mean_haul_m,
        "fleet": fleet,
        "crew": fp["crew"],
        "crewUsed": fp["crewUsed"],
        "stages": fp["stages"],
        "totalDays": fp["totalDays"],
        "bottleneck": fp["bottleneck"],
        "warnings": warnings,
        "buildableSlots": len(slots),
        "bounds": _bounds_of(pts, 140),
        "ground": base64.b64encode(ground.tobytes()).decode("ascii"),
        "terrain": {"cols": cols, "rows": rows, "cellM": cell},
        "assumptions": dict(A),
    }


# ---------- relays ----------


def _plan_relays(units, extra, gateway, ctx: PlannerContext, nw, se):
    targets = np.array([[u["x"], u["y"]] for u in units] + [[p["x"], p["y"]] for p in extra], dtype=float)
    R2 = ASSET_RANGE_M**2
    need = [max(0, REDUNDANCY - (1 if _d2(t, gateway) <= R2 else 0)) for t in ({"x": a, "y": b} for a, b in targets)]

    unit_hash: dict[tuple, list] = {}
    for u in units:
        unit_hash.setdefault((math.floor(u["x"] / 50), math.floor(u["y"] / 50)), []).append(u)

    def near_unit(px, py):
        kx, ky = math.floor(px / 50), math.floor(py / 50)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for u in unit_hash.get((kx + dx, ky + dy), ()):
                    if abs(u["x"] - px) < UNIT_HALF_W + 8 and abs(u["y"] - py) < UNIT_HALF_H + 8:
                        return True
        return False

    # Candidate mast sites: a grid over mapped ground, not on top of a unit.
    candidates: list[tuple[dict, list[int]]] = []
    y = nw["y"]
    while y <= se["y"]:
        x = nw["x"]
        while x <= se["x"]:
            c, r = math.floor(x / ctx.cell_m), math.floor(y / ctx.cell_m)
            p = {"x": x, "y": y}
            if 0 <= c < ctx.cols and 0 <= r < ctx.rows and ctx.coverage[r * ctx.cols + c] and not near_unit(x, y) and _d2(p, gateway) >= 60**2:
                d2 = (targets[:, 0] - x) ** 2 + (targets[:, 1] - y) ** 2
                cover = np.nonzero(d2 <= R2)[0].tolist()
                if cover:
                    candidates.append((p, cover))
            x += RELAY_GRID_M
        y += RELAY_GRID_M

    # Greedy multi-cover: keep adding the mast that serves the most still-under-covered targets.
    picked: list[dict] = []
    while True:
        best, best_gain = -1, 0
        for k, (_, cover) in enumerate(candidates):
            gain = sum(1 for t in cover if need[t] > 0)
            if gain > best_gain:
                best, best_gain = k, gain
        if best < 0:
            break
        p, cover = candidates.pop(best)
        picked.append(p)
        for t in cover:
            if need[t] > 0:
                need[t] -= 1
    uncovered = sum(1 for n in need if n > 0)

    # Chain every mast back to the gateway within mesh range, adding link-only masts where needed.
    link = RELAY_RANGE_M * 0.92
    link_only: set[int] = set()
    allp: list[dict] = list(picked)
    for _ in range(200):
        connected = _reachable(gateway, allp, link)
        loose = [p for p in allp if id(p) not in connected]
        if not loose:
            break
        best_pair, best_d = None, math.inf
        anchors = [gateway] + [p for p in allp if id(p) in connected]
        for u in loose:
            for c in anchors:
                d = math.sqrt(_d2(u, c))
                if d < best_d:
                    best_d, best_pair = d, (c, u)
        frm, to = best_pair
        steps = math.ceil(best_d / (link * 0.95))
        for k in range(1, steps):
            p = {"x": frm["x"] + (to["x"] - frm["x"]) * k / steps, "y": frm["y"] + (to["y"] - frm["y"]) * k / steps}
            allp.append(p)
            link_only.add(id(p))
        if steps <= 1:
            break

    allp.sort(key=lambda p: (p["y"], p["x"]))
    relays = [
        {
            "id": f"M-{i + 1}",
            "x": _js_round(p["x"]),
            "y": _js_round(p["y"]),
            "covers": sum(1 for u in units if _d2(u, p) <= R2),
            "linkOnly": id(p) in link_only,
        }
        for i, p in enumerate(allp)
    ]
    return relays, uncovered


def _reachable(gateway, nodes, rng):
    r2 = rng * rng
    seen: set[int] = set()
    queue = [gateway]
    while queue:
        cur = queue.pop(0)
        for n in nodes:
            if id(n) not in seen and _d2(cur, n) <= r2:
                seen.add(id(n))
                queue.append(n)
    return seen


# ---------- fleet sizing ----------


def _size_fleet(N, trench_m, mean_haul_m, crew_size, A):
    warnings: list[str] = []
    m_per_min = A["telehandlerSpeedKmh"] * 1000 / 60
    cycle = A["telehandlerLoadMin"] + A["telehandlerHandoffMin"] + 2 * mean_haul_m / m_per_min
    th_per_crane = max(1, math.ceil(A["craneUnitsPerDay"] / (A["shiftMinutes"] / cycle)))

    def field(c):
        return (
            c["pile"] * A["pileRobotCrew"]
            + c["crane"] * (A["craneCrew"] + th_per_crane * A["telehandlerCrew"])
            + c["trench"] * A["trencherCrew"]
            + c["elec"] * A["electricalCrew"]
            + 1  # drone pilot
        )

    def supervisors(f):
        return max(1, math.ceil(f / A["workersPerForeman"])), max(1, math.ceil(f / A["workersPerSafetyLead"]))

    def total(c):
        f = field(c)
        fo, sa = supervisors(f)
        return f + fo + sa

    def stage_days(c):
        return {
            "Piling": N * A["pilesPerUnit"] / (c["pile"] * A["pileRobotPilesPerDay"]) if N else 0,
            "Setting units": N / (c["crane"] * A["craneUnitsPerDay"]) if N else 0,
            "Trenching": trench_m / (c["trench"] * A["trencherMPerDay"]) if trench_m else 0,
            "Electrical": N / (c["elec"] * A["electricalUnitsPerDay"]) if N else 0,
        }

    def slowest(days):
        best = STAGES[0]
        for s in STAGES[1:]:
            if days[s] > days[best]:
                best = s
        return best

    key_of = {"Piling": "pile", "Setting units": "crane", "Trenching": "trench", "Electrical": "elec"}
    c = {"pile": 1, "crane": 1, "trench": 1, "elec": 1}
    minimum = total(c)
    if minimum > crew_size:
        warnings.append(f"One crew of each kind needs {minimum} people; you entered {crew_size}. The plan uses the minimum of {minimum}.")
    blocked_by = ""
    for _ in range(400):
        days = stage_days(c)
        stage = slowest(days)
        k = key_of[stage]
        nxt = {**c, k: c[k] + 1}
        saved = days[stage] - stage_days(nxt)[stage]
        if saved < 0.25:
            blocked_by = f"another {_stage_noun(stage)} would save less than a quarter day"
            break
        if total(nxt) > max(crew_size, minimum):
            blocked_by = f"another {_stage_noun(stage)} needs {total(nxt) - total(c)} more people"
            break
        c[k] += 1

    days = stage_days(c)
    bottleneck = slowest(days)
    crew_used = total(c)
    fo, sa = supervisors(field(c))
    if crew_size > crew_used:
        warnings.append(f"{crew_size - crew_used} of your {crew_size} people aren't needed: {blocked_by}.")

    def pl(n, word, plural=None):
        return f"{n} {word if n == 1 else (plural or word + 's')}"

    stages = [
        {"stage": "Piling", "days": days["Piling"], "detail": pl(c["pile"], "pile-driving robot")},
        {"stage": "Setting units", "days": days["Setting units"], "detail": f"{pl(c['crane'], 'crane')} with {pl(c['crane'] * th_per_crane, 'telehandler')}"},
        {"stage": "Trenching", "days": days["Trenching"], "detail": pl(c["trench"], "trencher")},
        {"stage": "Electrical", "days": days["Electrical"], "detail": pl(c["elec"], "electrical crew")},
    ]
    # Stages overlap: setting follows piling by about a day, so total ≈ slowest stage + 1 day.
    total_days = math.ceil((max(days.values()) + 1) * 2) / 2 if N else 0

    crew = [
        {"role": "Robot operator", "count": c["pile"], "with": "pile-driving robots"},
        {"role": "Pile loader", "count": c["pile"] * (A["pileRobotCrew"] - 1), "with": "pile-driving robots"},
        {"role": "Crane operator", "count": c["crane"], "with": "cranes"},
        {"role": "Rigger", "count": c["crane"] * 2, "with": "cranes"},
        {"role": "Signal person", "count": c["crane"] * (A["craneCrew"] - 3), "with": "cranes"},
        {"role": "Telehandler operator", "count": c["crane"] * th_per_crane * A["telehandlerCrew"], "with": "telehandlers"},
        {"role": "Trencher operator", "count": c["trench"], "with": "trenchers"},
        {"role": "Trench laborer", "count": c["trench"] * (A["trencherCrew"] - 1), "with": "trenchers"},
        {"role": "Electrician", "count": c["elec"] * A["electricalCrew"], "with": "connecting and commissioning units"},
        {"role": "Drone pilot", "count": 1, "with": "progress surveys"},
        {"role": "Foreman", "count": fo, "with": f"one per {A['workersPerForeman']} workers"},
        {"role": "Safety lead", "count": sa, "with": "site safety"},
    ]
    crew = [r for r in crew if r["count"] > 0]
    return {"c": c, "thPerCrane": th_per_crane, "crew": crew, "crewUsed": crew_used, "stages": stages, "totalDays": total_days, "bottleneck": bottleneck, "warnings": warnings}


def _stage_noun(s):
    return {"Piling": "pile-driving robot", "Setting units": "crane crew", "Trenching": "trencher", "Electrical": "electrical crew"}[s]


# ---------- helpers ----------


def _slope_grid(ctx: PlannerContext) -> np.ndarray:
    """Percent slope per cell from mapped neighbors (unmapped neighbors count as level)."""
    rows, cols = ctx.rows, ctx.cols
    h = ctx.heights.reshape(rows, cols).astype(np.float64)
    cov = ctx.coverage.reshape(rows, cols) == 1
    z = np.where(cov, h, np.nan)
    p = np.pad(z, 1, constant_values=np.nan)

    def nb(dr, dc):
        v = p[1 + dr : 1 + dr + rows, 1 + dc : 1 + dc + cols]
        return np.where(np.isnan(v), h, v)

    dzdx = (nb(0, 1) - nb(0, -1)) / (2 * ctx.cell_m)
    dzdy = (nb(1, 0) - nb(-1, 0)) / (2 * ctx.cell_m)
    out = (100 * np.hypot(dzdx, dzdy)).astype(np.float32)
    out[~cov] = np.inf
    return out.ravel()


def _in_rect_grid(cx, cy, r, pad):
    return (cx >= r["x"] - pad) & (cx <= r["x"] + r["w"] + pad) & (cy >= r["y"] - pad) & (cy <= r["y"] + r["h"] + pad)


def _center(r):
    return {"x": r["x"] + r["w"] / 2, "y": r["y"] + r["h"] / 2}


def _corners(r):
    return [{"x": r["x"], "y": r["y"]}, {"x": r["x"] + r["w"], "y": r["y"] + r["h"]}]


def _bounds_of(pts, pad):
    xs = [p["x"] for p in pts]
    ys = [p["y"] for p in pts]
    return {
        "x": min(xs) - pad,
        "y": min(ys) - pad,
        "w": max(800, max(xs) - min(xs) + 2 * pad),
        "h": max(600, max(ys) - min(ys) + 2 * pad),
    }


def _d2(a, b):
    return (a["x"] - b["x"]) ** 2 + (a["y"] - b["y"]) ** 2


def _js_round(v: float) -> int:
    return math.floor(v + 0.5)


def _block_label(n: int) -> str:
    s, k = "", n
    while True:
        s = chr(65 + k % 26) + s
        k = k // 26 - 1
        if k < 0:
            return s
