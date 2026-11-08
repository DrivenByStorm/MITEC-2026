"""The hub (edge server): introduces tasks, opens one allocation round at a time and displays
what it hears. It never picks a winner; robots agree among themselves over the mesh, and the
hub's view is built only from packets it receives through the gateway.
"""

from __future__ import annotations

from typing import Callable

from .rules import ALLOC, robot_key
from .transport import MeshTransport

HUB = "HUB"

# Task states shown to the manager, in order.
STATE_LABEL = {
    "waiting": "Waiting on earlier work",
    "queued": "Queued",
    "held": "Waiting for a free robot",
    "announced": "Announced",
    "bidding": "Bidding",
    "awaiting": "Awaiting agreement",
    "assigned": "Assigned",
    "in_progress": "In progress",
    "completed": "Completed",
    "no_eligible": "No eligible robot",
    "release_requested": "Release requested",
    "cancel_requested": "Cancel requested",
    "cancelled": "Cancelled",
}


class HubAgent:
    def __init__(self, transport: MeshTransport, participants: list[str], log: Callable[..., None], on_complete: Callable[[dict], None]):
        self.tx = transport
        self.participants = sorted(participants, key=robot_key)
        self.log = log
        self.on_complete = on_complete  # unlocks dependent tasks
        self.online = True
        self.tasks: dict[str, dict] = {}
        self.order: list[str] = []
        self.rounds: dict[int, dict] = {}
        self.current: int | None = None
        self.next_round = 1
        self.heard: dict[str, dict] = {}  # robot -> last heartbeat
        self.inbox_count = 0

    # ---------- tasks ----------

    def add_task(self, task: dict, ready: bool) -> None:
        t = {**task, "revision": 1, "state": "queued" if ready else "waiting", "owner": None, "assignmentId": None, "roundId": None,
             "done": 0, "total": 4 if task["kind"] == "survey" else len(task.get("units") or []) or 1, "deferred": False, "rounds": [], "history": []}
        self.tasks[t["id"]] = t
        self.order.append(t["id"])

    def make_ready(self, task_id: str) -> None:
        t = self.tasks.get(task_id)
        if t and t["state"] == "waiting":
            t["state"] = "queued"

    def _undefer(self) -> None:
        for t in self.tasks.values():
            if t["deferred"]:
                t["deferred"] = False
                if t["state"] == "no_eligible":
                    t["state"] = "queued"

    def _announce(self, t: dict, round_id: int | None, **extra) -> None:
        payload = {"kind": t["kind"], "label": t["label"], "x": t["x"], "y": t["y"], "priority": t["priority"], "requires": t["requires"],
                   "units": t.get("units") or [], "rect": t.get("rect"), **extra}
        if round_id is not None:
            payload["participants"] = self.rounds[round_id]["participants"]
        self.tx.send(HUB, "TASK_ANNOUNCE", task_id=t["id"], revision=t["revision"], round_id=round_id, payload=payload)

    # ---------- rounds ----------

    def _open_round(self, t: dict) -> None:
        rid = self.next_round
        self.next_round += 1
        self.rounds[rid] = {"id": rid, "taskId": t["id"], "revision": t["revision"], "participants": list(self.participants),
                            "openedAt": self.tx.now, "lastAnnounce": self.tx.now, "bids": {}, "reasons": {}, "agrees": {},
                            "commit": None, "status": "open", "closedAt": None, "outcome": None}
        self.current = rid
        t["roundId"] = rid
        t["rounds"].append(rid)
        t["state"] = "announced"
        self._announce(t, rid)

    def _close_round(self, rnd: dict, status: str, outcome: str) -> None:
        if rnd["status"] != "open":
            return
        rnd["status"] = status
        rnd["closedAt"] = self.tx.now
        rnd["outcome"] = outcome
        if self.current == rnd["id"]:
            self.current = None

    def step(self) -> None:
        if not self.online:
            return
        now = self.tx.now
        for t in self.tasks.values():
            # Keep telling the owner to stop until it confirms (it may be out of reach).
            if t["state"] in ("release_requested", "cancel_requested") and now - t.get("lastAnnounce", -1e9) >= ALLOC["reannounceS"]:
                t["lastAnnounce"] = now
                self._announce(t, None, **({"cancelled": True} if t["state"] == "cancel_requested" else {"release": True}))
        if self.current is not None:
            rnd = self.rounds[self.current]
            t = self.tasks[rnd["taskId"]]
            if now - rnd["lastAnnounce"] >= ALLOC["reannounceS"]:
                rnd["lastAnnounce"] = now
                self._announce(t, rnd["id"])
            return
        queue = [self.tasks[i] for i in self.order if self.tasks[i]["state"] == "queued" and not self.tasks[i]["deferred"]]
        if queue:
            queue.sort(key=lambda t: (-t["priority"], t["seq"]))
            self._open_round(queue[0])

    # ---------- inbox ----------

    def receive(self, pkt: dict) -> None:
        if not self.online:
            return
        self.inbox_count += 1
        h = getattr(self, f"_on_{pkt['type'].lower()}", None)
        if h:
            h(pkt)

    def _round(self, pkt: dict) -> dict | None:
        rnd = self.rounds.get(pkt["round_id"]) if pkt["round_id"] is not None else None
        if rnd and pkt["revision"] == rnd["revision"]:
            return rnd
        return None

    def _on_bid(self, pkt: dict) -> None:
        rnd = self._round(pkt)
        if not rnd or pkt["origin_id"] not in rnd["participants"]:
            return
        p = pkt["payload"]
        rnd["bids"].setdefault(pkt["origin_id"], p.get("score"))
        rnd["reasons"].setdefault(pkt["origin_id"], p.get("reason"))
        t = self.tasks[rnd["taskId"]]
        if rnd["status"] == "open" and t["state"] == "announced":
            t["state"] = "bidding"
        if rnd["status"] == "open" and len(rnd["bids"]) == len(rnd["participants"]) and all(v is None for v in rnd["bids"].values()):
            # Every participant declined; robots reach the same conclusion and stop.
            self._close_round(rnd, "no_eligible", "No eligible robot")
            t["state"] = "no_eligible"
            t["deferred"] = True
            # Every robot just declined this kind of work; don't run the same round for each
            # similar queued task. They wait until a robot reports it's free again.
            held = 0
            for o in self.tasks.values():
                if o["state"] == "queued" and o["requires"] == t["requires"] and not o["deferred"]:
                    o["deferred"] = True
                    held += 1
            more = f" {held} similar task{'s' if held != 1 else ''} wait too." if held else ""
            self.log("info", f"{t['label']}: no eligible robot right now (round {rnd['id']}).{more} They go back to bidding when a robot frees up.")

    def _on_agree(self, pkt: dict) -> None:
        rnd = self._round(pkt)
        if not rnd or pkt["origin_id"] not in rnd["participants"]:
            return
        p = pkt["payload"]
        rnd["agrees"][pkt["origin_id"]] = {"winner": p.get("winner"), "fp": p.get("fp")}
        t = self.tasks[rnd["taskId"]]
        if rnd["status"] == "open" and t["state"] in ("announced", "bidding"):
            t["state"] = "awaiting"

    def _on_commit(self, pkt: dict) -> None:
        rnd = self._round(pkt)
        if not rnd:
            return
        self._apply_commit(rnd, pkt["payload"]["owner"], pkt["payload"]["assignmentId"])

    def _apply_commit(self, rnd: dict, owner: str, assignment_id: str) -> None:
        if rnd["commit"]:
            return  # duplicates can't create another owner
        rnd["commit"] = {"owner": owner, "assignmentId": assignment_id}
        t = self.tasks[rnd["taskId"]]
        if rnd["status"] == "open":
            self._close_round(rnd, "committed", f"Assigned to {owner}")
        if t["state"] in ("completed", "cancelled") or t["revision"] != rnd["revision"]:
            return
        t["state"], t["owner"], t["assignmentId"] = "assigned", owner, assignment_id
        self.log("info", f"{t['label']} assigned to {owner} by agreement (round {rnd['id']}).", owner)

    def _on_status(self, pkt: dict) -> None:
        p = pkt["payload"]
        t = self.tasks.get(pkt["task_id"])
        if not t or (pkt["revision"] is not None and pkt["revision"] < t["revision"]):
            return  # old task revision
        state = p.get("state")
        if state == "attempt_cancelled":
            rnd = self._round(pkt)
            if rnd and rnd["status"] == "open":
                self._close_round(rnd, "cancelled", f"{p.get('owner')} {p.get('reason', 'unavailable')} before commit")
                t["state"] = "queued"
                self.log("warn", f"{t['label']}: round {rnd['id']} cancelled because {p.get('owner')} is {p.get('reason')}. A new round will open.")
            return
        if t["state"] in ("completed", "cancelled"):
            return  # stale status can't restart completed work
        owner = p.get("owner")
        if state == "in_progress":
            if t["state"] in ("assigned", "in_progress", "announced", "bidding", "awaiting") and (t["owner"] in (None, owner)):
                if t["owner"] is None:
                    rnd = self.rounds.get(pkt["round_id"])
                    if rnd:
                        self._apply_commit(rnd, owner, p.get("assignmentId"))
                t["state"], t["owner"] = "in_progress", owner
                t["done"], t["total"] = p.get("done", t["done"]), p.get("total", t["total"])
        elif state == "completed":
            if t["owner"] in (None, owner):
                t["state"], t["owner"] = "completed", owner
                t["done"] = t["total"]
                self.log("info", f"{owner} completed {t['label']}.", owner)
                self.on_complete(t)
                self._undefer()
        elif state == "released":
            if t["state"] == "cancel_requested":
                t["state"] = "cancelled"
                self.log("info", f"{owner} stopped {t['label']}; task cancelled.", owner)
            elif t["state"] == "release_requested":
                t["state"], t["owner"], t["assignmentId"] = "queued", None, None
                t["done"] = 0
                self.log("info", f"{owner} confirmed release of {t['label']}; it goes back to bidding.", owner)
            self._undefer()

    def _on_heartbeat(self, pkt: dict) -> None:
        rid = pkt["origin_id"]
        p = pkt["payload"]
        prev = self.heard.get(rid)
        self.heard[rid] = {"at": self.tx.now, **p}
        if p.get("available") and not (prev and prev.get("available")):
            self._undefer()
        a = p.get("assignment")
        if not a:
            return
        # Reconcile anything we missed (e.g. the hub was off when the COMMIT went out).
        t = self.tasks.get(a["taskId"])
        if not t or a["revision"] != t["revision"]:
            return
        rnd = self.rounds.get(a["roundId"])
        if rnd and not rnd["commit"] and a["state"] in ("in_progress", "completed"):
            self._apply_commit(rnd, rid, a["id"])
        if a["state"] == "in_progress" and t["state"] in ("assigned", "in_progress") and t["owner"] == rid:
            t["state"], t["done"], t["total"] = "in_progress", a["done"], a["total"]
        if a["state"] == "completed" and t["state"] not in ("completed", "cancelled") and t["owner"] in (None, rid):
            self._on_status({"task_id": t["id"], "revision": a["revision"], "round_id": a["roundId"], "payload": {"state": "completed", "owner": rid}})

    # ---------- manager actions ----------

    def cancel(self, task_id: str) -> str:
        t = self.tasks.get(task_id)
        if not t:
            return f"No task {task_id}."
        if t["state"] in ("completed", "cancelled"):
            return f"{t['label']} is already {t['state']}."
        t["revision"] += 1
        if t["roundId"] and self.rounds[t["roundId"]]["status"] == "open":
            self._close_round(self.rounds[t["roundId"]], "cancelled", "Task cancelled by the manager")
        if t["state"] in ("assigned", "in_progress", "release_requested"):
            t["state"] = "cancel_requested"
            t["lastAnnounce"] = self.tx.now
            self._announce(t, None, cancelled=True)
            return f"Cancelling {t['label']}: told {t['owner']} to stop. It stays assigned until {t['owner']} confirms."
        t["state"] = "cancelled"
        self._announce(t, None, cancelled=True)
        return f"Cancelled {t['label']}."

    def release(self, task_id: str) -> str:
        t = self.tasks.get(task_id)
        if not t:
            return f"No task {task_id}."
        if t["state"] not in ("assigned", "in_progress"):
            return f"{t['label']} isn't assigned (it's {STATE_LABEL[t['state']].lower()}), so there's nothing to release."
        t["revision"] += 1
        t["state"] = "release_requested"
        t["lastAnnounce"] = self.tx.now
        self._announce(t, None, release=True)
        return f"Asked {t['owner']} to release {t['label']}. A new round opens once {t['owner']} confirms it has stopped."

    def set_priority(self, task_id: str, priority: int) -> str:
        t = self.tasks.get(task_id)
        if not t:
            return f"No task {task_id}."
        if t["state"] not in ("waiting", "queued", "no_eligible"):
            return f"{t['label']} is {STATE_LABEL[t['state']].lower()}; priority only changes for tasks that haven't been allocated."
        t["priority"] = priority
        t["revision"] += 1
        return f"{t['label']} priority set to {priority}."

    # ---------- view ----------

    def owner_uncertain(self, t: dict) -> bool:
        if t["state"] not in ("assigned", "in_progress", "release_requested", "cancel_requested") or not t["owner"]:
            return False
        h = self.heard.get(t["owner"])
        return not h or self.tx.now - h["at"] > ALLOC["uncertainS"]

    def round_view(self, rnd: dict) -> dict:
        return {
            "id": rnd["id"], "taskId": rnd["taskId"], "revision": rnd["revision"], "status": rnd["status"], "outcome": rnd["outcome"],
            "participants": rnd["participants"],
            "bids": {k: v for k, v in rnd["bids"].items() if v is not None}, "declined": [k for k, v in rnd["bids"].items() if v is None], "reasons": rnd["reasons"], "agrees": rnd["agrees"], "commit": rnd["commit"],
            "openedAt": rnd["openedAt"], "closedAt": rnd["closedAt"],
            "stalled": rnd["status"] == "open" and self.tx.now - rnd["openedAt"] > ALLOC["stallS"],
            "ageS": round((rnd["closedAt"] or self.tx.now) - rnd["openedAt"], 1),
        }

    def task_view(self, t: dict) -> dict:
        return {
            "id": t["id"], "label": t["label"], "kind": t["kind"], "requires": t["requires"], "priority": t["priority"], "revision": t["revision"],
            "state": t["state"], "stateLabel": STATE_LABEL["held" if t["state"] == "queued" and t["deferred"] else t["state"]], "owner": t["owner"], "assignmentId": t["assignmentId"],
            "roundId": t["roundId"], "rounds": t["rounds"][-6:], "done": t["done"], "total": t["total"], "x": t["x"], "y": t["y"],
            "uncertain": self.owner_uncertain(t), "deferred": t["deferred"],
        }
