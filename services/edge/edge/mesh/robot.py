"""One autonomous robot's mesh agent: its inbox, its own task view, bids, agreement and assignment.

A robot learns about tasks only from packets in its inbox. It reads its own position, battery,
tools and mode from its body (the simulated machine), and when it commits to a task it hands the
work to its body's executor. Nothing else writes into its records.
"""

from __future__ import annotations

from typing import Callable

from .rules import ALLOC, EmulatedConsensus, fingerprint, score, winner
from .transport import MeshTransport

ROUND_OPEN = ("bidding", "agreeing")


class RobotAgent:
    def __init__(self, rid: str, tools: set[str], body: dict, transport: MeshTransport, consensus: EmulatedConsensus, log: Callable[..., None]):
        self.id = rid
        self.tools = tools
        self.body = body  # the simulated machine (position, energy, mode, executor slot)
        self.tx = transport
        self.consensus = consensus
        self.log = log
        self.tasks: dict[str, dict] = {}  # task_id -> what this robot knows about the task
        self.rounds: dict[int, dict] = {}  # round_id -> this robot's copy of the round
        self.early: dict[int, list[dict]] = {}  # bids/agrees that arrived before the announcement
        self.assignment: dict | None = None
        self.completed: set[str] = set()
        self.status_out: list[dict] = []  # completion / release status still to repeat
        self.inbox_count = 0
        self._next_hb = transport.rand() * ALLOC["heartbeatS"]  # robots don't all beat at once
        self._last_commit_resend: dict[int, float] = {}
        self._reported_done = 0

    # ---------- own state ----------

    def state(self) -> dict:
        b = self.body
        return {
            "x": b["x"], "y": b["y"], "battery": b["energy"], "mode": b["mode"], "tools": self.tools,
            "busy": self.assignment is not None and self.assignment["state"] not in ("completed", "released"),
        }

    def available(self) -> bool:
        s = self.state()
        return s["mode"] != "paused" and not s["busy"] and s["battery"] >= ALLOC["minBattery"]

    def _send(self, ptype: str, **kw) -> None:
        self.tx.send(self.id, ptype, **kw)

    # ---------- inbox ----------

    def receive(self, pkt: dict) -> None:
        self.inbox_count += 1
        dest = pkt["destination"]
        if dest not in ("all", self.id):
            return
        h = getattr(self, f"_on_{pkt['type'].lower()}", None)
        if h:
            h(pkt)

    def _stale(self, pkt: dict) -> bool:
        t = self.tasks.get(pkt["task_id"])
        return bool(t and pkt["revision"] is not None and pkt["revision"] < t["revision"])

    def _on_task_announce(self, pkt: dict) -> None:
        if self._stale(pkt):
            return
        p = pkt["payload"]
        tid, rev = pkt["task_id"], pkt["revision"]
        known = self.tasks.get(tid)
        if known is None or rev > known["revision"]:
            if known:
                self._task_revised(tid, rev, p)
            self.tasks[tid] = {"id": tid, "revision": rev, "kind": p["kind"], "label": p["label"], "x": p["x"], "y": p["y"],
                               "priority": p["priority"], "requires": p["requires"], "units": p.get("units", []), "rect": p.get("rect"),
                               "state": "cancelled" if p.get("cancelled") else "announced", "owner": None, "learnedAt": self.tx.now}
        if p.get("cancelled") or p.get("release") or tid in self.completed:
            return
        rid = pkt["round_id"]
        if rid is None or rid in self.rounds:
            return
        participants = list(p["participants"])
        # A newer round for the same task supersedes any older one we were still holding.
        for r in self.rounds.values():
            if r["taskId"] == tid and r["status"] in ROUND_OPEN and r["id"] < rid:
                r["status"] = "superseded"
        rnd = {"id": rid, "taskId": tid, "revision": rev, "participants": participants, "bids": {}, "agrees": {}, "status": "bidding",
               "myBid": None, "myAgree": None, "lastBidSent": -1e9, "lastAgreeSent": -1e9, "commit": None, "openedAt": self.tx.now}
        self.rounds[rid] = rnd
        if self.id in participants:
            task = self.tasks[tid]
            s, reason = score(self.state(), task)  # frozen for this round
            rnd["myBid"] = {"score": s, "reason": reason}
            rnd["bids"][self.id] = s
            self._send_bid(rnd)
        self.tasks[tid]["state"] = "bidding"
        for early in self.early.pop(rid, []):
            self.receive(early)
        self._try_agree(rnd)

    def _task_revised(self, tid: str, rev: int, p: dict) -> None:
        """The hub changed the task (cancel or release). Stop our executor first, then say so."""
        for r in self.rounds.values():
            if r["taskId"] == tid and r["status"] in ROUND_OPEN:
                r["status"] = "cancelled"
        a = self.assignment
        if a and a["taskId"] == tid and a["state"] not in ("completed", "released"):
            self.body["assignment"] = None  # executor stopped before anything else happens
            a["state"] = "released"
            a["revision"] = rev
            self.log("info", f"{self.id} stopped {a['label']} and released it ({'cancelled' if p.get('cancelled') else 'release requested'}).", self.id)
            self._queue_status(a, "released")

    def _round_for(self, pkt: dict) -> dict | None:
        rnd = self.rounds.get(pkt["round_id"])
        if rnd is None:
            if pkt["round_id"] is not None:
                self.early.setdefault(pkt["round_id"], []).append(pkt)
                del self.early[pkt["round_id"]][:-20]
                for old in sorted(self.early)[:-10]:  # rounds we never heard announced
                    del self.early[old]
            return None
        if pkt["revision"] != rnd["revision"]:
            return None  # a different task version: never mixes into this round
        return rnd

    def _on_bid(self, pkt: dict) -> None:
        if self._stale(pkt):
            return
        rnd = self._round_for(pkt)
        if not rnd or pkt["origin_id"] not in rnd["participants"]:
            return
        rnd["bids"].setdefault(pkt["origin_id"], pkt["payload"].get("score"))  # one frozen response per participant
        if rnd["status"] in ("no_winner", "committed") and pkt["payload"].get("open"):
            self._echo(rnd)
        self._try_agree(rnd)

    def _try_agree(self, rnd: dict) -> None:
        if rnd["status"] != "bidding" or any(p not in rnd["bids"] for p in rnd["participants"]):
            return  # silence is not a decline: wait for every participant
        w = winner(rnd["bids"], rnd["participants"])
        fp = fingerprint(rnd["taskId"], rnd["revision"], rnd["id"], rnd["bids"], rnd["participants"])
        rnd["myAgree"] = {"winner": w, "fp": fp}
        rnd["agrees"][self.id] = {"winner": w, "fp": fp}
        if w is None:
            rnd["status"] = "no_winner"
            self.tasks[rnd["taskId"]]["state"] = "no_eligible"
            self._send_agree(rnd)
            return
        rnd["status"] = "agreeing"
        self.tasks[rnd["taskId"]]["state"] = "awaiting"
        self._send_agree(rnd)
        self._try_commit(rnd)

    def _on_agree(self, pkt: dict) -> None:
        if self._stale(pkt):
            return
        rnd = self._round_for(pkt)
        if not rnd or pkt["origin_id"] not in rnd["participants"]:
            return
        p = pkt["payload"]
        rnd["agrees"][pkt["origin_id"]] = {"winner": p.get("winner"), "fp": p.get("fp")}
        if rnd["status"] == "committed" and rnd["commit"] and rnd["commit"]["owner"] == self.id:
            # Someone is still waiting for our COMMIT (they missed it): send it again.
            if self.tx.now - self._last_commit_resend.get(rnd["id"], -1e9) >= 1.5:
                self._last_commit_resend[rnd["id"]] = self.tx.now
                self._send_commit(rnd)
            return
        if rnd["status"] in ("no_winner", "committed") and p.get("open"):
            self._echo(rnd)
        self._try_commit(rnd)

    def _echo(self, rnd: dict) -> None:
        """We've concluded this round but a participant is still retrying, so it's missing something
        from us. Repeat our bid and agreement (rate-limited) so it can catch up."""
        if self.id not in rnd["participants"] or self.tx.now - rnd["lastBidSent"] < 2.0:
            return
        self._send_bid(rnd)
        if rnd["myAgree"]:
            self._send_agree(rnd)

    def matching_agrees(self, rnd: dict) -> int:
        mine = rnd["myAgree"]
        if not mine:
            return 0
        return sum(1 for p in rnd["participants"] if rnd["agrees"].get(p) == mine)

    def _try_commit(self, rnd: dict) -> None:
        mine = rnd["myAgree"]
        if rnd["status"] != "agreeing" or not mine or mine["winner"] != self.id:
            return
        if self.matching_agrees(rnd) < len(rnd["participants"]):
            return
        task = self.tasks[rnd["taskId"]]
        if not self.available() or task["requires"] not in self.tools:
            # We were the agreed winner but can't take it any more: cancel this attempt.
            rnd["status"] = "cancelled"
            why = "paused" if self.body["mode"] == "paused" else "no longer available"
            self.log("warn", f"{self.id} won round {rnd['id']} for {task['label']} but is {why}; attempt cancelled.", self.id)
            self._send("STATUS", task_id=task["id"], revision=rnd["revision"], round_id=rnd["id"], payload={"state": "attempt_cancelled", "owner": self.id, "reason": why})
            return
        evidence = {"fingerprint": mine["fp"], "agrees": {p: dict(rnd["agrees"][p]) for p in rnd["participants"]}, "bids": dict(rnd["bids"])}
        rec = self.consensus.record(task["id"], rnd["revision"], rnd["id"], self.id, evidence, self.tx.now)
        rnd["status"] = "committed"
        rnd["commit"] = {"owner": rec["owner"], "assignmentId": rec["assignmentId"]}
        task["state"] = "assigned"
        task["owner"] = self.id
        self._send_commit(rnd)
        self._start(task, rnd, rec["assignmentId"])

    def _on_commit(self, pkt: dict) -> None:
        if self._stale(pkt):
            return
        rnd = self._round_for(pkt)
        if not rnd:
            return
        p = pkt["payload"]
        if rnd["commit"] is None:
            rnd["commit"] = {"owner": p["owner"], "assignmentId": p["assignmentId"]}
            if rnd["status"] in ROUND_OPEN:
                rnd["status"] = "committed"
            t = self.tasks.get(rnd["taskId"])
            if t and t["state"] not in ("completed", "cancelled"):
                t["state"], t["owner"] = "assigned", p["owner"]

    def _on_status(self, pkt: dict) -> None:
        if self._stale(pkt):
            return
        p = pkt["payload"]
        t = self.tasks.get(pkt["task_id"])
        if p.get("state") == "attempt_cancelled":
            rnd = self.rounds.get(pkt["round_id"])
            if rnd and rnd["status"] in ROUND_OPEN:
                rnd["status"] = "cancelled"
            if t and t["state"] not in ("completed", "cancelled", "assigned", "in_progress"):
                t["state"] = "queued"
            return
        if not t:
            return
        if t["state"] == "completed":
            return  # completed work never goes back
        state = p.get("state")
        rnd = self.rounds.get(pkt["round_id"])
        if rnd and rnd["status"] in ROUND_OPEN and state in ("in_progress", "completed") and pkt["revision"] == rnd["revision"]:
            rnd["status"] = "committed"  # we missed the COMMIT; the owner's status tells us
            rnd["commit"] = rnd["commit"] or {"owner": p.get("owner"), "assignmentId": p.get("assignmentId")}
        if state in ("in_progress", "completed", "released", "blocked"):
            t["state"] = state
            t["owner"] = p.get("owner")
            if state == "completed":
                self.completed.add(t["id"])

    def _on_heartbeat(self, pkt: dict) -> None:
        pass  # robots don't need each other's heartbeats in this version

    # ---------- sending ----------

    def _send_bid(self, rnd: dict) -> None:
        rnd["lastBidSent"] = self.tx.now
        b = rnd["myBid"]
        self._send("BID", task_id=rnd["taskId"], revision=rnd["revision"], round_id=rnd["id"], payload={"score": b["score"], "reason": b["reason"], "open": rnd["status"] in ROUND_OPEN})

    def _send_agree(self, rnd: dict) -> None:
        rnd["lastAgreeSent"] = self.tx.now
        self._send("AGREE", task_id=rnd["taskId"], revision=rnd["revision"], round_id=rnd["id"], payload={**rnd["myAgree"], "open": rnd["status"] in ROUND_OPEN})

    def _send_commit(self, rnd: dict) -> None:
        self._send("COMMIT", task_id=rnd["taskId"], revision=rnd["revision"], round_id=rnd["id"], payload=dict(rnd["commit"]))

    def _queue_status(self, a: dict, state: str) -> None:
        self.status_out = [s for s in self.status_out if s["taskId"] != a["taskId"]]
        self.status_out.append({"taskId": a["taskId"], "revision": a["revision"], "roundId": a["roundId"], "state": state, "left": ALLOC["statusRepeats"], "next": self.tx.now})

    # ---------- executor ----------

    def _start(self, task: dict, rnd: dict, assignment_id: str) -> None:
        self.assignment = {"id": assignment_id, "taskId": task["id"], "revision": rnd["revision"], "roundId": rnd["id"], "label": task["label"],
                           "kind": task["kind"], "state": "in_progress", "done": 0, "total": 4 if task["kind"] == "survey" else len(task["units"]) or 1, "startedAt": self.tx.now}
        self._reported_done = 0
        self.body["assignment"] = {"id": assignment_id, "taskId": task["id"], "kind": task["kind"], "label": task["label"],
                                   "units": list(task["units"]), "rect": task.get("rect"), "done": 0, "finished": False}
        self.log("info", f"{self.id} committed to {task['label']} (round {rnd['id']}, {len(rnd['participants'])} of {len(rnd['participants'])} agreements).", self.id)
        self._send("STATUS", task_id=task["id"], revision=rnd["revision"], round_id=rnd["id"], payload={"state": "in_progress", "owner": self.id, "assignmentId": assignment_id, "done": 0, "total": self.assignment["total"]})

    def _follow_executor(self) -> None:
        a = self.assignment
        ex = self.body.get("assignment")
        if not a or a["state"] != "in_progress" or not ex or ex["id"] != a["id"]:
            return
        a["done"] = ex["done"]
        if ex["finished"]:
            a["state"] = "completed"
            self.completed.add(a["taskId"])
            t = self.tasks.get(a["taskId"])
            if t:
                t["state"] = "completed"
            self.body["assignment"] = None
            self.log("info", f"{self.id} finished {a['label']}.", self.id)
            self._queue_status(a, "completed")
        elif a["done"] != self._reported_done:
            self._reported_done = a["done"]
            self._send("STATUS", task_id=a["taskId"], revision=a["revision"], round_id=a["roundId"], payload={"state": "in_progress", "owner": self.id, "assignmentId": a["id"], "done": a["done"], "total": a["total"]})

    # ---------- periodic ----------

    def step(self) -> None:
        now = self.tx.now
        self._follow_executor()
        for rnd in self.rounds.values():
            if self.id not in rnd["participants"]:
                continue
            if rnd["status"] == "bidding" and now - rnd["lastBidSent"] >= ALLOC["retryS"]:
                self._send_bid(rnd)
            elif rnd["status"] == "agreeing" and now - rnd["lastAgreeSent"] >= ALLOC["retryS"]:
                self._send_agree(rnd)
                self._send_bid(rnd)  # others may still be missing our bid
        for s in list(self.status_out):
            if now >= s["next"]:
                a = self.assignment
                self._send("STATUS", task_id=s["taskId"], revision=s["revision"], round_id=s["roundId"],
                           payload={"state": s["state"], "owner": self.id, "assignmentId": a["id"] if a else None, "done": a["done"] if a else 0, "total": a["total"] if a else 0})
                s["left"] -= 1
                s["next"] = now + ALLOC["retryS"]
                if s["left"] <= 0:
                    self.status_out.remove(s)
        if now >= self._next_hb:
            self._next_hb = now + ALLOC["heartbeatS"] * (0.85 + 0.3 * self.tx.rand())
            a = self.assignment
            self._send("HEARTBEAT", payload={
                "available": self.available(), "battery": round(self.body["energy"]), "mode": self.body["mode"],
                "assignment": {k: a[k] for k in ("id", "taskId", "revision", "roundId", "state", "done", "total")} if a else None,
            })
        if len(self.rounds) > 60:
            for rid in sorted(self.rounds)[:-40]:
                if self.rounds[rid]["status"] not in ROUND_OPEN:
                    del self.rounds[rid]

    # ---------- view ----------

    def view(self) -> dict:
        a = self.assignment
        open_rounds = [r for r in self.rounds.values() if r["status"] in ROUND_OPEN]
        return {
            "id": self.id,
            "tools": sorted(self.tools),
            "available": self.available(),
            "assignment": {k: a[k] for k in ("id", "taskId", "label", "state", "done", "total", "roundId")} if a else None,
            "knownTasks": len(self.tasks),
            "inbox": self.inbox_count,
            "openRounds": [self.round_view(r) for r in sorted(open_rounds, key=lambda r: r["id"])],
        }

    def round_view(self, rnd: dict) -> dict:
        return {
            "id": rnd["id"],
            "taskId": rnd["taskId"],
            "status": rnd["status"],
            "myBid": rnd["myBid"],
            "bidsReceived": len(rnd["bids"]),
            "participants": len(rnd["participants"]),
            "proposed": rnd["myAgree"]["winner"] if rnd["myAgree"] else None,
            "matching": self.matching_agrees(rnd),
        }
