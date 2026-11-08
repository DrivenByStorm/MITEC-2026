"""The site twin: one object that owns every stage and every action.

    survey        drones build the terrain model from scratch
    buildup       the planner lays out the units the build manager asked for and sizes the fleet
    construction  the approved plan is built live, from bare ground

Every change to the site goes through `run_action`, whether it comes from a UI button
(the build manager acting directly) or from an agent suggestion the manager approved.
The agent itself can only read state and propose actions.
"""

from __future__ import annotations

import base64

import numpy as np

from .buildup.assumptions import ASSUMPTIONS
from .buildup.planner import PlannerContext, plan_site
from .survey.selection import SelectionAlgorithm, load_selection
from .survey.session import SurveySession
from .mesh.site_mesh import SiteMesh
from .twin.network import ASSET_RANGE_M, LORA_RANGE_M, RELAY_RANGE_M, ROBOT_RANGE_M
from .twin.simulator import SimulatedSite, plan_preview


class ActionError(Exception):
    pass


# name -> (stage it belongs to, short description for the agent and the UI, args schema)
ACTIONS: dict[str, tuple[str, str, dict]] = {
    "survey.setDistance": ("survey", "Set how far the scout drone flies out before the survey starts (meters).", {"m": "number"}),
    "survey.start": ("survey", "Start the survey: the scout traces a square boundary this far from the launch point (meters), then the survey drones map it.", {"distanceM": "number (optional)"}),
    "survey.requestSections": ("survey", "Send survey drones to map specific sections, e.g. ['B3','C4'].", {"ids": "string[]"}),
    "survey.mapMore": ("survey", "Send drones to the best suggested unmapped gaps.", {}),
    "survey.recall": ("survey", "Recall every drone to the launch point.", {}),
    "survey.lock": ("survey", "Accept the survey and hand the terrain model to buildup planning.", {}),
    "plan.generate": ("buildup", "Generate (or regenerate) the buildup plan for a number of P3 units and the crew available.", {"unitCount": "integer", "crewSize": "integer"}),
    "plan.approve": ("buildup", "Approve the current plan and start construction on the blank site.", {}),
    "twin.pause": ("construction", "Pause a robot or machine by id (e.g. RPD-1, CR-2).", {"id": "string"}),
    "twin.resume": ("construction", "Resume a paused robot or machine.", {"id": "string"}),
    "twin.pauseAll": ("construction", "Pause every robot and drone on site.", {}),
    "twin.request": ("construction", "Request equipment at a place: need is 'telehandler', 'crane' or 'trencher'; target is a unit (C-03-07), block and row (B7), block (block B), 'laydown', 'office' or an asset name.", {"need": "string", "target": "string"}),
    "twin.cancelRequest": ("construction", "Cancel an open equipment request (e.g. REQ-001).", {"id": "string"}),
    "task.cancel": ("construction", "Cancel a mesh task (id like T-005, or a label like 'pile row A-02'). If a robot owns it, the hub tells it to stop and waits for confirmation.", {"id": "string"}),
    "task.release": ("construction", "Ask the owner of an assigned mesh task to stop and release it; a new bidding round opens once it confirms.", {"id": "string"}),
    "task.priority": ("construction", "Change the priority of a mesh task that hasn't been allocated yet (higher goes first; rows are 1-3).", {"id": "string", "priority": "integer"}),
    "mesh.cutLink": ("construction", "Remove the mesh link between two nodes (robots, relays M-n, GW, HUB), e.g. to test a broken relay path.", {"a": "string", "b": "string"}),
    "mesh.restoreLink": ("construction", "Restore a removed mesh link between two nodes; with no args, restore every removed link.", {"a": "string (optional)", "b": "string (optional)"}),
    "mesh.relay": ("construction", "Take a relay mast down or bring it back up.", {"id": "string", "up": "boolean"}),
    "mesh.hub": ("construction", "Switch the hub (edge server's mesh radio) off or on. Robots keep agreeing on tasks they already have.", {"online": "boolean"}),
    "mesh.latency": ("construction", "Set the mesh delivery delay per hop, in milliseconds.", {"ms": "number"}),
    "mesh.loss": ("construction", "Set packet loss per radio hop, in percent.", {"pct": "number"}),
}

STAGES = ("survey", "buildup", "construction")


