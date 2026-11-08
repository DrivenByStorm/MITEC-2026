"""A stand-in for the Anthropic client so the agent loop can be tested without an API key."""
from types import SimpleNamespace as NS
import itertools

_ids = itertools.count(1)


def _text(t):
    return NS(type="text", text=t)


def _tool(name, inp):
    return NS(type="tool_use", id=f"toolu_{next(_ids)}", name=name, input=inp)


class FakeMessages:
    def __init__(self):
        self.calls = []

    async def create(self, **kw):
        self.calls.append(kw)
        msgs = kw["messages"]
        last = msgs[-1]
        if isinstance(last["content"], list) and last["content"] and last["content"][0].get("type") == "tool_result":
            # after tools: a short canned summary of what came back
            import json as _json
            out = [_json.loads(c["content"]) for c in last["content"]]
            first = out[0]
            if isinstance(first, dict) and "proposed" in first:
                return NS(content=[_text("I've put that up for your approval.")], stop_reason="end_turn")
            if isinstance(first, dict) and "role" in first and "task" in first:
                return NS(content=[_text(f"{first['name']} ({first['role'].lower()}) is {first['mode']}: {first['task']}. Last heard {first['lastHeardSecondsAgo']} s ago via {first.get('via', 'no relay')}.")], stop_reason="end_turn")
            if isinstance(first, dict) and "relays" in first and isinstance(first["relays"], list):
                down = [r["id"] for r in first["relays"] if r["mode"] == "offline"]
                return NS(content=[_text(f"{', '.join(down) or 'A relay'} went down. Everything rerouted through the second relay, so nothing lost contact. No action needed; I'll flag it if it doesn't come back.")], stop_reason="end_turn")
            return NS(content=[_text("(Scripted test reply: the real agent would summarize what it looked up here.)")], stop_reason="end_turn")
        text = last["content"]
        low = text.lower()
        if "[site monitor]" in low:
            if "pass complete" in low:
                return NS(content=[_text("First pass is done. I'd map the suggested gaps before planning."), _tool("propose_action", {"action": "survey.mapMore", "args": {}, "reason": "Fill the gaps next to mapped ground."})], stop_reason="tool_use")
            if "stopped sending heartbeats" in low:
                return NS(content=[_tool("get_network_status", {})], stop_reason="tool_use")
            return NS(content=[_text("NO_UPDATE")], stop_reason="end_turn")
        low = low.strip().splitlines()[-1]  # the manager's own words, after any [Manager action] notes
        if "start" in low and "survey" in low:
            return NS(content=[_tool("propose_action", {"action": "survey.start", "args": {"distanceM": 1500}, "reason": "You asked for a 1.5 km survey."})], stop_reason="tool_use")
        if "plan" in low and "units" in low:
            return NS(content=[_tool("propose_action", {"action": "plan.generate", "args": {"unitCount": 240, "crewSize": 30}, "reason": "Your inputs."})], stop_reason="tool_use")
        if "approve" in low:
            return NS(content=[_tool("propose_action", {"action": "plan.approve", "args": {}, "reason": "Plan looks good."})], stop_reason="tool_use")
        if "where" in low:
            return NS(content=[_tool("find_asset", {"query": "RPD-1"})], stop_reason="tool_use")
        if "stop" in low and "rpd" in low:
            return NS(content=[_tool("propose_action", {"action": "robot.stop", "args": {"robot": "RPD-1"}, "reason": "You asked to stop it."})], stop_reason="tool_use")
        return NS(content=[_tool("get_site_overview", {}), _tool("get_plan", {}), _tool("list_assets", {"issue": "stopped"}), _tool("get_recent_events", {"limit": 3}), _tool("list_alerts", {}), _tool("get_tasks", {}), _tool("get_network_status", {}), _tool("get_survey_status", {})], stop_reason="tool_use")


class FakeClaude:
    def __init__(self):
        self.messages = FakeMessages()
