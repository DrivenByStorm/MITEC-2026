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
import time

import numpy as np

from .buildup.assumptions import ASSUMPTIONS
from .buildup.planner import PlannerContext, plan_site
from .clock import SURVEY_SPEEDS, SiteClock
from .schedule import DayTracker
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
    "sim.speed": ("any", "Set the simulation speed (1, 10, 60, 300 or 900 times real time; the survey runs at most 20×).", {"x": "number"}),
    "sim.pause": ("any", "Pause or resume the simulation.", {"paused": "boolean"}),
    "sim.skipShift": ("construction", "Fast-forward to the end of today's shift (work still happens, just quickly).", {}),
    "sim.pauseAtDayEnd": ("construction", "Pause automatically when each shift ends, so the day can be reviewed.", {"on": "boolean"}),
}

STAGES = ("survey", "buildup", "construction")


class Site:
    def __init__(self, selection: SelectionAlgorithm | None = None):
        self.survey = SurveySession(selection=selection or load_selection())
        self.plan: dict | None = None
        self.preview: dict | None = None
        self.sim: SimulatedSite | None = None
        self.mesh: SiteMesh | None = None
        self.days: DayTracker | None = None
        self.clock = SiteClock()
        self.plan_version = 0
        self.shift_started_ms = 0
        self._survey_carry = 0.0

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
        if stage == "any":
            return True
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
            "sim.speed": lambda: f"Set simulation speed to {a.get('x')}×",
            "sim.pause": lambda: "Pause the simulation" if _truthy(a.get("paused")) else "Resume the simulation",
            "sim.skipShift": lambda: "Skip to the end of today's shift",
            "sim.pauseAtDayEnd": lambda: f"{'Pause' if _truthy(a.get('on')) else 'Keep running'} at the end of each day",
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
            "sim.speed": ["x"],
            "sim.pause": ["paused"],
            "sim.pauseAtDayEnd": ["on"],
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
        c = self.clock
        if name == "sim.speed":
            x = float(a["x"])
            if self.stage == "survey" and x > max(SURVEY_SPEEDS):
                c.set_speed(x)
                return f"Speed set to {x:g}×; the survey runs at most {max(SURVEY_SPEEDS)}×."
            return c.set_speed(x)
        if name == "sim.pause":
            return c.set_paused(_truthy(a["paused"]))
        if name == "sim.pauseAtDayEnd":
            c.pause_at_day_end = _truthy(a["on"])
            return "Will pause at the end of each shift." if c.pause_at_day_end else "Won't pause at the end of each shift."
        if name == "sim.skipShift":
            if c.turbo_until is not None:
                return "Already skipping to the end of the shift."
            c.skip_to_shift_end()
            return f"Fast-forwarding through the rest of day {c.day} ({round(c.left_in_shift() / 60)} site minutes of work)."
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
        self.clock = SiteClock(shift_minutes=self.plan["assumptions"]["shiftMinutes"])  # Day 1, 07:00, 1x
        self.shift_started_ms = self.clock.ms()
        self.sim = SimulatedSite(self.plan, now_ms=self.clock.ms)
        self.mesh = SiteMesh(self.sim)
        self.days = DayTracker(self.plan, self.sim, self.mesh, self.clock)
        return f"Plan approved. Construction has started on the blank site: {len(self.plan['units'])} units, crew of {self.plan['crewUsed']}."

    # ---------- simulation ----------

    def tick_survey(self) -> None:
        self.survey.tick()

    def survey_ticks(self, base: int = 1) -> int:
        """How many survey ticks to run this loop, at the dial speed (capped at 20x)."""
        c = self.clock
        if c.paused:
            return 0
        self._survey_carry += base * min(c.speed, max(SURVEY_SPEEDS))
        n = int(self._survey_carry)
        self._survey_carry -= n
        return n

    def now_ms(self) -> int:
        """Site time during construction, wall time before it."""
        return self.clock.ms() if self.sim else int(time.time() * 1000)

    def advance(self, wall_dt: float, budget_s: float = 0.06) -> bool:
        """Run construction for wall_dt at the dial speed. Returns True if a shift ended."""
        sim, mesh, c = self.sim, self.mesh, self.clock
        if not (sim and mesh and self.days):
            return False
        want = (c.turbo_until - c.t) if c.turbo_until is not None else wall_dt * c.effective_speed()
        speed = c.effective_speed()
        mesh.tx.record_traces = speed <= 2
        chunk_max = min(10.0, max(0.1, speed * 0.1))
        if c.turbo_until is not None:
            budget_s *= 2  # skipping: work harder, the manager is waiting
        start = time.perf_counter()
        rolled = False
        while want > 1e-9:
            if not c.on_shift():
                self._start_next_shift()
                continue
            chunk = min(want, c.left_in_shift(), chunk_max)
            mesh.step(chunk)
            sim.tick(chunk)
            c.t += chunk
            want -= chunk
            if c.left_in_shift() <= 1e-6:
                self._end_shift()
                rolled = True
                if c.turbo_until is not None:
                    c.end_turbo()
                    break
                if c.pause_at_day_end:
                    c.paused = True
                    break
            if time.perf_counter() - start > budget_s:
                break  # can't keep up at this speed: drop the rest rather than fall behind
        return rolled

    def _end_shift(self) -> None:
        sim, days = self.sim, self.days
        days.close_day()
        rec = days.days[-1]
        sim.log("info", f"Day {rec['day']} done. {rec['summary']}")
        self._start_next_shift()

    def _start_next_shift(self) -> None:
        c = self.clock
        c.t = c.next_shift_start()
        self.shift_started_ms = c.ms()
        self.sim.start_shift()
        self.days.open_day()
        self.sim.log("info", f"Day {c.day} starts at {c.hhmm(c.shift_start)}. Robots recharged and machines refuelled overnight.")

    def _task_label(self, text) -> str:
        m = self.mesh
        tid = m.task_id(str(text)) if m and text is not None else None
        return f"{tid} ({m.hub.tasks[tid]['label']})" if tid else str(text)


def _truthy(v) -> bool:
    if isinstance(v, str):
        return v.strip().lower() in ("1", "true", "yes", "on", "up")
    return bool(v)
