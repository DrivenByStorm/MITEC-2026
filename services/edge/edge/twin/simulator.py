"""Simulated construction of an approved buildup plan, from bare ground to installed units.

It keeps two copies of the world:
  - truth: where things really are and what they are really doing;
  - reported: what the digital twin has actually heard over the radio.
Reports only arrive while an asset has a network path to the gateway, so an asset that
loses coverage freezes (goes stale) on the map, keeps working, and flushes its queued
results when it reconnects (store-and-forward). The relays, fleet and crew are exactly
the ones the buildup planner chose.

To use live data instead, replace this class with one that fills the same snapshot from
real reports (Meshtastic / ChirpStack / Zenoh adapters on the edge server).
"""

from __future__ import annotations

import math
import re
import time

from .network import ASSET_RANGE_M, LORA_RANGE_M, RELAY_RANGE_M

TICK_S = 1.0
PROXIMITY_STOP_M = 12
SITE_NAME = "New site, Pecos County TX"

SURNAMES = ["Reyes", "Okafor", "Lindqvist", "Ortiz", "Patel", "Begay", "Nguyen", "Castillo", "Hale", "Andrade", "Whitehorse", "Kowalski", "Mensah", "Duarte", "Ibarra", "Sato", "Haddad", "Morales", "Becker", "Yazzie", "Ferreira", "Ochoa", "Brennan", "Vargas", "Chen", "Silva", "Tran", "Navarro", "Abbott", "Romero", "Kaur", "Delgado", "Murphy", "Salazar", "Novak", "Aguilar", "Jensen", "Fuentes", "Rossi", "Garza"]
INITIALS = "ABCDEFGHJKLMNPRSTW"


def _now_ms() -> int:
    return int(time.time() * 1000)


def dist(ax, ay, bx, by) -> float:
    return math.hypot(ax - bx, ay - by)


class _Rand:
    def __init__(self, seed: int):
        self.s = seed

    def __call__(self) -> float:
        self.s = (self.s * 1664525 + 1013904223) % 4294967296
        return self.s / 4294967296


