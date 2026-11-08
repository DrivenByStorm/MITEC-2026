"""The site twin: one object that owns every stage and every action.

    survey        drones build the terrain model from scratch (simulated here)
    buildup       the planner lays out the units the build manager asked for and sizes the fleet
    construction  the approved plan is built: the site mesh (packages/mesh) runs it, and this
                  service acts as the hub's planning software and the twin's backend

Every change to the site goes through `run_action`, whether it comes from a UI button (the build
manager acting directly) or from an agent suggestion the manager approved. The agent itself can
only read state and propose actions. Construction actions become supervisor commands sent by the
hub on behalf of the build manager (spec 12.3).
"""

from __future__ import annotations

import base64
import re

import numpy as np

from .buildup.assumptions import ASSUMPTIONS
from .buildup.planner import PlannerContext, plan_site
from .buildup.preview import plan_preview
from .mesh_client import MeshClient
from .meshsite import Frame, build_sim_input
from .survey.selection import SelectionAlgorithm, load_selection
from .survey.session import SurveySession
from .twin.network import COVERAGE_RADIUS_M, COVERAGE_TOLERANCE_M, RELAY_RANGE_M, ROBOT_RANGE_M, UWB_RANGE_M


class ActionError(Exception):
    pass


ZONE_KINDS = {"NO_GO": 1, "CRANE": 2, "WORK_AREA": 3, "ROBOT_WORK": 4}

# name -> (stage, description for the agent and UI, args, agent may propose it)
ACTIONS: dict[str, tuple[str, str, dict, bool]] = {
    "survey.setDistance": ("survey", "Set how far the scout drone flies out before the survey starts (meters).", {"m": "number"}, True),
    "survey.start": ("survey", "Start the survey: the scout traces a square boundary this far from the launch point (meters), then the survey drones map it.", {"distanceM": "number (optional)"}, True),
    "survey.requestSections": ("survey", "Send survey drones to map specific sections, e.g. ['B3','C4'].", {"ids": "string[]"}, True),
    "survey.mapMore": ("survey", "Send drones to the best suggested unmapped gaps.", {}, True),
    "survey.recall": ("survey", "Recall every drone to the launch point.", {}, True),
    "survey.lock": ("survey", "Accept the survey and hand the terrain model to buildup planning.", {}, True),
    "plan.generate": ("buildup", "Generate (or regenerate) the buildup plan for a number of P3 units and the crew available.", {"unitCount": "integer", "crewSize": "integer"}, True),
    "plan.approve": ("buildup", "Approve the current plan and start construction on the blank site.", {}, True),
    "robot.resume": ("construction", "RESUME a stopped robot (spec 10.3). Works remotely for lost contact, zone breach, supervisor stop and out of coverage once the cause has cleared; near miss, person detected, collision and fault need a supervisor on site.", {"robot": "robot name, e.g. RPD-1"}, True),
    "robot.stop": ("construction", "STOP a robot (supervisor stop; it needs a RESUME afterwards).", {"robot": "string"}, True),
    "robot.outOfService": ("construction", "Take a robot out of service: it stops and won't bid for work.", {"robot": "string"}, True),
    "robot.returnToService": ("construction", "Return a robot to service so it can bid for work again.", {"robot": "string"}, True),
    "item.cancel": ("construction", "Cancel a work item so no robot does it.", {"unit": "unit id like B-04-12, or taskId + itemId"}, True),
    "item.release": ("construction", "Release a HELD item back to the auction.", {"unit": "unit id, or taskId + itemId"}, True),
    "item.signOff": ("construction", "Sign off an item awaiting sign-off (ok=true accepts it, false sends it back for rework).", {"taskId": "integer", "itemId": "integer", "ok": "boolean"}, True),
    "item.redirect": ("construction", "Send a specific robot to a specific item (it drops what it holds).", {"robot": "string", "unit": "unit id, or taskId + itemId"}, True),
    "zone.add": ("construction", "Add an exclusion zone around a place: kind NO_GO, CRANE, WORK_AREA (crew working; robots keep out) or ROBOT_WORK (crew keep out).", {"kind": "NO_GO|CRANE|WORK_AREA|ROBOT_WORK", "at": "unit id, block letter, asset name, 'laydown' or 'office'", "radiusM": "number", "minutes": "number (optional; 0 = until removed)"}, True),
    "zone.remove": ("construction", "Remove an exclusion zone.", {"zoneId": "integer"}, True),
    "alert.ack": ("construction", "Acknowledge an alert as the build manager (action 0 seen, 1 handling, 2 needs help).", {"alertId": "integer", "action": "0|1|2"}, True),
    "sim.speed": ("construction", "Simulation speed multiplier.", {"value": "number"}, False),
    "sim.inject": ("construction", "Inject a failure into the simulation (demo).", {"kind": "string", "target": "string (optional)"}, False),
    "mesh.trace": ("construction", "Turn packet tracing on or off.", {"enabled": "boolean", "follow": "message id (optional)"}, False),
}


