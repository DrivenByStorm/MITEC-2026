"""End-to-end: survey -> plan -> construction over the WebSocket, with the agent faked."""
import json, os, sys, time
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ["AGENT_MIN_INTERVAL_S"] = "0"
from fastapi.testclient import TestClient
from edge.server import EdgeApp, create_app
from tests.fake_claude import FakeClaude
import edge.server as srv
import asyncio


def recv_until(ws, pred, limit=4000):
    for _ in range(limit):
        m = json.loads(ws.receive_text())
        if pred(m):
            return m
    raise AssertionError("message not received")


def main():
    fake = FakeClaude()
    edge = EdgeApp(agent_client=fake)
    app = create_app(edge)
    with TestClient(app) as c:
        assert c.get("/health").json()["ok"]
        with c.websocket_connect("/ws") as ws:
            hello = json.loads(ws.receive_text())
            assert hello["type"] == "hello" and hello["stage"] == "survey" and hello["agent"]["online"]
            print("hello KB", len(json.dumps(hello)) // 1024, "terrain", hello["terrain"]["cols"], hello["terrain"]["real"])
            # chat -> proposal -> approve
            ws.send_text(json.dumps({"type": "chat", "text": "start the survey at 1.5 km"}))
            m = recv_until(ws, lambda m: m["type"] == "chat" and m["message"]["from"] == "agent")
            card = m["message"]["suggestions"][0]
            print("agent:", m["message"]["tools"], card["label"], card["status"])
            assert edge.site.survey.phase == "idle", "suggest-only: nothing should happen before approval"
            ws.send_text(json.dumps({"type": "decide", "suggestionId": card["id"], "approve": True}))
            m = recv_until(ws, lambda m: m["type"] == "chat" and m["message"]["id"] == m["message"]["id"] and any(s.get("status") == "approved" for s in m["message"].get("suggestions") or []))
            print("approved ->", m["message"]["suggestions"][0]["result"][:60])
            assert edge.site.survey.phase == "scouting"
            # speed up: tick the survey directly until review, then let the monitor fire
            s = edge.site.survey
            while s.phase != "review":
                s.tick()
            m = recv_until(ws, lambda m: m["type"] == "chat" and m["message"].get("proactive"))
            print("proactive:", m["message"]["text"], [x["label"] for x in m["message"]["suggestions"]])
            # dismiss it, lock via a direct UI action
            ws.send_text(json.dumps({"type": "decide", "suggestionId": m["message"]["suggestions"][0]["id"], "approve": False}))
            ws.send_text(json.dumps({"type": "action", "id": 1, "name": "survey.lock", "args": {}}))
            r = recv_until(ws, lambda m: m["type"] == "result")
            print("lock:", r["ok"], r["text"][:60])
            st = recv_until(ws, lambda m: m["type"] == "stage")
            assert st["stage"] == "buildup"
            # invalid action
            ws.send_text(json.dumps({"type": "action", "id": 2, "name": "plan.approve", "args": {}}))
            r = recv_until(ws, lambda m: m["type"] == "result")
            print("approve w/o plan:", r["ok"], r["text"][:70])
            ws.send_text(json.dumps({"type": "action", "id": 3, "name": "plan.generate", "args": {"unitCount": 240, "crewSize": 30}}))
            p = recv_until(ws, lambda m: m["type"] == "plan")
            print("plan:", len(p["plan"]["units"]), "units", len(p["preview"]["assets"]), "preview assets")
            ws.send_text(json.dumps({"type": "chat", "text": "approve it"}))
            m = recv_until(ws, lambda m: m["type"] == "chat" and m["message"]["from"] == "agent" and m["message"]["suggestions"])
            ws.send_text(json.dumps({"type": "decide", "suggestionId": m["message"]["suggestions"][0]["id"], "approve": True}))
            recv_until(ws, lambda m: m["type"] == "stage" and m["stage"] == "construction")
            t = recv_until(ws, lambda m: m["type"] == "twin" and m["snapshot"])
            print("twin assets", len(t["snapshot"]["assets"]))
            ws.send_text(json.dumps({"type": "chat", "text": "where is the pile robot?"}))
            m = recv_until(ws, lambda m: m["type"] == "chat" and m["message"]["from"] == "agent")
            print("where:", m["message"]["select"], m["message"]["text"][:90])
            ws.send_text(json.dumps({"type": "chat", "text": "how's it going"}))
            m = recv_until(ws, lambda m: m["type"] == "chat" and m["message"]["from"] == "agent")
            print("overview tools:", m["message"]["tools"])
            assert "error" not in m["message"]["text"].lower(), m["message"]["text"]
            ws.send_text(json.dumps({"type": "action", "id": 4, "name": "twin.request", "args": {"need": "telehandler", "target": "B7"}}))
            print("request:", recv_until(ws, lambda m: m["type"] == "result")["text"])
    # tool results never errored
    for call in fake.messages.calls:
        for msg in call["messages"]:
            if isinstance(msg["content"], list):
                for b in msg["content"]:
                    if b.get("type") == "tool_result":
                        assert '"error"' not in b["content"][:20] or "No asset" in b["content"], b["content"][:200]
    print("agent calls:", len(fake.messages.calls), "OK")


if __name__ == "__main__":
    main()