class SimulatedSite:
    def __init__(self, plan: dict):
        self.plan = plan
        self.rand = _Rand(7)
        self.tick_count = 0
        self.truth: dict[str, dict] = {}
        self.reported: dict[str, dict] = {}
        self.links: list[dict] = []
        self.events: list[dict] = []
        self.requests: list[dict] = []
        self._event_seq = 1
        self._request_seq = 1
        self.proximity_cooldown: dict[str, int] = {}
        self.uplink = {"online": True, "lastSync": _now_ms()}
        self.last_installed: dict | None = None
        self.complete_logged = False
        self.reachable_relays: set[str] = set()
        o = plan["office"]
        self.edge_server = {"x": o["x"] + o["w"] - 30, "y": o["y"] + 45, "online": True}
        self.rtk_base = {"x": o["x"] + o["w"] - 30, "y": o["y"] + o["h"] - 30, "online": True}
        L = plan["laydown"]
        self.laydown_pt = {"x": L["x"] + L["w"] / 2, "y": L["y"] + L["h"] / 2}

        self.blocks = [{k: b[k] for k in ("id", "x", "y", "w", "h", "rows", "slots")} for b in plan["blocks"]]
        self.block_order = [b["id"] for b in plan["blocks"]]
        self.truth_units = [{**u, "status": "planned"} for u in plan["units"]]
        self.unit_by_id = {u["id"]: u for u in self.truth_units}
        self.reported_units = [dict(u) for u in self.truth_units]
        self.reported_unit_by_id = {u["id"]: u for u in self.reported_units}

        self._build_assets()
        self._compute_network()
        now = _now_ms()
        for t in self.truth.values():
            self._report(t, now, "lora" if t["kind"] == "worker" else "mesh")
        nb = len(plan["blocks"])
        self.log("info", f"Construction started: {len(plan['units'])} P3 units in {nb} block{'' if nb == 1 else 's'}, {len(plan['relays'])} relays, crew of {plan['crewUsed']}.")

    # ---------- public API (all actions return a plain-language result) ----------

    def pause(self, asset_id: str) -> str:
        t = self.truth.get(asset_id.upper())
        if not t:
            return f"No asset called {asset_id}."
        if t["kind"] in ("worker", "relay"):
            return f"{t['name']} is not a machine and can't be paused."
        if t["mode"] == "paused":
            return f"{t['name']} is already paused."
        t["mode"] = "paused"
        self.log("warn", f"{t['name']} paused by build manager.", t["id"])
        self._force_report(t)
        return f"Paused {t['name']}. It will hold position until you resume it."

    def resume(self, asset_id: str) -> str:
        t = self.truth.get(asset_id.upper())
        if not t:
            return f"No asset called {asset_id}."
        if t["mode"] != "paused":
            return f"{t['name']} isn't paused (it is {t['mode']})."
        t["mode"] = "manual" if t.get("requestId") else t["baseMode"]
        self.log("info", f"{t['name']} resumed by build manager.", t["id"])
        self._force_report(t)
        return f"Resumed {t['name']}."

    def pause_all_robots(self) -> str:
        robots = [t for t in self.truth.values() if t["kind"] in ("robot", "drone")]
        for t in robots:
            t["mode"] = "paused"
            self._force_report(t)
        self.log("alert", f"All robots paused by build manager ({len(robots)}).")
        return f"Paused all {len(robots)} robots and drones."

    def create_request(self, need: str, target_text: str, requested_by: str = "Build manager") -> str:
        target = self.resolve_target(target_text)
        if not target:
            return f"I couldn't find a place called {target_text}. Try a unit (C-03-07), a block and row (B7), a block (block B), laydown, office, or an asset name."
        req = {
            "id": f"REQ-{self._request_seq:03d}",
            "createdAt": _now_ms(),
            "requestedBy": requested_by,
            "need": need,
            "target": target,
            "status": "pending",
            "assignedTo": None,
            "eta": None,
        }
        self._request_seq += 1
        self.requests.insert(0, req)
        self.log("info", f"{req['id']}: {need} requested at {target['label']} by {requested_by}.")
        self._assign_request(req)
        if req["assignedTo"]:
            return f"{req['id']} created: {self.truth[req['assignedTo']]['name']} is heading to {target['label']} (ETA {req['eta']} s)."
        return f"{req['id']} created and queued; nothing suitable is free right now."

    def cancel_request(self, req_id: str) -> str:
        req = next((r for r in self.requests if r["id"] == req_id.upper()), None)
        if not req:
            return f"No request called {req_id}."
        if req["status"] in ("done", "cancelled"):
            return f"{req['id']} is already {req['status']}."
        req["status"] = "cancelled"
        if req["assignedTo"] and req["assignedTo"] in self.truth:
            self._release_from_request(self.truth[req["assignedTo"]])
        self.log("info", f"{req['id']} cancelled.")
        return f"Cancelled {req['id']}."

    def resolve_target(self, text: str) -> dict | None:
        """Resolve "B7" / "block B row 7" / "C-03-07" / "laydown" / an asset name into map coordinates."""
        s = text.strip().upper()
        u = self.unit_by_id.get(s)
        if u:
            return {"label": u["id"], "x": u["x"], "y": u["y"] + 10}
        if "LAYDOWN" in s:
            return {"label": "laydown yard", **self.laydown_pt}
        o = self.plan["office"]
        if "OFFICE" in s:
            return {"label": "site office", "x": o["x"] + o["w"] / 2, "y": o["y"] + o["h"] / 2}
        m = re.match(r"^(?:BLOCK\s*)?([A-Z]{1,2})\s*-?\s*(?:ROW\s*)?(\d{1,2})$", s) or re.match(r"^ROW\s*(\d{1,2})\s*(?:OF\s*)?(?:BLOCK\s*)?([A-Z]{1,2})$", s)
        if m:
            a, b = m.group(1), m.group(2)
            block_id, row_s = (b, a) if a.isdigit() else (a, b)
            row = [x for x in self.truth_units if x["block"] == block_id and x["row"] == int(row_s)]
            if row:
                return {"label": f"block {block_id}, row {int(row_s)}", "x": sum(x["x"] for x in row) / len(row), "y": row[0]["y"] + 12}
        bm = re.match(r"^BLOCK\s*([A-Z]{1,2})$", s)
        if bm:
            b = next((x for x in self.blocks if x["id"] == bm.group(1)), None)
            if b:
                return {"label": f"block {b['id']}", "x": b["x"] + b["w"] / 2, "y": b["y"] + b["h"] + 6}
        a = next((t for t in self.truth.values() if t["name"].upper() == s or t["id"] == s), None)
        if a:
            return {"label": a["name"], "x": a["x"] + 15, "y": a["y"] + 15}
        return None

    # ---------- setup ----------

    def _add_truth(self, **p) -> None:
        t = {
            "heading": 0.0,
            "mode": "idle",
            "task": "Available",
            "energy": 65 + self.rand() * 30,
            "speed": 5,
            "dwell": 0,
            "holdUntil": 0,
            "wpIndex": 0,
            "outbox": [],
            "outEvents": [],
            "lastLoraReport": 0,
            "target": None,
            "waypoints": None,
            "block": None,
            "workUnit": None,
            "serves": None,
            "shuttleLeg": None,
            "requestId": None,
            "group": None,
            "anchorOffset": None,
            "inCab": False,
            "failedUntil": None,
            "lastVia": None,
        }
        t["baseMode"] = p.get("mode", "idle")
        t.update(p)
        self.truth[t["id"]] = t

    def _count(self, key: str) -> int:
        return next((f["count"] for f in self.plan["fleet"] if f["key"] == key), 0)

    def _parking(self, i: int) -> dict:
        L = self.plan["laydown"]
        per_row = max(1, math.floor((L["w"] - 30) / 32))
        return {"x": L["x"] + 20 + (i % per_row) * 32, "y": L["y"] + 30 + (i // per_row) * 28}

    def _build_assets(self) -> None:
        plan = self.plan
        for r in plan["relays"]:
            self._add_truth(id=r["id"], name=r["id"], kind="relay", role="Solar relay mast", x=r["x"], y=r["y"], mode="autonomous", task="Relaying", energy=70 + self.rand() * 30)
        g = plan["gateway"]
        self._add_truth(id="GW", name="Gateway", kind="relay", role="Gateway (wired to edge server)", x=g["x"], y=g["y"], mode="autonomous", task="Relaying", energy=100)

        park = 0
        n_pile, n_crane, n_th, n_tr = self._count("pile"), self._count("crane"), self._count("telehandler"), self._count("trencher")
        for i in range(1, n_pile + 1):
            self._add_truth(id=f"RPD-{i}", name=f"RPD-{i}", kind="robot", role="Pile driver", **self._parking(park), mode="autonomous", speed=9, task="Heading to first block")
            park += 1
        for i in range(1, n_crane + 1):
            self._add_truth(id=f"CR-{i}", name=f"CR-{i}", kind="machine", role="Crane", **self._parking(park), mode="manual", speed=7, task="Waiting for foundations")
            park += 1
        for i in range(1, n_th + 1):
            self._add_truth(id=f"TH-{i}", name=f"TH-{i}", kind="machine", role="Telehandler", **self._parking(park), mode="manual", speed=10, serves=f"CR-{(i - 1) % max(1, n_crane) + 1}", shuttleLeg="crane", task="Loading first unit")
            park += 1
        # Trenchers: split blocks between them; each runs a spine trench down the west edge of its blocks.
        for i in range(1, n_tr + 1):
            mine = [b for k, b in enumerate(plan["blocks"]) if k % n_tr == i - 1]
            wps = [p for b in mine for p in ({"x": b["x"] - 5, "y": b["y"]}, {"x": b["x"] - 5, "y": b["y"] + b["h"]})]
            self._add_truth(
                id=f"TR-{i}", name=f"TR-{i}", kind="machine", role="Trencher", **self._parking(park), mode="manual", speed=1.5,
                waypoints=wps or [dict(self.laydown_pt)], task=f"Trenching block{'s' if len(mine) > 1 else ''} {', '.join(b['id'] for b in mine)}",
            )
            park += 1
        # Drone: back-and-forth progress survey over the planned area.
        xs = [u["x"] for u in plan["units"]]
        ys = [u["y"] for u in plan["units"]]
        if self._count("drone") and xs:
            x0, x1, y0, y1 = min(xs) - 20, max(xs) + 20, min(ys) - 20, max(ys) + 20
            lanes = max(2, round((y1 - y0) / 70))
            wps = []
            for k in range(lanes + 1):
                y = y0 + (y1 - y0) * k / lanes
                wps += [{"x": x1, "y": y}, {"x": x0, "y": y}] if k % 2 else [{"x": x0, "y": y}, {"x": x1, "y": y}]
            o = plan["office"]
            self._add_truth(id="DR-1", name="DR-1", kind="drone", role="Survey drone", x=o["x"] + 20, y=o["y"] + 20, mode="autonomous", speed=14, waypoints=wps, task="Daily progress survey")

        # Crew: every person the plan calls for, attached to the machine or job they work on.
        w = 0

        def add_worker(role: str, group: str, in_cab: bool = False):
            nonlocal w
            wid = f"W-{w + 1:02d}"
            name = f"{INITIALS[(w * 7) % len(INITIALS)]}. {SURNAMES[w % len(SURNAMES)]}"
            w += 1
            a = self.rand() * math.pi * 2
            r = 32 + self.rand() * 20  # crews work outside the machine's swing/stop zone
            ox, oy = math.cos(a) * r, math.sin(a) * r
            start = self._anchor_for(group, {"x": ox, "y": oy})
            self._add_truth(id=wid, name=name, kind="worker", role=role, x=start["x"], y=start["y"], mode="manual", speed=4, group=group,
                            anchorOffset={"x": 0, "y": 0} if in_cab else {"x": ox, "y": oy}, inCab=in_cab, task=role, energy=55 + self.rand() * 45)

        for r in plan["crew"]:
            for k in range(r["count"]):
                role = r["role"]
                if role in ("Robot operator", "Pile loader"):
                    add_worker(role, f"RPD-{k % max(1, n_pile) + 1}")
                elif role == "Crane operator":
                    add_worker(role, f"CR-{k % max(1, n_crane) + 1}", True)
                elif role in ("Rigger", "Signal person"):
                    add_worker(role, f"CR-{k % max(1, n_crane) + 1}")
                elif role == "Telehandler operator":
                    add_worker(role, f"TH-{k % max(1, n_th) + 1}", True)
                elif role == "Trencher operator":
                    add_worker(role, f"TR-{k % max(1, n_tr) + 1}", True)
                elif role == "Trench laborer":
                    add_worker(role, f"TR-{k % max(1, n_tr) + 1}")
                elif role == "Electrician":
                    add_worker(role, "electrical")
                elif role == "Drone pilot":
                    add_worker(role, "office")
                else:
                    add_worker(role, "roam")

    def _anchor_for(self, group: str, off: dict) -> dict:
        m = self.truth.get(group)
        if m:
            return {"x": m["x"] + off["x"], "y": m["y"] + off["y"]}
        o = self.plan["office"]
        if group == "office":
            return {"x": o["x"] + o["w"] / 2 + off["x"] * 0.6, "y": o["y"] + o["h"] / 2 + off["y"] * 0.4}
        if group == "electrical":
            p = self.last_installed or {"x": o["x"] + o["w"] / 2, "y": o["y"] + o["h"] / 2}
            return {"x": p["x"] + off["x"] * 1.5, "y": p["y"] + off["y"]}
        b = self.plan["bounds"]  # roamers drift around the active area
        ph = self.tick_count / 60
        return {"x": b["x"] + b["w"] / 2 + math.cos(ph) * b["w"] * 0.3 + off["x"], "y": b["y"] + b["h"] / 2 + math.sin(ph * 1.3) * b["h"] * 0.3 + off["y"]}

    # ---------- simulation ----------

    def tick(self) -> None:
        self.tick_count += 1
        now = _now_ms()
        self._update_relays(now)
        self._compute_network()
        for t in self.truth.values():
            if t["kind"] != "relay":
                self._step_asset(t, now)
        self._check_proximity(now)
        self._update_requests()
        self._deliver_reports(now)
        self._update_uplink(now)
        self._check_complete()

    def _check_complete(self) -> None:
        if self.complete_logged or not self.truth_units:
            return
        if all(u["status"] == "installed" for u in self.reported_units):
            self.complete_logged = True
            self.log("info", f"All {len(self.reported_units)} P3 units set. Construction complete; electrical commissioning continues.")

    def _update_relays(self, now: int) -> None:
        # Scripted demo: 40 s in, the relay RPD-1 is using fails. Redundant coverage should carry it.
        if self.tick_count == 40:
            rep = self.reported.get("RPD-1")
            via = rep and rep.get("via")
            relay = self.truth.get(via) if via and via != "GW" else next((t for t in self.truth.values() if t["kind"] == "relay" and t["id"] != "GW"), None)
            if relay:
                self._fail_relay(relay, now, 50)
        for t in self.truth.values():
            if t["kind"] != "relay" or t["id"] == "GW":
                continue
            if not t["failedUntil"] and self.tick_count > 120 and self.rand() < 0.0006:
                self._fail_relay(t, now, 40 + self.rand() * 40)
            if t["failedUntil"] and now >= t["failedUntil"]:
                t["failedUntil"] = None
                t["mode"] = "autonomous"
                t["task"] = "Relaying"
                self.log("info", f"{t['name']} is back online. Mesh routes restored.", t["id"])
            t["energy"] = max(5, min(100, t["energy"] + (self.rand() - 0.52) * 0.4))

    def _fail_relay(self, t: dict, now: int, seconds: float) -> None:
        if t["failedUntil"]:
            return
        t["failedUntil"] = now + seconds * 1000
        t["mode"] = "offline"
        t["task"] = "No heartbeat"
        self.log("alert", f"{t['name']} stopped sending heartbeats. Traffic is rerouting around it.", t["id"])

    def _step_asset(self, t: dict, now: int) -> None:
        if t["inCab"]:
            m = self.truth.get(t["group"])
            if m:
                t["x"], t["y"] = m["x"], m["y"]
            return
        if t["mode"] == "paused" or self.tick_count < t["holdUntil"]:
            return
        t["energy"] = max(8, t["energy"] - (0.01 if t["kind"] == "worker" else 0.03))
        # A crane or trencher answering a request drives there (in _update_requests) instead of its usual work.
        if t["requestId"] and t["role"] != "Telehandler":
            return
        role = t["role"]
        if role == "Pile driver":
            self._step_pile_driver(t, now)
        elif role == "Crane":
            self._step_crane(t, now)
        elif role == "Telehandler":
            self._step_telehandler(t)
        elif role in ("Trencher", "Survey drone"):
            self._step_waypoints(t)
        elif t["kind"] == "worker":
            self._step_worker(t)

    @staticmethod
    def _move_toward(t: dict, tx: float, ty: float) -> bool:
        d = dist(t["x"], t["y"], tx, ty)
        if d < 0.5:
            return True
        t["heading"] = math.degrees(math.atan2(ty - t["y"], tx - t["x"]))
        step = min(d, t["speed"])
        t["x"] += (tx - t["x"]) / d * step
        t["y"] += (ty - t["y"]) / d * step
        return d <= t["speed"]

    def _claimed(self, role: str, me: dict) -> set[str]:
        return {o["workUnit"] for o in self.truth.values() if o is not me and o["role"] == role and o["workUnit"]}

    def _step_pile_driver(self, t: dict, now: int) -> None:
        taken = self._claimed("Pile driver", t)
        unit = self.unit_by_id.get(t["workUnit"]) if t["workUnit"] else None
        if not unit or unit["status"] != "planned":
            t["workUnit"] = None
            t["dwell"] = 0
            # Stay in our block while it has work; otherwise take the next block nobody else is on.
            other_blocks = {o["block"] for o in self.truth.values() if o is not t and o["role"] == "Pile driver" and o["block"]}

            def has_work(b):
                return bool(b) and any(u["block"] == b and u["status"] == "planned" and u["id"] not in taken for u in self.truth_units)

            if not has_work(t["block"]):
                t["block"] = next((b for b in self.block_order if b not in other_blocks and has_work(b)), None) or next((b for b in self.block_order if has_work(b)), None)
            unit = next((u for u in self.truth_units if u["block"] == t["block"] and u["status"] == "planned" and u["id"] not in taken), None)
            t["workUnit"] = unit["id"] if unit else None
        if not unit:
            t["mode"] = "idle"
            t["task"] = "All foundations driven"
            return
        t["mode"] = "autonomous"
        if self._move_toward(t, unit["x"], unit["y"] + 7):
            t["task"] = f"Driving piles at {unit['id']}"
            t["dwell"] += 1
            if t["dwell"] >= 3:
                unit["status"] = "piled"
                t["outbox"].append({"unitId": unit["id"], "status": "piled", "at": now})
                if self.rand() < 0.05:
                    t["outEvents"].append({"level": "warn", "text": f"{t['name']} hit refusal at {unit['id']}; pile flagged for engineer review.", "at": now})
                t["workUnit"] = None
                t["dwell"] = 0
        else:
            t["task"] = f"Moving to {unit['id']}"

    def _step_crane(self, t: dict, now: int) -> None:
        taken = self._claimed("Crane", t)
        unit = self.unit_by_id.get(t["workUnit"]) if t["workUnit"] else None
        if not unit or unit["status"] != "piled":
            t["dwell"] = 0
            unit = None
            for u in self.truth_units:
                if u["status"] == "piled" and u["id"] not in taken and (unit is None or dist(t["x"], t["y"], u["x"], u["y"]) < dist(t["x"], t["y"], unit["x"], unit["y"])):
                    unit = u
            t["workUnit"] = unit["id"] if unit else None
        if not unit:
            t["mode"] = "idle"
            t["task"] = "All units set" if all(u["status"] == "installed" for u in self.truth_units) else "Waiting for foundations"
            return
        t["mode"] = "manual"
        if self._move_toward(t, unit["x"], unit["y"] + 14):
            t["task"] = f"Setting P3 unit {unit['id']}"
            t["dwell"] += 1
            if t["dwell"] >= 5:
                unit["status"] = "installed"
                self.last_installed = {"x": unit["x"], "y": unit["y"]}
                t["outbox"].append({"unitId": unit["id"], "status": "installed", "at": now})
                t["workUnit"] = None
                t["dwell"] = 0
        else:
            t["task"] = f"Moving to {unit['id']}"

    def _step_telehandler(self, t: dict) -> None:
        if t["requestId"]:
            t["mode"] = "manual"
            if t["target"]:
                self._move_toward(t, t["target"]["x"], t["target"]["y"])
            return
        crane = self.truth.get(t["serves"]) if t["serves"] else None
        if not crane or crane["mode"] == "idle":
            t["mode"] = "idle"
            t["task"] = "Available"
            self._move_toward(t, self.laydown_pt["x"] + 30, self.laydown_pt["y"])
            return
        to_crane = t["shuttleLeg"] == "crane"
        dest = {"x": crane["x"] + 20, "y": crane["y"] - 10} if to_crane else self.laydown_pt
        t["mode"] = "manual"
        if self._move_toward(t, dest["x"], dest["y"]):
            t["task"] = f"Handing unit to {crane['name']}" if to_crane else "Loading unit at laydown yard"
            t["dwell"] += 1
            if t["dwell"] >= 3:
                t["shuttleLeg"] = "laydown" if to_crane else "crane"
                t["dwell"] = 0
        else:
            t["task"] = f"Delivering P3 unit to {crane['name']}" if to_crane else "Returning to laydown yard"

    def _step_waypoints(self, t: dict) -> None:
        wps = t["waypoints"]
        wp = wps[t["wpIndex"] % len(wps)]
        if self._move_toward(t, wp["x"], wp["y"]):
            t["wpIndex"] = (t["wpIndex"] + 1) % len(wps)

    def _step_worker(self, t: dict) -> None:
        anchor = self._anchor_for(t["group"], t["anchorOffset"])
        tg = t["target"]
        if not tg or dist(t["x"], t["y"], tg["x"], tg["y"]) < 2 or self.rand() < 0.05:
            r = 3 + self.rand() * 10
            a = self.rand() * math.pi * 2
            t["target"] = {"x": anchor["x"] + math.cos(a) * r, "y": anchor["y"] + math.sin(a) * r}
        self._move_toward(t, t["target"]["x"], t["target"]["y"])

    def _check_proximity(self, now: int) -> None:
        """UWB proximity: acts locally on the machine, no network needed."""
        workers = [t for t in self.truth.values() if t["kind"] == "worker" and not t["inCab"]]
        movers = [t for t in self.truth.values() if t["kind"] in ("robot", "machine")]
        for m in movers:
            for w in workers:
                if dist(m["x"], m["y"], w["x"], w["y"]) > PROXIMITY_STOP_M:
                    continue
                key = f"{m['id']}:{w['id']}"
                if self.proximity_cooldown.get(key, 0) > self.tick_count:
                    continue
                self.proximity_cooldown[key] = self.tick_count + 120
                m["holdUntil"] = self.tick_count + 3
                m["outEvents"].append({"level": "warn", "text": f"Proximity stop: {m['name']} held for {w['name']} ({w['role']}).", "at": now})

    # ---------- requests ----------

    @staticmethod
    def _match_role(need: str) -> str:
        n = need.lower()
        if "crane" in n:
            return "Crane"
        if "trench" in n:
            return "Trencher"
        return "Telehandler"

    def _assign_request(self, req: dict) -> None:
        role = self._match_role(req["need"])
        tx, ty = req["target"]["x"], req["target"]["y"]
        cands = [t for t in self.truth.values() if t["role"] == role and not t["requestId"] and t["mode"] not in ("paused", "fault")]
        cands.sort(key=lambda t: (0 if t["mode"] == "idle" else 1, dist(t["x"], t["y"], tx, ty)))
        if not cands:
            self.log("warn", f"{req['id']}: no {role.lower()} available. Request is waiting in the queue.")
            return
        pick = cands[0]
        pick["requestId"] = req["id"]
        pick["target"] = {"x": tx, "y": ty}
        pick["workUnit"] = None
        pick["task"] = f"{req['id']}: heading to {req['target']['label']}"
        req["assignedTo"] = pick["id"]
        req["status"] = "assigned"
        req["eta"] = round(dist(pick["x"], pick["y"], tx, ty) / pick["speed"])
        self.log("info", f"{req['id']} assigned to {pick['name']} (ETA {req['eta']} s).", pick["id"])

    def _release_from_request(self, t: dict) -> None:
        t["requestId"] = None
        t["target"] = None
        t["dwell"] = 0
        t["mode"] = t["baseMode"]
        t["task"] = "Available"

    def _update_requests(self) -> None:
        for req in self.requests:
            if req["status"] == "pending":
                self._assign_request(req)
                continue
            if not req["assignedTo"] or req["status"] in ("done", "cancelled"):
                continue
            t = self.truth.get(req["assignedTo"])
            if not t:
                continue
            if t["role"] != "Telehandler" and t["target"] and t["mode"] != "paused":
                self._move_toward(t, t["target"]["x"], t["target"]["y"])
            d = dist(t["x"], t["y"], req["target"]["x"], req["target"]["y"])
            if req["status"] == "assigned":
                req["status"] = "en-route"
            if req["status"] == "en-route":
                req["eta"] = round(d / t["speed"])
                if d < 2:
                    req["status"] = "arrived"
                    t["task"] = f"{req['id']}: on station at {req['target']['label']}"
                    t["dwell"] = 0
                    self.log("info", f"{t['name']} arrived at {req['target']['label']} for {req['id']}.", t["id"])
            elif req["status"] == "arrived":
                t["dwell"] += 1
                if t["dwell"] >= 15:
                    req["status"] = "done"
                    self._release_from_request(t)
                    self.log("info", f"{req['id']} done. {t['name']} is available again.", t["id"])

    # ---------- network ----------

    @staticmethod
    def _relay_online(t: dict) -> bool:
        return t["kind"] == "relay" and t["mode"] != "offline"

    def _compute_network(self) -> None:
        relays = [t for t in self.truth.values() if self._relay_online(t)]
        links = []
        for i in range(len(relays)):
            for j in range(i + 1, len(relays)):
                d = dist(relays[i]["x"], relays[i]["y"], relays[j]["x"], relays[j]["y"])
                if d <= RELAY_RANGE_M:
                    links.append({"a": relays[i]["id"], "b": relays[j]["id"], "quality": max(0.2, 1 - d / RELAY_RANGE_M * 0.7)})
        reach = {"GW"}
        grew = True
        while grew:
            grew = False
            for l in links:
                if l["a"] in reach and l["b"] not in reach:
                    reach.add(l["b"])
                    grew = True
                if l["b"] in reach and l["a"] not in reach:
                    reach.add(l["a"])
                    grew = True
        self.reachable_relays = reach
        self.links = links

    def _best_relay(self, t: dict, rng: float) -> dict | None:
        best, best_d = None, math.inf
        for r in self.truth.values():
            if not self._relay_online(r) or r["id"] not in self.reachable_relays:
                continue
            d = dist(t["x"], t["y"], r["x"], r["y"])
            if d <= rng and d < best_d:
                best, best_d = r, d
        return best

    def _deliver_reports(self, now: int) -> None:
        rerouted = []
        for t in self.truth.values():
            if t["kind"] == "relay":
                if self._relay_online(t) and t["id"] in self.reachable_relays:
                    self._report(t, now, "mesh")
                else:
                    self._mark_link(t["id"], "none")
                continue
            if t["kind"] == "worker":
                tg = t["target"]
                moving = dist(t["x"], t["y"], tg["x"], tg["y"]) > 2 if tg else False
                relay = self._best_relay(t, LORA_RANGE_M)
                if relay and now - t["lastLoraReport"] >= (3000 if moving else 8000) and self.rand() < 0.9:
                    t["lastLoraReport"] = now
                    self._report(t, now, "lora", relay["id"])
                continue
            relay = self._best_relay(t, ASSET_RANGE_M)
            if not relay:
                self._mark_link(t["id"], "none")
                continue
            lv = t["lastVia"]
            if lv and lv != relay["id"] and self.truth.get(lv, {}).get("mode") == "offline":
                rerouted.append(f"{t['name']} via {relay['name']}")
            t["lastVia"] = relay["id"]
            if self.rand() < 0.94:
                self._report(t, now, "mesh", relay["id"])
        if rerouted:
            self.log("info", f"Rerouted around the failed relay with no loss of contact: {', '.join(rerouted)}. The plan's two-relay coverage at work.")

    def _mark_link(self, aid: str, link: str) -> None:
        r = self.reported.get(aid)
        if r and r["link"] != link:
            self.reported[aid] = {**r, "link": link, "via": None}

    def _force_report(self, t: dict) -> None:
        rep = self.reported.get(t["id"])
        self._report(t, _now_ms(), "lora" if t["kind"] == "worker" else "mesh", rep and rep.get("via"))

    def _report(self, t: dict, now: int, link: str, via: str | None = None) -> None:
        self.reported[t["id"]] = {
            "id": t["id"],
            "name": t["name"],
            "kind": t["kind"],
            "role": t["role"],
            "x": t["x"],
            "y": t["y"],
            "heading": t["heading"],
            "mode": t["mode"],
            "task": t["task"],
            "energy": round(t["energy"]),
            "lastHeard": now,
            "link": link,
            "via": via,
            "onSite": True if t["kind"] == "worker" else None,
            "inCab": True if t["inCab"] else None,
        }
        if t["outbox"]:
            delayed = now - t["outbox"][0]["at"] > 5000
            for item in t["outbox"]:
                u = self.reported_unit_by_id.get(item["unitId"])
                if u:
                    u["status"] = item["status"]
                verb = "drove piles" if item["status"] == "piled" else "set P3 unit"
                self.log("info", f"{t['name']} {verb} at {item['unitId']}.", t["id"], item["at"])
            if delayed:
                self.log("info", f"{t['name']} reconnected and synced {len(t['outbox'])} queued update(s).", t["id"])
            t["outbox"] = []
        for e in t["outEvents"]:
            self.log(e["level"], e["text"], t["id"], e["at"])
        t["outEvents"] = []

    def _update_uplink(self, now: int) -> None:
        if self.tick_count % 50 == 0:
            self.uplink["online"] = self.rand() > 0.35
            if not self.uplink["online"]:
                self.log("info", "Satellite uplink is down. Site keeps running; HQ sync will resume when it returns.")
        if self.uplink["online"] and self.tick_count % 30 == 0:
            self.uplink["lastSync"] = now

    # ---------- events & snapshot ----------

    def log(self, level: str, text: str, asset_id: str | None = None, at: int | None = None) -> None:
        self.events.insert(0, {"id": self._event_seq, "at": at or _now_ms(), "level": level, "text": text, "assetId": asset_id})
        self._event_seq += 1
        del self.events[250:]

    def snapshot(self) -> dict:
        t = self.plan["terrain"]
        return {
            "now": _now_ms(),
            "siteName": SITE_NAME,
            "site": {"w": t["cols"] * t["cellM"], "h": t["rows"] * t["cellM"]},
            "view": dict(self.plan["bounds"]),
            "office": dict(self.plan["office"]),
            "laydown": dict(self.plan["laydown"]),
            "blocks": self.blocks,
            "units": [dict(u) for u in self.reported_units],
            "assets": list(self.reported.values()),
            "links": [dict(l) for l in self.links],
            "edgeServer": dict(self.edge_server),
            "rtkBase": dict(self.rtk_base),
            "uplink": dict(self.uplink),
            "events": list(self.events),
            "requests": [{**r, "target": dict(r["target"])} for r in self.requests],
        }


def plan_preview(plan: dict) -> dict:
    """The plan as a twin snapshot (units as planned footprints, relays live) for the map."""
    now = plan["createdAt"]

    def relay(rid, x, y, role, name=None):
        return {"id": rid, "name": name or rid, "kind": "relay", "role": role, "x": x, "y": y, "heading": 0, "mode": "autonomous", "task": "Planned", "energy": 100, "lastHeard": now, "link": "mesh"}

    relays = [relay(r["id"], r["x"], r["y"], "Relay mast (link only)" if r["linkOnly"] else "Solar relay mast") for r in plan["relays"]]
    relays.append(relay("GW", plan["gateway"]["x"], plan["gateway"]["y"], "Gateway (wired to edge server)", "Gateway"))
    links = []
    for i in range(len(relays)):
        for j in range(i + 1, len(relays)):
            d = dist(relays[i]["x"], relays[i]["y"], relays[j]["x"], relays[j]["y"])
            if d <= RELAY_RANGE_M:
                links.append({"a": relays[i]["id"], "b": relays[j]["id"], "quality": max(0.2, 1 - d / RELAY_RANGE_M * 0.7)})
    o = plan["office"]
    t = plan["terrain"]
    return {
        "now": now,
        "siteName": SITE_NAME,
        "site": {"w": t["cols"] * t["cellM"], "h": t["rows"] * t["cellM"]},
        "view": plan["bounds"],
        "office": plan["office"],
        "laydown": plan["laydown"],
        "blocks": [{k: b[k] for k in ("id", "x", "y", "w", "h", "rows", "slots")} for b in plan["blocks"]],
        "units": [{**u, "status": "planned"} for u in plan["units"]],
        "assets": relays,
        "links": links,
        "edgeServer": {"x": o["x"] + o["w"] - 30, "y": o["y"] + 45, "online": True},
        "rtkBase": {"x": o["x"] + o["w"] - 30, "y": o["y"] + o["h"] - 30, "online": True},
        "uplink": {"online": True, "lastSync": now},
        "events": [],
        "requests": [],
    }
