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
from .twin.network import ASSET_RANGE_M, LORA_RANGE_M, RELAY_RANGE_M
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
}

STAGES = ("survey", "buildup", "construction")


class Site:
    def __init__(self, selection: SelectionAlgorithm | None = None):
        self.survey = SurveySession(selection=selection or load_selection())
        self.plan: dict | None = None
        self.preview: dict | None = None
        self.sim: SimulatedSite | None = None
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
        return {"relayRangeM": RELAY_RANGE_M, "assetRangeM": ASSET_RANGE_M, "loraRangeM": LORA_RANGE_M}

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
        }.get(name, [])
        missing = [k for k in required if a.get(k) in (None, "", [])]
        if missing:
            raise ActionError(f"{name} needs {', '.join(missing)}.")

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
        return f"Plan approved. Construction has started on the blank site: {len(self.plan['units'])} units, crew of {self.plan['crewUsed']}."

    # ---------- simulation ----------

    def tick_survey(self) -> None:
        self.survey.tick()

    def tick_twin(self) -> None:
        if self.sim:
            self.sim.tick()
