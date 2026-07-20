"""One inference worker turn."""

from __future__ import annotations

import copy
import json
from dataclasses import dataclass
from typing import Any

from agent.loop.context_assembler import ContextAssembler
from agent.loop.gateway_client import LoopError
from agent.loop.permissions import approve
from agent.loop.persistence import append_event, append_short
from agent.loop.tools import TOOLS, tool_schemas


@dataclass(frozen=True)
class TurnResult:
    """Result of a single turn."""

    needs_another_turn: bool
    finish_reason: str | None


async def run_turn(session: Any) -> TurnResult:
    """Run one assemble → model → tools cycle."""
    messages = ContextAssembler().assemble(session)
    response = await session.gateway_client.chat_completion(
        messages,
        tool_schemas(),
        session.config.model,
        tool_choice="auto",
    )
    assistant_message = {k: v for k, v in response.items() if k in ("role", "content", "tool_calls")}
    assistant_message.setdefault("role", "assistant")
    tool_calls = assistant_message.get("tool_calls") or []
    session.messages.append(_redacted_assistant_message(assistant_message, session.redactor))
    append_short(session, f"assistant: {assistant_message.get('content') or '[tool_calls]'}")

    if tool_calls:
        for call in tool_calls:
            await _run_tool_call(session, call)
        session.turn_count += 1
        return TurnResult(needs_another_turn=True, finish_reason=response.get("finish_reason"))

    session.turn_count += 1
    return TurnResult(needs_another_turn=False, finish_reason=response.get("finish_reason"))


async def _run_tool_call(session: Any, call: dict[str, Any]) -> None:
    function = call.get("function") or {}
    name = str(function.get("name") or "")
    args = _parse_args(function.get("arguments"))
    call_id = str(call.get("id") or f"call-{session.turn_count}")
    if not approve(session.config.permission_mode, name, args):
        raise LoopError(f"Tool call denied: {name}")

    append_event(
        session,
        "tool_call",
        {"tool_call": {"call_id": call_id, "name": name, "args": args, "host": "local", "worker_id": session.config.agent_id}},
    )
    if name not in TOOLS:
        raise LoopError(f"Unknown tool: {name}")
    tool_args = dict(args)
    tool_args["_cwd"] = str(session.config.workdir)
    try:
        result = TOOLS[name](tool_args)
    except Exception as exc:
        result = {"output": str(exc), "is_error": True}
    redacted = session.redactor.redact_obj(result)
    tool_message = {
        "role": "tool",
        "tool_call_id": call_id,
        "name": name,
        "content": json.dumps(redacted, sort_keys=True),
    }
    session.messages.append(tool_message)
    append_short(session, f"tool {name}: {tool_message['content']}")
    append_event(
        session,
        "tool_result",
        {
            "tool_result": {
                "call_id": call_id,
                "output": str(redacted.get("output", "")),
                "is_error": bool(redacted.get("is_error")),
                "status": "RUN_STATUS_FAILED" if bool(redacted.get("is_error")) else "RUN_STATUS_UNRESOLVED",
                "artifact_ref": _artifact_ref(name, args),
            }
        },
    )
    if not redacted.get("is_error") and name in ("write_file", "edit_file") and "path" in args:
        session.add_written_path(str(args["path"]))


def _parse_args(raw: Any) -> dict[str, Any]:
    if isinstance(raw, dict):
        return raw
    if not raw:
        return {}
    return json.loads(str(raw))


def _redacted_assistant_message(message: dict[str, Any], redactor: Any) -> dict[str, Any]:
    """Redact assistant messages, including JSON-encoded tool arguments."""
    redacted = copy.deepcopy(message)
    for call in redacted.get("tool_calls") or []:
        function = call.get("function") if isinstance(call, dict) else None
        if not isinstance(function, dict) or "arguments" not in function:
            continue
        raw = function["arguments"]
        if isinstance(raw, str):
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError:
                function["arguments"] = redactor.redact(raw)
            else:
                function["arguments"] = json.dumps(redactor.redact_obj(parsed), sort_keys=True)
        else:
            function["arguments"] = redactor.redact_obj(raw)
    return redactor.redact_obj(redacted)


def _artifact_ref(name: str, args: dict[str, Any]) -> str:
    if name in ("write_file", "edit_file") and "path" in args:
        return str(args["path"])
    return ""
