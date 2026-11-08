"""Site monitor: cheap rules that decide when something is worth the agent's attention.

Runs after every tick. It never acts; it only collects findings. The server batches the
findings and, at most every AGENT_MIN_INTERVAL_S, asks the agent whether the build manager
needs to know (and what it would suggest doing).
"""

from __future__ import annotations

import time
from collections import defaultdict, deque

from .mesh.rules import ALLOC
from .site import Site

STALE_S = 30
REQUEST_WAIT_S = 20
PROXIMITY_WINDOW_S = 120
PROXIMITY_REPEAT = 3


class Monitor:
    def __init__(self, site: Site):
        self.site = site
        self.findings: list[str] = []
        self._survey_phase = site.survey.phase
        self._plan_version = 0
        self._twin_event_id = 0
        self._twin_started = False
        self._stale: set[str] = set()
        self._prox: dict[str, deque] = defaultdict(deque)
        self._prox_flagged: dict[str, float] = {}
        self._req_flagged: set[str] = set()
        self._stalled_flagged: set[int] = set()
        self._uncertain: set[str] = set()

    def take(self) -> list[str]:
        out, self.findings = self.findings, []
        return out

    def check(self) -> None:
        self._check_survey()
        self._check_plan()
        self._check_twin()

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

    # ---------- construction ----------

    def _check_twin(self) -> None:
        sim = self.site.sim
        if not sim:
            return
        now = self.site.now_ms() / 1000  # site seconds
        if not self._twin_started:
            self._twin_started = True
            self._twin_event_id = sim.events[0]["id"] if sim.events else 0
            return
        new = [e for e in sim.events if e["id"] > self._twin_event_id]
        if new:
            self._twin_event_id = new[0]["id"]
        for e in reversed(new):
            text = e["text"]
            if e["level"] == "alert":
                self.findings.append(text)
            elif "refusal" in text:
                self.findings.append(text)
            elif text.startswith("Rerouted around"):
                self.findings.append(text)
            elif "attempt cancelled" in text:
                self.findings.append(text)
            elif text.startswith("Fast-forward finished"):
                self.findings.append(text + " (The manager skipped to the end of the build: give a short wrap-up from get_schedule: finish against the plan, the slowest days, outages and stalls. If it stalled, say why and suggest the fix.)")
            elif text.startswith("Day ") and " done." in text:
                self.findings.append(text + " (End of shift: a one-line daily summary is welcome; no need to repeat the numbers.)")
            elif text.startswith("All ") and "Construction complete" in text:
                self.findings.append(text)
            elif text.startswith("Proximity stop:") and e.get("assetId"):
                q = self._prox[e["assetId"]]
                q.append(now)
                while q and now - q[0] > PROXIMITY_WINDOW_S:
                    q.popleft()
                if len(q) >= PROXIMITY_REPEAT and now - self._prox_flagged.get(e["assetId"], 0) > PROXIMITY_WINDOW_S:
                    self._prox_flagged[e["assetId"]] = now
                    self.findings.append(f"{e['assetId']} has had {len(q)} proximity stops in the last {PROXIMITY_WINDOW_S // 60} minutes (latest: {text[len('Proximity stop: '):]}). Crews may be working too close to it.")

        now_ms = self.site.now_ms()
        fresh_shift = now_ms - self.site.shift_started_ms < 60_000  # everyone reports again in the first minute
        stale_s = STALE_S + self.site.clock.effective_speed() * 0.6  # same slack the UI uses at high speed
        for a in sim.reported.values():
            if fresh_shift:
                break
            if a["kind"] == "relay":
                continue
            stale = now_ms - a["lastHeard"] > stale_s * 1000
            if stale and a["id"] not in self._stale:
                self._stale.add(a["id"])
                self.findings.append(f"{a['name']} ({a['role']}) hasn't reported for over {STALE_S} s; last seen doing: {a['task']}.")
            elif not stale and a["id"] in self._stale:
                self._stale.discard(a["id"])

        mesh = self.site.mesh
        if mesh:
            hub = mesh.hub
            for rnd in hub.rounds.values():
                rv = hub.round_view(rnd)
                if rv["stalled"] and rnd["id"] not in self._stalled_flagged:
                    self._stalled_flagged.add(rnd["id"])
                    t = hub.tasks[rnd["taskId"]]
                    missing = [p for p in rnd["participants"] if p not in rnd["bids"]]
                    self.findings.append(
                        f"Agreement stalled: round {rnd['id']} for {t['label']} has been open {round(rv['ageS'])} s. "
                        f"Hub has bids from {len(rnd['bids'])} of {len(rnd['participants'])} robots" + (f" (missing {', '.join(missing)})" if missing else "") + "."
                    )
            for t in hub.tasks.values():
                unc = hub.owner_uncertain(t)
                if unc and t["id"] not in self._uncertain:
                    self._uncertain.add(t["id"])
                    self.findings.append(f"Owner uncertain: {t['owner']} hasn't been heard on the mesh for over {round(ALLOC['uncertainS'])} s while it holds {t['label']} ({t['done']} of {t['total']} done). The task stays assigned to it.")
                elif not unc and t["id"] in self._uncertain:
                    self._uncertain.discard(t["id"])

        for r in sim.requests:
            if r["status"] == "pending" and r["id"] not in self._req_flagged and now_ms - r["createdAt"] > REQUEST_WAIT_S * 1000:
                self._req_flagged.add(r["id"])
                self.findings.append(f"{r['id']} ({r['need']} at {r['target']['label']}) has been waiting {REQUEST_WAIT_S} s with nothing assigned.")
