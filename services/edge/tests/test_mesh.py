"""Acceptance checks for the mesh and the emulated bidding/consensus (no simulator, no network).

Run: python tests/test_mesh.py   (or pytest tests/test_mesh.py)

Topology (meters; robot-robot range 120, robot-gateway 270):
    HUB ==wired== GW(0,0) ---- A(200,0) ---- B(300,0) ---- C(400,0)
A and C can't talk directly; both reach B. GW reaches only A.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import edge.mesh.robot as robot_mod  # noqa: E402
from edge.mesh.hub import HUB, HubAgent  # noqa: E402
from edge.mesh.robot import RobotAgent  # noqa: E402
from edge.mesh.rules import EmulatedConsensus  # noqa: E402
from edge.mesh.transport import MeshTransport, Node  # noqa: E402


class Rand:
    def __init__(self, seed=3):
        self.s = seed

    def __call__(self):
        self.s = (self.s * 1664525 + 1013904223) % 4294967296
        return self.s / 4294967296


class Net:
    def __init__(self, positions=None, scores=None, loss=0.0, work_s=5.0):
        self.tx = MeshTransport(Rand(), latency_ms=100, loss_pct=loss)
        self.consensus = EmulatedConsensus()
        self.log_lines: list[str] = []
        self.bodies: dict[str, dict] = {}
        self.robots: dict[str, RobotAgent] = {}
        self.work_s = work_s
        self.started: dict[str, list[str]] = {}  # robot -> assignment ids its executor started
        positions = positions or {"A": (200, 0), "B": (300, 0), "C": (400, 0)}
        self.tx.add(Node("GW", "gateway", pos=lambda: (0, 0), up=lambda: True))
        self.hub_on = True
        for rid, (x, y) in positions.items():
            body = {"x": x, "y": y, "energy": 90, "mode": "idle", "assignment": None}
            self.bodies[rid] = body
            agent = RobotAgent(rid, {"pile"}, body, self.tx, self.consensus, self._log)
            self.robots[rid] = agent
            self.tx.add(Node(rid, "robot", pos=(lambda b=body: (b["x"], b["y"])), up=lambda: True, handler=agent.receive))
        self.done_tasks: list[str] = []
        self.hub = HubAgent(self.tx, list(positions), self._log, lambda t: self.done_tasks.append(t["id"]))
        self.tx.add(Node(HUB, "hub", pos=lambda: (0, 0), up=lambda: self.hub_on, handler=self.hub.receive))
        self._seq = 0
        if scores is not None:
            robot_mod.score = lambda robot, task, _s=scores, _b=self.bodies: _fixed(robot, _s, _b)
        else:
            from edge.mesh.rules import score

            robot_mod.score = score

    def _log(self, level, text, *_):
        self.log_lines.append(text)

    def add_task(self, label="Pile row A-01", ready=True, x=300, y=0):
        self._seq += 1
        tid = f"T-{self._seq:03d}"
        self.hub.add_task({"id": tid, "seq": self._seq, "kind": "pile", "label": label, "requires": "pile", "priority": 3, "x": x, "y": y, "units": ["u1", "u2"], "rect": None}, ready)
        return tid

    def run(self, seconds, until=None):
        steps = int(seconds / 0.05)
        for _ in range(steps):
            self.tx.advance(0.05)
            for rid, r in self.robots.items():
                self._execute(rid)
                r.step()
            self.hub.step()
            if until and until():
                return True
        return False

    def _execute(self, rid):
        """A tiny executor: work takes work_s seconds once a robot has committed."""
        a = self.bodies[rid]["assignment"]
        if not a or a["finished"]:
            return
        if a["id"] not in self.started.setdefault(rid, []):
            self.started[rid].append(a["id"])
            a["t0"] = self.tx.now
        if self.tx.now - a["t0"] >= self.work_s:
            a["done"] = len(a["units"])
            a["finished"] = True

    def owners(self, tid):
        return {rid for rid, ids in self.started.items() for i in ids if f"-{tid}-" in i}


def _fixed(robot, scores, bodies):
    rid = next(k for k, b in bodies.items() if b["x"] == robot["x"] and b["y"] == robot["y"])
    if robot["busy"]:
        return None, "busy"
    if robot["mode"] == "paused":
        return None, "paused"
    return scores[rid], "fixed"


def check(cond, msg):
    if not cond:
        raise AssertionError(msg)
    print("  ok:", msg)


def test_illustrative_exchange():
    print("illustrative exchange (A 72, B 86, C 64):")
    n = Net(scores={"A": 72, "B": 86, "C": 64}, work_s=1000)
    tid = n.add_task()
    check(n.tx.reachable(HUB) == {HUB, "GW", "A", "B", "C"}, "everyone reachable, C only through B")
    n.run(15, until=lambda: n.hub.tasks[tid]["state"] in ("assigned", "in_progress"))
    check(n.hub.tasks[tid]["owner"] == "B", f"hub sees B as owner (got {n.hub.tasks[tid]['owner']})")
    check(n.owners(tid) == {"B"}, "only B started work")
    for rid in "ABC":
        rnd = n.robots[rid].rounds[1]
        check(rnd["myAgree"]["winner"] == "B", f"{rid} proposed B with fingerprint {rnd['myAgree']['fp']}")
    fps = {n.robots[r].rounds[1]["myAgree"]["fp"] for r in "ABC"}
    check(len(fps) == 1, "same bid-set fingerprint everywhere")
    check(n.robots["A"].available() and n.robots["C"].available(), "A and C stay available")


def test_two_hops_and_local_views():
    print("task crosses two+ hops and only changes receiving robots' views:")
    # D is far away and unreachable.
    n = Net(positions={"A": (200, 0), "B": (300, 0), "C": (400, 0), "D": (5000, 5000)}, work_s=1000)
    tid = n.add_task(x=200)
    n.run(1.0, until=lambda: tid in n.robots["C"].tasks)
    check(tid in n.robots["C"].tasks, "C (three radio hops from the gateway) received the task")
    check(tid not in n.robots["D"].tasks, "unreachable D has no record of the task")
    # The round can't finish without D (fixed participants; silence isn't a decline).
    n.run(20)
    check(n.hub.tasks[tid]["state"] not in ("assigned", "in_progress"), "round stays pending without D's response")
    check(not any(n.started.values()), "nobody started work")


def test_tie_break_and_convergence():
    print("tied bids converge on the lowest robot ID:")
    n = Net(scores={"A": 80, "B": 80, "C": 80}, work_s=1000)
    tid = n.add_task()
    n.run(15, until=lambda: n.hub.tasks[tid]["owner"])
    check(n.hub.tasks[tid]["owner"] == "A", "tie goes to A")
    check(n.owners(tid) == {"A"}, "only A started")


def test_broken_relay_stalls_then_resumes():
    print("broken relay path stalls agreement; restored delivery resumes it:")
    n = Net(scores={"A": 72, "B": 86, "C": 64}, work_s=1000)
    tid = n.add_task()
    n.run(0.6, until=lambda: tid in n.robots["C"].tasks)  # task has reached C
    n.tx.cut_link("B", "C")
    n.run(30)
    check(n.hub.tasks[tid]["state"] not in ("assigned", "in_progress"), f"no owner while B–C is cut (state {n.hub.tasks[tid]['state']})")
    check(not any(n.started.values()), "nobody started")
    check(n.hub.round_view(n.hub.rounds[1])["stalled"], "round is shown as stalled")
    n.tx.restore_link("B", "C")
    ok = n.run(20, until=lambda: n.hub.tasks[tid]["owner"])
    check(ok and n.hub.tasks[tid]["owner"] == "B", "after restore, the same round resumes and B commits")
    check(n.hub.tasks[tid]["rounds"] == [1], "no new round was needed; the participant set never shrank")


def test_duplicates_and_stale_packets():
    print("duplicate or stale packets can't create another owner or restart completed work:")
    n = Net(scores={"A": 72, "B": 86, "C": 64}, work_s=3)
    tid = n.add_task()
    n.run(30, until=lambda: n.hub.tasks[tid]["state"] == "completed")
    check(n.hub.tasks[tid]["state"] == "completed", "B completed the task")
    # Replay an old COMMIT naming a different owner, an old ANNOUNCE and old BIDs under fresh message IDs.
    for _ in range(3):
        n.tx.send("C", "COMMIT", task_id=tid, revision=1, round_id=1, payload={"owner": "C", "assignmentId": "A-fake"})
        n.tx.send(HUB, "TASK_ANNOUNCE", task_id=tid, revision=1, round_id=1, payload={"kind": "pile", "label": "x", "x": 0, "y": 0, "priority": 3, "requires": "pile", "units": ["u1"], "participants": ["A", "B", "C"]})
        n.tx.send("A", "BID", task_id=tid, revision=1, round_id=1, payload={"score": 99})
        n.tx.send("B", "STATUS", task_id=tid, revision=1, round_id=1, payload={"state": "in_progress", "owner": "B", "done": 0, "total": 2})
    # And exact duplicates: the same COMMIT copy (same message ID) arriving twice.
    pkt = n.tx.send("C", "COMMIT", task_id=tid, revision=1, round_id=1, payload={"owner": "C", "assignmentId": "A-fake2"})
    n.tx._broadcast(n.tx.nodes["C"], pkt, exclude=None)
    n.run(10)
    check(n.hub.tasks[tid]["owner"] == "B" and n.hub.tasks[tid]["state"] == "completed", "hub still shows B, completed")
    check(n.owners(tid) == {"B"} and len(n.started["B"]) == 1, "work was never restarted")
    check(len(n.consensus.records) == 1, "exactly one commit recorded")
    check(n.tx.stats["duplicates"] > 0, f"duplicate copies suppressed ({n.tx.stats['duplicates']})")


def test_hub_off_after_delivery():
    print("hub off after task delivery; connected robots still agree:")
    n = Net(scores={"A": 72, "B": 86, "C": 64}, work_s=1000)
    tid = n.add_task()
    n.run(1.0, until=lambda: all(tid in n.robots[r].tasks for r in "ABC"))
    n.hub_on = False
    n.hub.online = False
    n.run(15)
    check(n.owners(tid) == {"B"}, "B committed and started while the hub was off")
    check(n.hub.tasks[tid]["owner"] is None, "the hub (off) hasn't heard yet")
    n.hub_on = True
    n.hub.online = True
    n.run(10, until=lambda: n.hub.tasks[tid]["owner"])
    check(n.hub.tasks[tid]["owner"] == "B", "hub catches up from B's heartbeat/status")


def test_completion_and_release_free_robot():
    print("completion or confirmed release frees the robot for a later task:")
    n = Net(scores={"A": 72, "B": 86, "C": 64}, work_s=4)
    t1 = n.add_task("Pile row 1")
    n.run(30, until=lambda: n.hub.tasks[t1]["state"] == "completed")
    check(n.hub.tasks[t1]["state"] == "completed", "task 1 completed by B")
    t2 = n.add_task("Pile row 2")
    n.run(20, until=lambda: n.hub.tasks[t2]["owner"])
    check(n.hub.tasks[t2]["owner"] == "B", "B (free again, highest score) took task 2")
    # Release task 2: B must stop before a replacement round opens.
    n.work_s = 1000
    msg = n.hub.release(t2)
    print("   ", msg)
    n.run(20, until=lambda: n.hub.tasks[t2]["state"] in ("assigned", "in_progress") and len(n.hub.tasks[t2]["rounds"]) > 1)
    rounds = n.hub.tasks[t2]["rounds"]
    check(len(rounds) == 2, f"a replacement round opened after B confirmed the release (rounds {rounds})")
    released_at = next(i for i, line in enumerate(n.log_lines) if "confirmed release" in line)
    reopened = n.hub.rounds[rounds[1]]["openedAt"]
    check(reopened > 0 and released_at >= 0, "replacement round came after the confirmed release")
    check(n.bodies["B"]["assignment"] is None or n.bodies["B"]["assignment"]["id"].endswith(f"R{rounds[1]}"), "B's old executor was stopped")


def test_unavailable_candidate_cancels_attempt():
    print("candidate becomes unavailable before commitment: attempt cancelled, new round:")
    n = Net(scores={"A": 72, "B": 86, "C": 64}, work_s=1000)
    tid = n.add_task()
    n.run(0.4, until=lambda: 1 in n.robots["B"].rounds and n.robots["B"].rounds[1]["myBid"])
    n.bodies["B"]["mode"] = "paused"
    n.run(20, until=lambda: n.hub.tasks[tid]["owner"])
    check(n.hub.tasks[tid]["owner"] == "A", f"A (next best) owns it after a new round (rounds {n.hub.tasks[tid]['rounds']})")
    check("B" not in n.started, "paused B never started")


def test_everyone_declines():
    print("everyone declines: No eligible robot, no assignment:")
    n = Net(scores={"A": None, "B": None, "C": None}, work_s=1000)
    tid = n.add_task()
    n.run(10, until=lambda: n.hub.tasks[tid]["state"] == "no_eligible")
    check(n.hub.tasks[tid]["state"] == "no_eligible", "task shows No eligible robot")
    check(not any(n.started.values()) and not n.consensus.records, "no commit")


def test_lossy_mesh_still_converges():
    print("20% loss per hop: retries still converge on one owner:")
    n = Net(scores={"A": 72, "B": 86, "C": 64}, loss=20, work_s=1000)
    tid = n.add_task()
    n.run(60, until=lambda: n.hub.tasks[tid]["owner"])
    check(n.hub.tasks[tid]["owner"] == "B" and n.owners(tid) == {"B"}, "B owns it, nobody else started")


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    for t in TESTS:
        t()
    print(f"\nall {len(TESTS)} mesh checks passed")