class Site:
    def __init__(self, selection: SelectionAlgorithm | None = None):
        self.survey = SurveySession(selection=selection or load_selection())
        self.plan: dict | None = None
        self.preview: dict | None = None
        self.sim: SimulatedSite | None = None
        self.mesh: SiteMesh | None = None
        self.plan_version = 0

    # ---------- state ----------

    @property
    def stage(self) -> str:
        """The furthest stage the site has reached."""
        if self.sim:
            return "construction"
        if self.survey.phase == "locked":
            return "buildup"
        return "survey"

    def network_info(self) -> dict:
        return {"relayRangeM": RELAY_RANGE_M, "assetRangeM": ASSET_RANGE_M, "loraRangeM": LORA_RANGE_M, "robotRangeM": ROBOT_RANGE_M}

    def coverage_b64(self) -> str:
        return base64.b64encode(np.packbits(self.survey.coverage).tobytes()).decode("ascii")

    def available_actions(self) -> list[str]:
        return [name for name, (stage, _, _) in ACTIONS.items() if self._action_allowed(name, stage)]

    def _action_allowed(self, name: str, stage: str) -> bool:
        if stage == "survey":
            return self.stage == "survey"
        if stage == "buildup":
            return self.stage == "buildup" and (name != "plan.approve" or self.plan is not None)
        return self.stage == "construction"

    # ---------- actions ----------

    def describe_action(self, name: str, args: dict) -> str:
        a = args or {}
        labels = {
            "survey.setDistance": lambda: f"Set survey distance to {a.get('m')} m",
            "survey.start": lambda: f"Start the survey ({a['distanceM']} m out)" if a.get("distanceM") else "Start the survey",
            "survey.requestSections": lambda: f"Map sections {', '.join(a.get('ids', []))}",
            "survey.mapMore": lambda: "Map the suggested gaps",
            "survey.recall": lambda: "Recall all drones",
            "survey.lock": lambda: "Lock the survey and move to buildup",
            "plan.generate": lambda: f"Plan {a.get('unitCount')} units with {a.get('crewSize')} people",
            "plan.approve": lambda: "Approve the plan and start construction",
            "twin.pause": lambda: f"Pause {a.get('id')}",
            "twin.resume": lambda: f"Resume {a.get('id')}",
            "twin.pauseAll": lambda: "Pause all robots",
            "twin.request": lambda: f"Send a {a.get('need')} to {a.get('target')}",
            "twin.cancelRequest": lambda: f"Cancel {a.get('id')}",
            "task.cancel": lambda: f"Cancel task {self._task_label(a.get('id'))}",
            "task.release": lambda: f"Release task {self._task_label(a.get('id'))}",
            "task.priority": lambda: f"Set {self._task_label(a.get('id'))} priority to {a.get('priority')}",
            "mesh.cutLink": lambda: f"Remove mesh link {a.get('a')}–{a.get('b')}",
            "mesh.restoreLink": lambda: f"Restore mesh link {a.get('a')}–{a.get('b')}" if a.get("a") else "Restore all removed mesh links",
            "mesh.relay": lambda: f"{'Bring up' if _truthy(a.get('up')) else 'Take down'} relay {a.get('id')}",
            "mesh.hub": lambda: f"Switch the hub {'on' if _truthy(a.get('online')) else 'off'}",
            "mesh.latency": lambda: f"Set mesh delay to {a.get('ms')} ms per hop",
            "mesh.loss": lambda: f"Set packet loss to {a.get('pct')}%",
        }
        return labels.get(name, lambda: name)()

    def validate(self, name: str, args: dict) -> None:
        if name not in ACTIONS:
            raise ActionError(f"Unknown action {name}. Known actions: {', '.join(ACTIONS)}.")
        stage = ACTIONS[name][0]
        if name == "plan.approve" and self.stage == "buildup" and not self.plan:
            raise ActionError("There's no plan to approve yet. Generate one first.")
        if not self._action_allowed(name, stage):
            raise ActionError(f"{name} isn't available now: the site is in the {self.stage} stage. Available: {', '.join(self.available_actions())}.")
        a = args or {}
        required = {
            "survey.setDistance": ["m"],
            "survey.requestSections": ["ids"],
            "plan.generate": ["unitCount", "crewSize"],
            "twin.pause": ["id"],
            "twin.resume": ["id"],
            "twin.request": ["need", "target"],
            "twin.cancelRequest": ["id"],
            "task.cancel": ["id"],
            "task.release": ["id"],
            "task.priority": ["id", "priority"],
            "mesh.cutLink": ["a", "b"],
            "mesh.relay": ["id", "up"],
            "mesh.hub": ["online"],
            "mesh.latency": ["ms"],
            "mesh.loss": ["pct"],
        }.get(name, [])
        missing = [k for k in required if a.get(k) in (None, "", [])]
        if missing:
            raise ActionError(f"{name} needs {', '.join(missing)}.")
        m = self.mesh
        if name.startswith("task.") and m and not m.task_id(str(a["id"])):
            raise ActionError(f"No mesh task matching '{a['id']}'. Use an id like T-005 or a label like 'pile row A-02'.")
        if name == "mesh.cutLink" and m and not (m.node_id(str(a["a"])) and m.node_id(str(a["b"]))):
            raise ActionError(f"Unknown mesh node in {a['a']}–{a['b']}. Nodes: {', '.join(sorted(m.tx.nodes))}.")

    def run_action(self, name: str, args: dict | None = None) -> str:
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
            return self._approve()
        sim = self.sim
        assert sim is not None
        if name == "twin.pause":
            return sim.pause(str(a["id"]))
        if name == "twin.resume":
            return sim.resume(str(a["id"]))
        if name == "twin.pauseAll":
            return sim.pause_all_robots()
        if name == "twin.request":
            return sim.create_request(str(a["need"]), str(a["target"]), "Build manager")
        if name == "twin.cancelRequest":
            return sim.cancel_request(str(a["id"]))
        m = self.mesh
        assert m is not None
        if name == "task.cancel":
            return m.hub.cancel(m.task_id(str(a["id"])) or "")
        if name == "task.release":
            return m.hub.release(m.task_id(str(a["id"])) or "")
        if name == "task.priority":
            return m.hub.set_priority(m.task_id(str(a["id"])) or "", int(a["priority"]))
        if name == "mesh.cutLink":
            return m.cut_link(str(a["a"]), str(a["b"]))
        if name == "mesh.restoreLink":
            return m.restore_link(str(a["a"]), str(a.get("b", ""))) if a.get("a") else m.restore_link()
        if name == "mesh.relay":
            return sim.relay_up(str(a["id"])) if _truthy(a["up"]) else sim.relay_down(str(a["id"]))
        if name == "mesh.hub":
            return m.set_hub(_truthy(a["online"]))
        if name == "mesh.latency":
            return m.set_latency(float(a["ms"]))
        if name == "mesh.loss":
            return m.set_loss(float(a["pct"]))
        raise ActionError(f"Unhandled action {name}.")

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
        relays = sum(1 for r in p["relays"] if not r["linkOnly"])
        extra = len(p["relays"]) - relays
        summary = (
            f"Planned {len(p['units'])} units in {len(p['blocks'])} block{'s' if len(p['blocks']) != 1 else ''}, "
            f"{len(p['relays'])} relay masts{f' ({extra} link-only)' if extra else ''}, crew of {p['crewUsed']}. "
            f"About {p['totalDays']:g} days; {p['bottleneck'].lower()} is the bottleneck."
        )
        return summary + (" " + " ".join(p["warnings"]) if p["warnings"] else "")

    def _approve(self) -> str:
        if not self.plan:
            raise ActionError("Generate a plan first.")
        self.sim = SimulatedSite(self.plan)
        self.mesh = SiteMesh(self.sim)
        return f"Plan approved. Construction has started on the blank site: {len(self.plan['units'])} units, crew of {self.plan['crewUsed']}."

    # ---------- simulation ----------

    def tick_survey(self) -> None:
        self.survey.tick()

    def tick_twin(self) -> None:
        if self.sim:
            self.sim.tick()

    def tick_mesh(self, dt: float) -> None:
        if self.mesh:
            self.mesh.step(dt)

    def _task_label(self, text) -> str:
        m = self.mesh
        tid = m.task_id(str(text)) if m and text is not None else None
        return f"{tid} ({m.hub.tasks[tid]['label']})" if tid else str(text)


def _truthy(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on", "up")
    return bool(v)
