"""The shared allocation rules every robot applies to its own copy of the round.

This is an emulation of bidding and consensus, not the planned CBAA firmware: a simple
repeatable score, an agreement fingerprint and a unanimity check are enough to show robots
passing task information to each other and converging on one owner. Change the score here
without touching transport or the display.
"""

from __future__ import annotations

import hashlib
import math
import re

ALLOC = {
    "baseScore": 100,  # points before penalties
    "travelPenaltyPer100m": 4,  # points per 100 m between the robot and the task
    "energyPenalty": 0.3,  # points per % of battery used
    "minBattery": 15,  # % below which a robot declines
    "retryS": 3.0,  # resend BID / AGREE while a round is unresolved
    "heartbeatS": 3.0,
    "reannounceS": 4.0,  # hub re-announces an open round
    "stallS": 20.0,  # an open round older than this is shown as stalled agreement
    "uncertainS": 7.0,  # owner not heard for this long is shown as uncertain (task stays assigned)
    "statusRepeats": 3,  # completion / release status is sent this many times, retryS apart
}


def robot_key(rid: str) -> tuple:
    """Order robot IDs naturally (RPD-2 before RPD-10): the tie-break is the lowest robot ID."""
    return tuple(int(p) if p.isdigit() else p for p in re.split(r"(\d+)", rid))


def score(robot: dict, task: dict) -> tuple[int | None, str]:
    """(score, reason). None means an explicit decline. `robot` is the robot's own state."""
    if robot["mode"] == "paused":
        return None, "paused"
    if robot["busy"]:
        return None, "busy"
    if task["requires"] not in robot["tools"]:
        return None, f"no {task['requires']} tool"
    if robot["battery"] < ALLOC["minBattery"]:
        return None, "low battery"
    d = math.hypot(robot["x"] - task["x"], robot["y"] - task["y"])
    s = ALLOC["baseScore"] - ALLOC["travelPenaltyPer100m"] * d / 100 - ALLOC["energyPenalty"] * (100 - robot["battery"])
    return max(1, round(s)), f"{round(d)} m away, {round(robot['battery'])}% battery"


def ordered_bids(bids: dict[str, int | None], participants: list[str]) -> list[tuple[str, int | None]]:
    return [(p, bids[p]) for p in sorted(participants, key=robot_key)]


def winner(bids: dict[str, int | None], participants: list[str]) -> str | None:
    """Highest score; equal scores go to the lowest robot ID. None if everyone declined."""
    best = None
    for rid, s in ordered_bids(bids, participants):
        if s is not None and (best is None or s > best[1]):
            best = (rid, s)
    return best[0] if best else None


def fingerprint(task_id: str, revision: int, round_id: int, bids: dict[str, int | None], participants: list[str]) -> str:
    """Identifies the inputs being agreed on (task version, round and the complete ordered bid set).
    Not a security feature."""
    body = f"{task_id}|{revision}|{round_id}|" + ",".join(f"{r}={'-' if s is None else s}" for r, s in ordered_bids(bids, participants))
    return hashlib.sha1(body.encode()).hexdigest()[:8]


class EmulatedConsensus:
    """Records one commit per (task, revision, round) with the agreement evidence.

    Abstract on purpose: it is not Raft or the production ownership registry. It never picks a
    winner; it only accepts a commit from a robot that already holds matching AGREE records from
    every fixed participant, and returns the same assignment ID if asked again (idempotent).
    """

    def __init__(self):
        self.records: dict[tuple, dict] = {}

    def record(self, task_id: str, revision: int, round_id: int, owner: str, evidence: dict, at: float) -> dict:
        key = (task_id, revision, round_id)
        if key in self.records:
            return self.records[key]
        rec = {"assignmentId": f"A-{task_id}-R{round_id}", "taskId": task_id, "revision": revision, "roundId": round_id, "owner": owner, "evidence": evidence, "at": at}
        self.records[key] = rec
        return rec
