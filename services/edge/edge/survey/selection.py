"""Section selection: decides which part of the surveyed area each drone maps next.

THIS IS A PLACEHOLDER. The real selection algorithm is being developed separately.
To plug it in, write a function with the `SelectionAlgorithm` signature and pass it to
`SurveySession(selection=your_algorithm)` (see edge/site.py), or point the
SELECTION_ALGORITHM environment variable at it ("package.module:function").
Nothing else needs to change.

All inputs and outputs are plain dicts so the algorithm has no dependency on this code:

    input = {
        "mode": "initial" | "requested",   # first pass after the perimeter closes / user picked sections
        "launch": {"x": float, "y": float},
        "perimeter": [{"x", "y"}, ...],
        "sections": [{"id": "B3", "x", "y", "w", "h", "coverage": 0..1}, ...],
        "drones": [{"id": "SV-1", "x", "y", "battery": 0..100}, ...],   # free drones only
        "swathM": float,                   # width mapped per pass, meters
        "requestedSectionIds": ["B3", ...],
    }
    returns [{"droneId": "SV-1", "sectionId": "B3", "waypoints": [{"x", "y"}, ...]}, ...]

Coordinates are site meters: x east, y south.
"""

from __future__ import annotations

import importlib
import math
import os
from typing import Callable

SelectionAlgorithm = Callable[[dict], list[dict]]


def placeholder_selection(inp: dict) -> list[dict]:
    """Initial pass: each free drone takes one of the sections closest to the launch point.
    Requested: split each requested section into strips, one per free drone.
    Each drone flies a back-and-forth (lawnmower) pattern over its area."""
    free = list(inp["drones"])
    out: list[dict] = []
    if not free:
        return out

    if inp["mode"] == "initial":
        ranked = sorted((s for s in inp["sections"] if s["coverage"] < 0.97), key=lambda s: _dist_to(inp["launch"], s))
        for s in ranked[: len(free)]:
            drone = _take_nearest(free, _center(s))
            if not drone:
                break
            out.append({"droneId": drone["id"], "sectionId": s["id"], "waypoints": lawnmower(s, inp["swathM"], drone)})
        return out

    by_id = {s["id"]: s for s in inp["sections"]}
    requested = [by_id[i] for i in inp["requestedSectionIds"] if i in by_id]
    if not requested:
        return out
    per_section = max(1, len(free) // len(requested))
    for s in requested:
        crew = []
        for _ in range(per_section):
            if not free:
                break
            crew.append(_take_nearest(free, _center(s)))
        if not crew:
            break
        band_h = s["h"] / len(crew)
        for i, d in enumerate(crew):
            band = {**s, "y": s["y"] + i * band_h, "h": band_h}
            out.append({"droneId": d["id"], "sectionId": s["id"], "waypoints": lawnmower(band, inp["swathM"], d)})
    return out


def _center(s: dict) -> dict:
    return {"x": s["x"] + s["w"] / 2, "y": s["y"] + s["h"] / 2}


def _dist_to(p: dict, s: dict) -> float:
    c = _center(s)
    return math.hypot(c["x"] - p["x"], c["y"] - p["y"])


def _take_nearest(drones: list[dict], p: dict):
    if not drones:
        return None
    best = 0
    for i in range(1, len(drones)):
        if math.hypot(drones[i]["x"] - p["x"], drones[i]["y"] - p["y"]) < math.hypot(drones[best]["x"] - p["x"], drones[best]["y"] - p["y"]):
            best = i
    return drones.pop(best)


def lawnmower(area: dict, swath_m: float, frm: dict) -> list[dict]:
    """Back-and-forth rows across a rectangle, starting from the corner nearest the drone."""
    spacing = swath_m * 0.85  # overlap so rows leave no gaps
    rows_n = max(1, math.ceil(area["h"] / spacing))
    step = area["h"] / rows_n
    left = area["x"] + swath_m * 0.4
    right = area["x"] + area["w"] - swath_m * 0.4
    from_top = abs(frm["y"] - area["y"]) <= abs(frm["y"] - (area["y"] + area["h"]))
    from_left = abs(frm["x"] - left) <= abs(frm["x"] - right)
    pts = []
    for i in range(rows_n):
        y = area["y"] + step * (i + 0.5) if from_top else area["y"] + area["h"] - step * (i + 0.5)
        left_first = (i % 2 == 0) == from_left
        pts.append({"x": left if left_first else right, "y": y})
        pts.append({"x": right if left_first else left, "y": y})
    return pts


def load_selection() -> SelectionAlgorithm:
    """SELECTION_ALGORITHM="my_pkg.module:select" swaps in the real algorithm without code changes."""
    spec = os.environ.get("SELECTION_ALGORITHM")
    if not spec:
        return placeholder_selection
    mod, _, fn = spec.partition(":")
    return getattr(importlib.import_module(mod), fn or "select")