class Site:
    def __init__(self, selection: SelectionAlgorithm | None = None, mesh_handler=None):
        self.survey = SurveySession(selection=selection or load_selection())
        self.plan: dict | None = None
        self.preview: dict | None = None
        self.plan_version = 0
        self.sim_input: dict | None = None
        self.construction = False
        self.mesh = MeshClient(mesh_handler or _noop)
        self.frame = Frame(self.survey.launch["x"], self.survey.launch["y"])

    # ---------- state ----------

    @property
    def stage(self) -> str:
        if self.construction:
            return "construction"
        if self.survey.phase == "locked":
            return "buildup"
        return "survey"

    def network_info(self) -> dict:
        return {"relayRangeM": RELAY_RANGE_M, "assetRangeM": COVERAGE_RADIUS_M, "robotRangeM": ROBOT_RANGE_M, "uwbRangeM": UWB_RANGE_M, "toleranceM": COVERAGE_TOLERANCE_M}

    def mesh_config(self) -> dict | None:
        """What the UI needs to draw the mesh: the benchmark for the 12.4 conversion and node names."""
        if not self.sim_input:
            return None
        c = self.sim_input["config"]
        return {
            "twinBenchmarkM": c["twinBenchmarkM"],
            "coverageRadiusM": c["coverageRadiusM"],
            "hub": c["hub"],
            "gateways": c["gateways"],
            "relays": c["relays"],
            "anchors": c["anchors"],
            "robots": c["robots"],
            "supervisors": c["supervisors"],
            "badges": c["badges"],
            "buildManager": self.sim_input["buildManager"],
            "units": [{"id": u["id"], "block": u["block"], "pos": u["pos"]} for u in self.sim_input["world"]["units"]],
            "tasks": [{"taskId": t["taskId"], "label": t.get("label", ""), "unitIds": t.get("unitIds", {})} for t in self.sim_input["tasks"]],
        }

    def coverage_b64(self) -> str:
        return base64.b64encode(np.packbits(self.survey.coverage).tobytes()).decode("ascii")

    def available_actions(self, for_agent: bool = False) -> list[str]:
        return [n for n, (stage, _, _, agent) in ACTIONS.items() if self._allowed(n, stage) and (agent or not for_agent)]

    def _allowed(self, name: str, stage: str) -> bool:
        if stage == "survey":
            return self.stage == "survey"
        if stage == "buildup":
            return self.stage == "buildup" and (name != "plan.approve" or self.plan is not None)
        return self.stage == "construction"

    # ---------- names ----------

    def node_by_name(self, name: str) -> str | None:
        if not self.sim_input:
            return None
        c = self.sim_input["config"]
        q = str(name).strip().upper()
        for group in (c["robots"], c["relays"], c["anchors"], c["supervisors"]):
            for n in group:
                if n["name"].upper() == q or n["node"].upper() == q:
                    return n["node"]
        return None

    def name_of(self, node: str) -> str:
        if not self.sim_input:
            return node
        c = self.sim_input["config"]
        for group in (c["robots"], c["relays"], c["anchors"], c["supervisors"]):
            for n in group:
                if n["node"] == node:
                    return n["name"]
        if node == c["hub"]:
            return "Hub"
        for b in c["badges"]:
            if str(b["badge"]) == str(node):
                return b["name"]
        return node

    def item_ref(self, args: dict) -> tuple[int, int]:
        if args.get("taskId") is not None and args.get("itemId") is not None:
            return int(args["taskId"]), int(args["itemId"])
        unit = str(args.get("unit", "")).strip().upper()
        for t in (self.sim_input or {}).get("tasks", []):
            if t["mode"] != "autonomous" or t["tag"] != 1:
                continue
            for item, uid in (t.get("unitIds") or {}).items():
                if uid.upper() == unit:
                    return t["taskId"], int(item)
        raise ActionError(f"No work item for {args.get('unit') or args}. Use a unit id like B-04-12, or taskId and itemId.")

    def place(self, at: str) -> dict:
        """A place in the site frame (dm) from a unit id, block letter, asset name, 'laydown' or 'office'."""
        if not self.plan or not self.sim_input:
            raise ActionError("No site yet.")
        q = str(at).strip().upper()
        f = self.frame
        for u in self.plan["units"]:
            if u["id"] == q:
                return f.to_site(u["x"], u["y"])
        m = re.match(r"^(?:BLOCK\s*)?([A-Z]{1,2})$", q)
        if m:
            b = next((b for b in self.plan["blocks"] if b["id"] == m.group(1)), None)
            if b:
                return f.to_site(b["x"] + b["w"] / 2, b["y"] + b["h"] / 2)
        if "LAYDOWN" in q:
            L = self.plan["laydown"]
            return f.to_site(L["x"] + L["w"] / 2, L["y"] + L["h"] / 2)
        if "OFFICE" in q:
            o = self.plan["office"]
            return f.to_site(o["x"] + o["w"] / 2, o["y"] + o["h"] / 2)
        snap = self.mesh.snapshot or {}
        node = self.node_by_name(q)
        for n in snap.get("nodes", []):
            if n["id"] == node and n.get("pos"):
                return n["pos"]
        for b in self.sim_input["config"]["badges"]:
            if q in b["name"].upper():
                for t in snap.get("tracks", {}).get("list", []):
                    if t["id"] == b["badge"]:
                        return t["pos"]
        raise ActionError(f"I couldn't find a place called {at}.")

    # ---------- actions ----------

    def describe_action(self, name: str, args: dict) -> str:
        a = args or {}
        what = a.get("unit") or (f"task {a.get('taskId')} item {a.get('itemId')}" if a.get("taskId") is not None else "")
        labels = {
            "survey.setDistance": lambda: f"Set survey distance to {a.get('m')} m",
            "survey.start": lambda: f"Start the survey ({a['distanceM']} m out)" if a.get("distanceM") else "Start the survey",
            "survey.requestSections": lambda: f"Map sections {', '.join(a.get('ids', []))}",
            "survey.mapMore": lambda: "Map the suggested gaps",
            "survey.recall": lambda: "Recall all drones",
            "survey.lock": lambda: "Lock the survey and move to buildup",
            "plan.generate": lambda: f"Plan {a.get('unitCount')} units with {a.get('crewSize')} people",
            "plan.approve": lambda: "Approve the plan and start construction",
            "robot.resume": lambda: f"Resume {a.get('robot')}",
            "robot.stop": lambda: f"Stop {a.get('robot')}",
            "robot.outOfService": lambda: f"Take {a.get('robot')} out of service",
            "robot.returnToService": lambda: f"Return {a.get('robot')} to service",
            "item.cancel": lambda: f"Cancel {what}",
            "item.release": lambda: f"Release {what}",
            "item.signOff": lambda: f"{'Sign off' if a.get('ok', True) else 'Send back for rework'} {what}",
            "item.redirect": lambda: f"Send {a.get('robot')} to {what}",
            "zone.add": lambda: f"Add a {str(a.get('kind', 'NO_GO')).replace('_', ' ').lower()} zone ({a.get('radiusM')} m) at {a.get('at')}",
            "zone.remove": lambda: f"Remove zone {a.get('zoneId')}",
            "alert.ack": lambda: f"Acknowledge alert {a.get('alertId')}",
            "sim.speed": lambda: f"Simulation speed {a.get('value')}×",
            "sim.inject": lambda: f"Inject {str(a.get('kind', '')).replace('_', ' ')}",
            "mesh.trace": lambda: "Packet tracing " + ("on" if a.get("enabled") else "off"),
        }
        return labels.get(name, lambda: name)()

    def validate(self, name: str, args: dict) -> None:
        if name not in ACTIONS:
            raise ActionError(f"Unknown action {name}. Known actions: {', '.join(ACTIONS)}.")
        stage = ACTIONS[name][0]
        if name == "plan.approve" and self.stage == "buildup" and not self.plan:
            raise ActionError("There's no plan to approve yet. Generate one first.")
        if not self._allowed(name, stage):
            raise ActionError(f"{name} isn't available now: the site is in the {self.stage} stage. Available: {', '.join(self.available_actions())}.")
        a = args or {}
        required = {
            "survey.setDistance": ["m"],
            "survey.requestSections": ["ids"],
            "plan.generate": ["unitCount", "crewSize"],
            "robot.resume": ["robot"],
            "robot.stop": ["robot"],
            "robot.outOfService": ["robot"],
            "robot.returnToService": ["robot"],
            "item.redirect": ["robot"],
            "item.signOff": ["taskId", "itemId"],
            "zone.add": ["at", "radiusM"],
            "zone.remove": ["zoneId"],
            "alert.ack": ["alertId"],
            "sim.speed": ["value"],
            "sim.inject": ["kind"],
        }.get(name, [])
        missing = [k for k in required if a.get(k) in (None, "", [])]
        if missing:
            raise ActionError(f"{name} needs {', '.join(missing)}.")
        if "robot" in required and not self.node_by_name(a["robot"]):
            raise ActionError(f"No robot called {a['robot']}.")

    async def run_action(self, name: str, args: dict | None = None) -> str:
        a = args or {}
        self.validate(name, a)
        s = self.survey
        if name == "survey.setDistance":
            return s.set_distance(float(a["m"]))
        if name == "survey.start":
            return s.start_survey(float(a["distanceM"]) if a.get("distanceM") else None)
        if name == "survey.requestSections":
            ids = a["ids"] if isinstance(a["ids"], list) else str(a["ids"]).replace(",", " ").split()
            return s.request_sections([str(i) for i in ids])
        if name == "survey.mapMore":
            return s.map_more()
        if name == "survey.recall":
            return s.recall_all()
        if name == "survey.lock":
            return s.lock()
        if name == "plan.generate":
            return self._generate_plan(int(a["unitCount"]), int(a["crewSize"]))
        if name == "plan.approve":
            return await self._approve()
        return await self._mesh_action(name, a)

    async def _mesh_action(self, name: str, a: dict) -> str:
        bm = self.sim_input["buildManager"]
        cmd = lambda c, target=None, args=None: self.mesh.request({"type": "command", "supervisor": bm, "cmd": c, "target": target, "args": args or {}})  # noqa: E731
        robot = self.node_by_name(a["robot"]) if a.get("robot") else None
        if name == "robot.resume":
            stop_id = self._robot_state(robot).get("stopId", 0)
            if not stop_id:
                raise ActionError(f"{a['robot']} isn't stopped.")
            res = await cmd("RESUME", robot, {"stopId": stop_id})
        elif name == "robot.stop":
            res = await cmd("STOP", robot)
        elif name == "robot.outOfService":
            res = await cmd("OUT_OF_SERVICE", None, {"node": robot})
        elif name == "robot.returnToService":
            res = await cmd("RETURN_TO_SERVICE", None, {"node": robot})
        elif name in ("item.cancel", "item.release", "item.redirect"):
            task_id, item_id = self.item_ref(a)
            c = {"item.cancel": "CANCEL_ITEM", "item.release": "RELEASE_ITEM", "item.redirect": "REDIRECT"}[name]
            args = {"taskId": task_id, "itemId": item_id} | ({"robot": robot} if robot else {})
            res = await cmd(c, None, args)
        elif name == "item.signOff":
            res = await cmd("SIGN_OFF", None, {"taskId": int(a["taskId"]), "itemId": int(a["itemId"]), "ok": bool(a.get("ok", True))})
        elif name == "zone.add":
            kind = ZONE_KINDS.get(str(a.get("kind", "NO_GO")).upper())
            if not kind:
                raise ActionError("Zone kind must be NO_GO, CRANE, WORK_AREA or ROBOT_WORK.")
            center = self.place(a["at"])
            applies = {"robots": kind != 4, "crew": kind in (1, 2, 4)}
            minutes = float(a.get("minutes") or 0)
            snap_now = (self.mesh.snapshot or {}).get("now", 0)
            zone = {"kind": kind, "appliesTo": applies, "shape": {"circle": {"center": center, "radius": int(float(a["radiusM"]) * 10)}}, "buffer": 20, "slowBand": 50, "until": int(snap_now + minutes * 60_000) if minutes else 0}
            res = await cmd("ZONE_ADD", None, {"zone": zone})
        elif name == "zone.remove":
            res = await cmd("ZONE_REMOVE", None, {"zoneId": int(a["zoneId"])})
        elif name == "alert.ack":
            res = await self.mesh.request({"type": "ack", "supervisor": bm, "alertId": int(a["alertId"]), "action": int(a.get("action", 1))})
        elif name == "sim.speed":
            res = await self.mesh.request({"type": "speed", "value": float(a["value"])})
        elif name == "sim.inject":
            target = self.node_by_name(a["target"]) if a.get("target") else None
            res = await self.mesh.request({"type": "inject", "kind": a["kind"], "target": target})
        elif name == "mesh.trace":
            res = await self.mesh.request({"type": "trace", "enabled": bool(a.get("enabled")), "follow": a.get("follow"), "classes": a.get("classes") or [0, 1]})
        else:
            raise ActionError(f"Unhandled action {name}.")
        if not res.get("ok"):
            raise ActionError(res.get("text", "The command failed."))
        return res.get("text", "Done.")

    def _robot_state(self, node: str | None) -> dict:
        for n in (self.mesh.snapshot or {}).get("nodes", []):
            if n["id"] == node:
                return n.get("robot") or {}
        return {}

    def _generate_plan(self, unit_count: int, crew_size: int) -> str:
        if unit_count < 1:
            raise ActionError("The number of units must be at least 1.")
        if crew_size < 1:
            raise ActionError("The crew size must be at least 1.")
        s, t = self.survey, self.survey.terrain
        ctx = PlannerContext(t.heights, s.coverage, t.cols, t.rows, t.cell_m, s.perimeter, s.launch)
        self.plan = plan_site(unit_count, crew_size, ctx, ASSUMPTIONS)
        self.preview = plan_preview(self.plan)
        self.plan_version += 1
        p = self.plan
        count = {f["key"]: f["count"] for f in p["fleet"]}
        summary = (
            f"Planned {len(p['units'])} units in {len(p['blocks'])} block{'s' if len(p['blocks']) != 1 else ''}: "
            f"{count.get('pile', 0)} pile robot{'s' if count.get('pile', 0) != 1 else ''}, {len(p['relays'])} relay masts plus 2 gateways, "
            f"{len(p.get('anchors', []))} UWB anchor posts, crew of {p['crewUsed']}. About {p['totalDays']:g} days; {p['bottleneck'].lower()} is the bottleneck."
        )
        return summary + (" " + " ".join(p["warnings"]) if p["warnings"] else "")

    async def _approve(self) -> str:
        if not self.plan:
            raise ActionError("Generate a plan first.")
        self.sim_input = build_sim_input(self.plan, self.survey)
        try:
            res = await self.mesh.request({"type": "start", "input": self.sim_input}, timeout=30)
        except RuntimeError as e:
            self.sim_input = None
            raise ActionError(str(e)) from e
        if not res.get("ok"):
            self.sim_input = None
            raise ActionError(res.get("text", "The mesh simulator didn't start."))
        self.construction = True
        c = self.sim_input["config"]
        return (
            f"Plan approved. The site mesh is up: {len(c['relays'])} relays and gateways, {len(c['anchors'])} UWB anchors, "
            f"{len(c['robots'])} robots, {len(c['supervisors'])} supervisor tablets. Construction starts on the blank site."
        )

    # ---------- simulation ----------

    def tick_survey(self) -> None:
        self.survey.tick()


async def _noop(_msg: dict) -> None:
    return None
