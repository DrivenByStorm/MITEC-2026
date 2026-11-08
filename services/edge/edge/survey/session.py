"""Simulated drone survey that builds the site's terrain model from scratch.

Flow: the build manager sets a distance and starts the survey. The scout drone flies out
that far from the launch point and traces the site boundary, mapping a strip as it goes.
The area inside is split into sections, the selection algorithm assigns sections to the
survey drones, and each drone reveals elevation along its path. Afterwards the user can
send drones to suggested gaps or lock the survey for buildup.

Runs at accelerated speed so a full pass fits in a demo. The edge server calls tick()
every TICK_S seconds. To use live drones instead, feed real positions and mapped cells
into the same snapshot shape (see README, "Plugging in real data").
"""

from __future__ import annotations

import math
import time

import numpy as np

from .selection import SelectionAlgorithm, placeholder_selection
from .terrain import Terrain, load_terrain

TICK_S = 0.25
SPEEDUP = 16  # a 10 m/s drone covers 40 m per 250 ms tick
SURVEY_SPEED = 40  # m per tick
SCOUT_SPEED = 45
SWATH_M = 80
DRAIN_PER_M = {"Scout": 0.006, "Survey": 0.011}  # % battery per meter flown
RESERVE_PCT = 8
SWAP_TICKS = 8
DONE_COVERAGE = 0.97
SECTION_TARGET_M = 500


def _now_ms() -> int:
    return int(time.time() * 1000)


def _hyp(ax, ay, bx, by):
    return math.hypot(bx - ax, by - ay)


