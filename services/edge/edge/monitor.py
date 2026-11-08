"""Site monitor: cheap rules that decide when something is worth the agent's attention.

It never acts; it only collects findings. The server batches them and, at most every
AGENT_MIN_INTERVAL_S, asks the agent whether the build manager needs to know.

During construction the hub mesh service already does the hard part: it raises alerts
(spec 10.1) and groups losses by cause (7.3). The monitor turns those into findings in plain
words, and adds a few things the hub doesn't alert on.
"""

from __future__ import annotations

from .site import Site

ALERT_KINDS = {
    1: "NODE_LOST",
    2: "NEAR_MISS",
    3: "CREW_IN_ZONE",
    4: "STOP_NEEDS_RESUME",
    5: "CREW_HOLD_LONG",
    6: "POSITION_MISMATCH",
    7: "SHORTFALL",
    8: "ITEM_FAILED",
    9: "DUPLICATE_START",
    10: "MANUAL_TASK",
    11: "SIGNOFF_NEEDED",
}
STOP_REASONS = {1: "lost mesh contact", 2: "near miss", 3: "person detected", 4: "collision", 5: "fault", 6: "zone breach", 7: "supervisor stop", 8: "low battery", 9: "out of coverage", 20: "crew hold", 21: "proximity yield"}
CAUSES = {0: "unknown cause (coverage hole, power or fault)", 1: "relay down", 2: "hub isolated: both gateways lost"}


class Monitor:
    def __init__(self, site: Site):
        self.site = site
        self.findings: list[str] = []
        self._survey_phase = site.survey.phase
        self._plan_version = 0
        self._alerts_seen: set[int] = set()
        self._escalated: set[int] = set()
        self._groups: dict[int, dict] = {}
        self._tasks_done: set[int] = set()

    def take(self) -> list[str]:
        out, self.findings = self.findings, []
        return out

    def check(self) -> None:
        self._check_survey()
        self._check_plan()
        self._check_tasks()

    # ---------- survey ----------

    def _check_survey(self) -> None:
        s = self.site.survey
        if s.phase == self._survey_phase:
            return
        prev, self._survey_phase = self._survey_phase, s.phase
        if s.phase == "review":
            st = s.stats()
            sugg = ", ".join(s.suggestions()[:4]) or "none"
            elev = "; elevation %.0f-%.0f m" % (st["minM"], st["maxM"]) if st["minM"] is not None else ""
            self.findings.append(
                f"Survey mapping pass complete: {round(st['coverage'] * 100)}% of the {st['perimeterAreaKm2']:.1f} km² site mapped{elev}. "
                f"Suggested gaps: {sugg}. The manager can map more or lock the survey for buildup."
            )
        elif prev == "scouting" and s.phase == "surveying":
            self.findings.append("Scout closed the site boundary; survey drones are mapping their first sections.")

    # ---------- buildup ----------

    def _check_plan(self) -> None:
        site = self.site
        if site.plan_version == self._plan_version or not site.plan:
            return
        self._plan_version = site.plan_version
        p = site.plan
        warn = f" Warnings: {' '.join(p['warnings'])}" if p["warnings"] else ""
        self.findings.append(
            f"New buildup plan: {len(p['units'])} of {p['input']['unitCount']} units placed, crew {p['crewUsed']} of {p['input']['crewSize']} available, "
            f"{p['totalDays']:g} days, bottleneck {p['bottleneck']}.{warn}"
        )

    # ---------- construction (mesh) ----------

    def _check_tasks(self) -> None:
        planning = self.site.mesh.planning
        if not planning:
            return
        for t in planning.get("tasks", []):
            if t["status"] == "complete" and t["taskId"] not in self._tasks_done:
                self._tasks_done.add(t["taskId"])
                self.findings.append(f"{t['label']} is complete.")

    def mesh_events(self, events: list[dict]) -> None:
        name = self.site.name_of
        for e in events:
            kind = e.get("kind")
            if kind == "node_lost":
                self._groups[e["groupId"]] = e
            elif kind == "alert":
                a = e["alert"]
                aid = a["alertId"]
                k = ALERT_KINDS.get(a["kind"], str(a["kind"]))
                if aid not in self._alerts_seen:
                    self._alerts_seen.add(aid)
                    if k == "MANUAL_TASK":
                        continue
                    self.findings.append(self._describe(a, k, name))
                elif not a.get("ack") and len(a.get("notified", [])) > 1 and aid not in self._escalated:
                    self._escalated.add(aid)
                    who = name(a["notified"][-2])
                    self.findings.append(f"Alert {aid} ({k}) wasn't acknowledged by {who}; the hub escalated it to {name(a['notified'][-1])}.")

    def _describe(self, a: dict, k: str, name) -> str:
        subjects = ", ".join(name(s) for s in a.get("subjects", [])) or "-"
        if k == "NODE_LOST":
            g = self._groups.get(a["ref"], {})
            cause = CAUSES.get(g.get("cause", 0), "unknown")
            cn = f" ({name(g['causeNode'])})" if g.get("causeNode") else ""
            return f"Alert {a['alertId']}: NODE_LOST, cause {cause}{cn}: {subjects}."
        if k == "STOP_NEEDS_RESUME":
            robot = a["subjects"][0] if a.get("subjects") else ""
            state = self.site._robot_state(robot)
            reason = STOP_REASONS.get(state.get("stopReason", 0), "unknown reason")
            return f"Alert {a['alertId']}: {name(robot)} stopped ({reason}) and needs a RESUME (stop {a['ref']})."
        if k == "SHORTFALL":
            return f"Alert {a['alertId']}: SHORTFALL on task {a['taskId']}: {a['ref']} more robot(s) could be working it."
        if k == "SIGNOFF_NEEDED":
            return f"Alert {a['alertId']}: task {a['taskId']} item {a['itemId']} is waiting for a supervisor sign-off."
        if k == "CREW_IN_ZONE":
            return f"Alert {a['alertId']}: {subjects} entered a crew keep-out zone (zone {a['ref']})."
        return f"Alert {a['alertId']}: {k} ({subjects})."
