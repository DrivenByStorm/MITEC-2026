"""Day-to-day tracker: what the twin reported each shift against the plan's pace.

Counts come from the twin's reported unit statuses (what the edge server actually heard), so a
robot out of coverage shows up late, as it would on site. The plan's pace comes from the planner's
own stage durations: staking at the rovers' rate, piling over the piling days, and setting one
day behind piling (the planner assumes stages overlap that way).
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .clock import SiteClock
    from .mesh.site_mesh import SiteMesh
    from .twin.simulator import SimulatedSite

STAGE_OF = {"staked": 1, "piled": 2, "installed": 3}


def unit_counts(units: list[dict]) -> dict:
    """Cumulative: staked counts anything staked or further along, and so on."""
    lvl = [STAGE_OF.get(u["status"], 0) for u in units]
    return {"staked": sum(v >= 1 for v in lvl), "piled": sum(v >= 2 for v in lvl), "set": sum(v >= 3 for v in lvl)}


def plan_curve(plan: dict) -> list[dict]:
    """Expected cumulative units at the end of each day, from the plan."""
    n = len(plan["units"])
    A = plan["assumptions"]
    days = {s["stage"]: max(s["days"], 1e-6) for s in plan["stages"]}
    rovers = next((f["count"] for f in plan["fleet"] if f["key"] == "rover"), 0)
    stake_rate = rovers * A.get("roverStakeUnitsPerDay", 120)
    total = max(1, math.ceil(plan["totalDays"]))
    out = []
    for d in range(1, total + 1):
        out.append({
            "day": d,
            "staked": min(n, round(stake_rate * d)) if stake_rate else n,
            "piled": min(n, round(n * d / days["Piling"])),
            "set": min(n, round(n * max(0, d - 1) / days["Setting units"])),
        })
    return out


class DayTracker:
    def __init__(self, plan: dict, sim: "SimulatedSite", mesh: "SiteMesh", clock: "SiteClock"):
        self.plan = plan
        self.sim = sim
        self.mesh = mesh
        self.clock = clock
        self.curve = plan_curve(plan)
        self.days: list[dict] = []
        self.open_day()

    def _marks(self) -> dict:
        hub = self.mesh.hub
        return {
            "units": unit_counts(self.sim.reported_units),
            "tasksDone": sum(t["state"] == "completed" for t in hub.tasks.values()),
            "rounds": len(hub.rounds),
            "meshT": self.mesh.tx.now,
            "counts": dict(self.sim.counters),
        }

    def open_day(self) -> None:
        if self.days and self.days[-1]["end"] is None:
            return  # today is still open
        self.days.append({"day": self.clock.day, "start": self._marks(), "end": None, "summary": None})

    def close_day(self) -> None:
        cur = self.days[-1]
        if cur["end"] is None:
            cur["end"] = self._marks()
            cur["summary"] = self._summary(cur)

    # ---------- views ----------

    def _expected(self, day: int) -> dict:
        if not self.curve:
            return {"staked": 0, "piled": 0, "set": 0}
        return self.curve[min(day, len(self.curve)) - 1]

    def _stats(self, rec: dict, end: dict) -> dict:
        hub = self.mesh.hub
        s, e = rec["start"], end
        c = {k: e["counts"].get(k, 0) - s["counts"].get(k, 0) for k in ("relayOutages", "refusals", "proximityStops", "cancelledAttempts")}
        rounds = [r for r in hub.rounds.values() if s["meshT"] <= r["openedAt"] <= e["meshT"]]
        stall_s = 20.0
        return {
            "did": {k: e["units"][k] - s["units"][k] for k in ("staked", "piled", "set")},
            "total": e["units"],
            "tasksDone": e["tasksDone"] - s["tasksDone"],
            "rounds": len(rounds),
            "roundsNoEligible": sum(r["status"] == "no_eligible" for r in rounds),
            "roundsStalled": sum(((r["closedAt"] or e["meshT"]) - r["openedAt"]) > stall_s for r in rounds),
            **c,
        }

    def _summary(self, rec: dict) -> str:
        st = self._stats(rec, rec["end"])
        d = st["did"]
        exp = self._expected(rec["day"])
        parts = [f"Staked {d['staked']}, piled {d['piled']}, set {d['set']} units."]
        gap = st["total"]["set"] - exp["set"]
        if exp["set"] or st["total"]["set"]:
            parts.append(f"{st['total']['set']} set in total, {abs(gap)} {'ahead of' if gap >= 0 else 'behind'} the plan's {exp['set']}.")
        notes = []
        if st["relayOutages"]:
            notes.append(f"{st['relayOutages']} relay outage{'s' if st['relayOutages'] != 1 else ''}")
        if st["roundsStalled"]:
            notes.append(f"{st['roundsStalled']} stalled round{'s' if st['roundsStalled'] != 1 else ''}")
        if st["refusals"]:
            notes.append(f"{st['refusals']} pile refusal{'s' if st['refusals'] != 1 else ''}")
        if st["cancelledAttempts"]:
            notes.append(f"{st['cancelledAttempts']} cancelled attempt{'s' if st['cancelledAttempts'] != 1 else ''}")
        parts.append(f"{st['tasksDone']} tasks done in {st['rounds']} rounds" + (f"; {', '.join(notes)}." if notes else "."))
        return " ".join(parts)

    def view(self) -> dict:
        n = len(self.plan["units"])
        rows = []
        for rec in self.days:
            live = rec["end"] is None
            end = rec["end"] or self._marks()
            st = self._stats(rec, end)
            rows.append({
                "day": rec["day"],
                "live": live,
                "did": st["did"],
                "total": st["total"],
                "expected": self._expected(rec["day"]),
                "tasksDone": st["tasksDone"],
                "rounds": st["rounds"],
                "roundsNoEligible": st["roundsNoEligible"],
                "roundsStalled": st["roundsStalled"],
                "relayOutages": st["relayOutages"],
                "refusals": st["refusals"],
                "proximityStops": st["proximityStops"],
                "summary": rec["summary"],
            })
        return {"units": n, "planDays": self.plan["totalDays"], "curve": self.curve, "days": rows, "complete": rows[-1]["total"]["set"] >= n if rows else False}