class SurveySession:
    def __init__(self, selection: SelectionAlgorithm | None = None, terrain: Terrain | None = None):
        self.terrain = terrain or load_terrain()
        self.selection = selection or placeholder_selection
        t = self.terrain
        n = t.cols * t.rows
        self.coverage = np.zeros(n, dtype=np.uint8)
        self.inside_mask = np.zeros(n, dtype=np.uint8)
        self.inside_cells = 0
        self.inside_mapped = 0
        self.sum = 0.0
        self.min = math.inf
        self.max = -math.inf
        self.coverage_version = 0
        self.color_range = {"min": 0.0, "max": 1.0}

        self.phase = "idle"
        self.distance_m = 1000
        self.launch = {"x": t.cols * t.cell_m / 2, "y": t.rows * t.cell_m / 2}
        self.max_distance_m = math.floor((min(t.cols, t.rows) * t.cell_m / 2 - 150) / 100) * 100
        self.perimeter: list[dict] = []
        self.perimeter_flown: list[dict] = []
        self.drones: list[dict] = []
        self.sections: list[dict] = []
        self.queue: list[str] = []
        self.events: list[dict] = []
        self._event_seq = 1
        self._reset_drones()
        self.log("info", f"New site. {'Real terrain loaded' if t.real else 'Synthetic terrain loaded'}; waiting to start the survey.")

    @property
    def heights(self) -> np.ndarray:
        return self.terrain.heights

    # ---------- public API ----------

    def set_distance(self, m: float) -> str:
        if self.phase != "idle":
            return "The survey distance can only be changed before the survey starts."
        self.distance_m = self._clamp_distance(m)
        return f"Survey distance set to {self.distance_m} m."

    def start_survey(self, distance_m: float | None = None) -> str:
        if self.phase != "idle":
            return 'A survey is already under way. Use "map more" to extend it.'
        if distance_m is not None:
            self.distance_m = self._clamp_distance(distance_m)
        d = self.distance_m
        x, y = self.launch["x"], self.launch["y"]
        self.perimeter = [{"x": x - d, "y": y - d}, {"x": x + d, "y": y - d}, {"x": x + d, "y": y + d}, {"x": x - d, "y": y + d}]
        self._build_inside_mask()
        self.color_range = self._range_inside()
        scout = next(dr for dr in self.drones if dr["role"] == "Scout")
        scout["mission"] = {
            "kind": "perimeter",
            "route": [{"x": x, "y": y - d}, {"x": x + d, "y": y - d}, {"x": x + d, "y": y + d}, {"x": x - d, "y": y + d}, {"x": x - d, "y": y - d}, {"x": x, "y": y - d}],
        }
        scout["status"] = "outbound"
        scout["task"] = f"Flying out {d} m to the boundary"
        self.phase = "scouting"
        self.log("info", f"Survey started. Scout drone heading {d} m out to trace the site boundary.")
        return f"Survey started. The scout drone is flying {d} m out to trace the boundary; the survey drones launch once it closes the loop."

    def request_sections(self, ids: list[str]) -> str:
        if self.phase == "idle":
            return "Start the survey first."
        if self.phase == "locked":
            return "The survey is locked for buildup."
        if self.phase == "scouting":
            return "Wait for the scout to finish the boundary first."
        known = {s["id"]: s for s in self.sections}
        valid = [i.upper() for i in ids if i.upper() in known]
        if not valid:
            return f"No section called {', '.join(ids)}. Sections run {self.sections[0]['id']} to {self.sections[-1]['id']}."
        fresh = [i for i in valid if known[i]["coverage"] < DONE_COVERAGE and known[i]["status"] != "mapping" and i not in self.queue]
        if not fresh:
            return f"{', '.join(valid)} {'are' if len(valid) > 1 else 'is'} already mapped or in progress."
        self.queue.extend(fresh)
        for i in fresh:
            known[i]["status"] = "queued"
        self.phase = "surveying"
        self.log("info", f"Mapping requested for {', '.join(fresh)}.")
        self._dispatch()
        busy = [i for i in self.queue if i in fresh]
        if busy:
            return f"Queued {', '.join(fresh)}. {', '.join(busy)} will start as soon as drones are free."
        return f"Sending drones to {', '.join(fresh)}."

    def map_more(self) -> str:
        ids = self.suggestions()[: max(1, len(self.drones) - 1)]
        if not ids:
            return "Everything inside the boundary is already mapped."
        return self.request_sections(ids)

    def recall_all(self) -> str:
        if self.phase == "idle":
            return "No drones are flying."
        self.queue = []
        for d in self.drones:
            if d["status"] in ("docked", "swapping"):
                continue
            d["mission"] = None
            self._send_home(d, "Recalled to launch point")
        for s in self.sections:
            if s["status"] == "queued":
                s["status"] = "unassigned"
        self.log("warn", "All drones recalled to the launch point.")
        return "Recalling all drones to the launch point."

    def lock(self) -> str:
        if self.phase in ("idle", "scouting"):
            return "Finish at least the boundary and one mapping pass before moving to buildup."
        if self.phase == "locked":
            return "The survey is already locked for buildup."
        if self.phase == "surveying":
            self.recall_all()
        self.phase = "locked"
        pct = round(self.stats()["coverage"] * 100)
        self.log("info", f"Survey locked at {pct}% coverage. Terrain model handed to buildup planning.")
        return f"Survey locked with {pct}% of the site mapped. The terrain model is ready for buildup planning."

    def elevation_at(self, x: float, y: float) -> float | None:
        t = self.terrain
        c, r = math.floor(x / t.cell_m), math.floor(y / t.cell_m)
        if c < 0 or r < 0 or c >= t.cols or r >= t.rows:
            return None
        i = r * t.cols + c
        return float(t.heights[i]) if self.coverage[i] else None

    # ---------- simulation ----------

    def tick(self) -> None:
        for d in self.drones:
            self._step_drone(d)
        self._update_sections()
        self._dispatch()
        if self.phase == "surveying" and not self.queue and not any(d["mission"] and d["mission"]["kind"] == "section" for d in self.drones):
            self.phase = "review"
            pct = round(self.stats()["coverage"] * 100)
            self.log("info", f"Mapping pass complete: {pct}% of the site mapped. Map more or move forward with buildup.")

    def _step_drone(self, d: dict) -> None:
        if d["status"] == "swapping":
            d["swapLeft"] -= 1
            if d["swapLeft"] <= 0:
                d["battery"] = 100.0
                d["status"] = "docked"
                d["task"] = "Battery swapped" if d["mission"] else "Ready"
                if d["mission"]:
                    self._resume_mission(d)
            return
        if d["status"] == "docked":
            if d["battery"] < 95 and not d["mission"]:
                self._begin_swap(d)
            return
        home = _hyp(d["x"], d["y"], self.launch["x"], self.launch["y"])
        if d["status"] != "returning" and d["battery"] - home * DRAIN_PER_M[d["role"]] < RESERVE_PCT:
            self.log("info", f"{d['id']} low on battery ({round(d['battery'])}%); returning to swap and resume.")
            self._send_home(d, "Returning to swap battery")
            return
        target = d["target"] or (d["mission"]["route"][0] if d["mission"] and d["mission"]["route"] else None)
        if not target:
            return
        speed = SCOUT_SPEED if d["role"] == "Scout" else SURVEY_SPEED
        fx, fy = d["x"], d["y"]
        arrived = self._move_toward(d, target, speed)
        flown = _hyp(fx, fy, d["x"], d["y"])
        d["battery"] = max(0.0, d["battery"] - flown * DRAIN_PER_M[d["role"]])
        if d["status"] in ("perimeter", "mapping"):
            self._mark_swath(fx, fy, d["x"], d["y"])
        if d["status"] == "perimeter":
            self.perimeter_flown.append({"x": d["x"], "y": d["y"]})
        if arrived:
            self._arrive(d)

    def _arrive(self, d: dict) -> None:
        if d["status"] == "returning":
            d["target"] = None
            d.update(self._dock_point(d))
            if d["mission"] or d["battery"] < 95:
                self._begin_swap(d)
            else:
                d["status"] = "docked"
                d["task"] = "Ready"
            return
        m = d["mission"]
        if d["status"] == "outbound":
            d["target"] = None
            d["status"] = "perimeter" if m["kind"] == "perimeter" else "mapping"
            if m["kind"] == "perimeter":
                self.perimeter_flown.append({"x": d["x"], "y": d["y"]})
                d["task"] = "Tracing the site boundary"
            else:
                d["task"] = f"Mapping section {m['sectionId']}"
            if m["route"] and _hyp(d["x"], d["y"], m["route"][0]["x"], m["route"][0]["y"]) < 1:
                m["route"].pop(0)
            return
        m["route"].pop(0)
        if m["route"]:
            return
        d["mission"] = None
        d["sectionId"] = None
        if m["kind"] == "perimeter":
            self.log("info", f"{d['id']} closed the boundary loop ({self.distance_m * 8 / 1000:.1f} km). Splitting the site into sections.")
            self._send_home(d, "Boundary done; returning")
            self._create_sections()
            self.phase = "surveying"
            self._assign("initial", [])
        else:
            self.log("info", f"{d['id']} finished section {m['sectionId']}.")
            self._send_home(d, f"Finished {m['sectionId']}; returning")

    def _resume_mission(self, d: dict) -> None:
        route = d["mission"]["route"]
        if not route:
            d["mission"] = None
            return
        d["status"] = "outbound"
        d["target"] = route[0]
        d["task"] = "Resuming the boundary" if d["mission"]["kind"] == "perimeter" else f"Resuming section {d['mission']['sectionId']}"

    def _begin_swap(self, d: dict) -> None:
        d["status"] = "swapping"
        d["swapLeft"] = SWAP_TICKS
        d["task"] = "Swapping battery"

    def _send_home(self, d: dict, task: str) -> None:
        # Keep the mission so the drone resumes where it left off.
        if d["mission"] and d["status"] != "outbound":
            d["mission"]["route"].insert(0, {"x": d["x"], "y": d["y"]})
        d["status"] = "returning"
        d["target"] = self._dock_point(d)
        d["task"] = task

    def _dock_point(self, d: dict) -> dict:
        i = self.drones.index(d)
        return {"x": self.launch["x"] - 40 + i * 20, "y": self.launch["y"] + 25}

    @staticmethod
    def _move_toward(d: dict, t: dict, speed: float) -> bool:
        dist = _hyp(d["x"], d["y"], t["x"], t["y"])
        if dist > 0.01:
            d["heading"] = math.degrees(math.atan2(t["y"] - d["y"], t["x"] - d["x"]))
        if dist <= speed:
            d["x"], d["y"] = t["x"], t["y"]
            return True
        d["x"] += (t["x"] - d["x"]) / dist * speed
        d["y"] += (t["y"] - d["y"]) / dist * speed
        return False

    def _mark_swath(self, ax: float, ay: float, bx: float, by: float) -> None:
        """Reveal every cell within half a swath of the segment the drone just flew."""
        t = self.terrain
        cols, rows, cell = t.cols, t.rows, t.cell_m
        length = _hyp(ax, ay, bx, by)
        steps = max(1, math.ceil(length / (cell / 2)))
        r = SWATH_M / 2
        rc = math.ceil(r / cell)
        changed = False
        cov, inside, h = self.coverage, self.inside_mask, t.heights
        for s in range(steps + 1):
            px = ax + (bx - ax) * s / steps
            py = ay + (by - ay) * s / steps
            c0, r0 = math.floor(px / cell), math.floor(py / cell)
            for dr in range(-rc, rc + 1):
                rr = r0 + dr
                if rr < 0 or rr >= rows:
                    continue
                cy = (rr + 0.5) * cell
                for dc in range(-rc, rc + 1):
                    c = c0 + dc
                    if c < 0 or c >= cols:
                        continue
                    cx = (c + 0.5) * cell
                    if (cx - px) ** 2 + (cy - py) ** 2 > r * r:
                        continue
                    i = rr * cols + c
                    if cov[i]:
                        continue
                    cov[i] = 1
                    changed = True
                    if inside[i]:
                        v = float(h[i])
                        self.inside_mapped += 1
                        self.sum += v
                        self.min = min(self.min, v)
                        self.max = max(self.max, v)
        if changed:
            self.coverage_version += 1

    # ---------- sections & selection ----------

    def _create_sections(self) -> None:
        k = min(6, max(2, round(self.distance_m * 2 / SECTION_TARGET_M)))
        nw = self.perimeter[0]
        size = self.distance_m * 2 / k
        self.sections = [
            {"id": f"{chr(65 + r)}{c + 1}", "x": nw["x"] + c * size, "y": nw["y"] + r * size, "w": size, "h": size, "coverage": 0.0, "status": "unassigned", "assignedTo": []}
            for r in range(k)
            for c in range(k)
        ]
        self._update_sections()

    def _update_sections(self) -> None:
        t = self.terrain
        grid = self.coverage.reshape(t.rows, t.cols)
        for s in self.sections:
            c0 = max(0, math.floor(s["x"] / t.cell_m))
            c1 = math.floor((s["x"] + s["w"]) / t.cell_m)
            r0 = max(0, math.floor(s["y"] / t.cell_m))
            r1 = math.floor((s["y"] + s["h"]) / t.cell_m)
            block = grid[r0:r1, c0:c1]
            s["coverage"] = float(block.mean()) if block.size else 0.0
            crew = [d["id"] for d in self.drones if d["mission"] and d["mission"]["kind"] == "section" and d["mission"]["sectionId"] == s["id"]]
            s["assignedTo"] = crew
            s["status"] = "mapping" if crew else "done" if s["coverage"] >= DONE_COVERAGE else "queued" if s["id"] in self.queue else "unassigned"

    def _free_drones(self) -> list[dict]:
        return [d for d in self.drones if d["status"] == "docked" and not d["mission"] and d["battery"] >= 95]

    def _dispatch(self) -> None:
        if not self.queue or self.phase != "surveying" or not self._free_drones():
            return
        self._assign("requested", list(self.queue))

    def _assign(self, mode: str, requested: list[str]) -> None:
        free = self._free_drones()
        if not free:
            return
        assignments = self.selection(
            {
                "mode": mode,
                "launch": dict(self.launch),
                "perimeter": [dict(p) for p in self.perimeter],
                "sections": [{k: s[k] for k in ("id", "x", "y", "w", "h", "coverage")} for s in self.sections],
                "drones": [{"id": d["id"], "x": d["x"], "y": d["y"], "battery": d["battery"]} for d in free],
                "swathM": SWATH_M,
                "requestedSectionIds": requested,
            }
        )
        by_id = {d["id"]: d for d in self.drones}
        for a in assignments:
            d = by_id.get(a["droneId"])
            if not d or not a["waypoints"]:
                continue
            route = [{"x": p["x"], "y": p["y"]} for p in a["waypoints"]]
            d["mission"] = {"kind": "section", "sectionId": a["sectionId"], "route": route}
            d["sectionId"] = a["sectionId"]
            d["status"] = "outbound"
            d["target"] = dict(route[0])
            d["task"] = f"Flying to section {a['sectionId']}"
            self.queue = [i for i in self.queue if i != a["sectionId"]]
        ids = list(dict.fromkeys(a["sectionId"] for a in assignments))
        if ids:
            self.log("info", f"Selection assigned {', '.join(ids)} to {', '.join(a['droneId'] for a in assignments)}.")
        self._update_sections()

    def suggestions(self) -> list[str]:
        cands = [s for s in self.sections if s["coverage"] < DONE_COVERAGE and s["status"] not in ("mapping", "queued")]
        # Prefer sections touching mapped ground, then the closest to the launch point.
        cands.sort(key=lambda s: (-self._touches_mapped(s), self._dist_launch(s)))
        return [s["id"] for s in cands]

    def _touches_mapped(self, s: dict) -> int:
        for o in self.sections:
            if o is s or o["coverage"] < DONE_COVERAGE:
                continue
            if abs(o["x"] - s["x"]) <= s["w"] + 1 and abs(o["y"] - s["y"]) <= s["h"] + 1 and (o["x"] == s["x"] or o["y"] == s["y"]):
                return 1
        return 0

    def _dist_launch(self, s: dict) -> float:
        return _hyp(s["x"] + s["w"] / 2, s["y"] + s["h"] / 2, self.launch["x"], self.launch["y"])

    # ---------- helpers ----------

    def _reset_drones(self) -> None:
        ids = [("SC-1", "Scout"), ("SV-1", "Survey"), ("SV-2", "Survey"), ("SV-3", "Survey"), ("SV-4", "Survey")]
        self.drones = [
            {"id": i, "role": role, "x": 0.0, "y": 0.0, "heading": -90.0, "battery": 100.0, "status": "docked", "task": "Ready", "swapLeft": 0, "mission": None, "target": None, "sectionId": None}
            for i, role in ids
        ]
        for d in self.drones:
            d.update(self._dock_point(d))

    def _clamp_distance(self, m: float) -> int:
        return int(max(300, min(self.max_distance_m, round(m / 50) * 50)))

    def _cell_centers(self):
        t = self.terrain
        cx = (np.arange(t.cols) + 0.5) * t.cell_m
        cy = (np.arange(t.rows) + 0.5) * t.cell_m
        return cx, cy

    def _build_inside_mask(self) -> None:
        nw, _, se, _ = self.perimeter
        cx, cy = self._cell_centers()
        mask = ((cy >= nw["y"]) & (cy <= se["y"]))[:, None] & ((cx >= nw["x"]) & (cx <= se["x"]))[None, :]
        self.inside_mask = mask.astype(np.uint8).ravel()
        self.inside_cells = int(self.inside_mask.sum())

    def _range_inside(self) -> dict:
        h = self.terrain.heights[self.inside_mask == 1]
        lo, hi = float(h.min()), float(h.max())
        return {"min": lo, "max": hi if hi > lo else lo + 1}

    def stats(self) -> dict:
        cell2 = self.terrain.cell_m**2
        m = self.inside_mapped
        return {
            "perimeterAreaKm2": self.inside_cells * cell2 / 1e6,
            "mappedAreaKm2": m * cell2 / 1e6,
            "coverage": m / self.inside_cells if self.inside_cells else 0.0,
            "minM": self.min if m else None,
            "maxM": self.max if m else None,
            "meanM": self.sum / m if m else None,
        }

    def log(self, level: str, text: str) -> None:
        self.events.insert(0, {"id": self._event_seq, "at": _now_ms(), "level": level, "text": text})
        self._event_seq += 1
        del self.events[200:]

    def snapshot(self) -> dict:
        return {
            "now": _now_ms(),
            "phase": self.phase,
            "distanceM": self.distance_m,
            "maxDistanceM": self.max_distance_m,
            "launch": dict(self.launch),
            "perimeter": [dict(p) for p in self.perimeter],
            "perimeterFlown": list(self.perimeter_flown),
            "drones": [
                {k: d[k] for k in ("id", "role", "x", "y", "heading", "status", "task")} | {"battery": round(d["battery"]), "sectionId": d["sectionId"]}
                for d in self.drones
            ],
            "sections": [{**s, "assignedTo": list(s["assignedTo"])} for s in self.sections],
            "suggestions": self.suggestions() if self.phase == "review" else [],
            "stats": self.stats(),
            "colorRange": dict(self.color_range),
            "events": list(self.events),
            "coverageVersion": self.coverage_version,
            "speedup": SPEEDUP,
            "terrain": self.terrain.info(),
        }
