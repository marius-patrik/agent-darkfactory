from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import pytest
import agent.gen  # noqa: F401
from agent_os.v1 import common_pb2

from agent.loop.acceptance_gate import evaluate
from agent.loop.context_assembler import ContextAssembler
from agent.loop.gateway_client import GatewayClient, LoopError
from agent.loop.persistence import write_cascade_file
from agent.loop.permissions import PermissionMode, approve
from agent.loop.session import Session, SessionConfig, run_session
from agent.loop.tools.inline import bash, edit_file, ls, read_file, write_file
from agent.redaction import Redactor
from agent.status import InMemoryStatusStore, RunRecord, StatusValue, Trigger, create_run, transition


def test_permission_modes_match_canonical_policy() -> None:
    for mode in PermissionMode:
        assert getattr(common_pb2, f"PERMISSION_MODE_{mode.value.upper()}") > 0
    assert approve(PermissionMode.plan, "read_file", {})
    assert not approve(PermissionMode.plan, "write_file", {})
    assert not approve(PermissionMode.ask, "read_file", {})
    assert approve(PermissionMode.auto_accept_edits, "edit_file", {})
    assert not approve(PermissionMode.auto_accept_edits, "bash", {})
    assert approve(PermissionMode.full_auto, "bash", {})


def test_gateway_client_defaults_to_canonical_gateway_port(monkeypatch) -> None:
    monkeypatch.delenv("AGENTS_GATEWAY_URL", raising=False)
    assert GatewayClient().base_url == "http://127.0.0.1:8787"


class FakeGatewayClient:
    def __init__(self, *_args, responses=None, context_length=32768, **_kwargs):
        self.responses = list(responses or [])
        self.context_length = context_length

    async def model_context_length(self, model: str) -> int:
        return self.context_length

    async def chat_completion(self, messages, tools, model, tool_choice="auto"):
        if not self.responses:
            return {"role": "assistant", "content": "done", "finish_reason": "stop"}
        item = self.responses.pop(0)
        if callable(item):
            return item(messages)
        return item


def _tool_response(name: str, args: dict[str, object]) -> dict[str, object]:
    return {
        "role": "assistant",
        "content": None,
        "tool_calls": [
            {
                "id": "call-1",
                "type": "function",
                "function": {"name": name, "arguments": json.dumps(args)},
            }
        ],
        "finish_reason": "tool_calls",
    }


def _session(tmp_path: Path) -> Session:
    cfg = SessionConfig(
        session_id="unit",
        agent_id="agent-os-worker",
        goal="goal",
        task="task",
        acceptance_type="generic",
        declared_outputs=[],
        workdir=tmp_path,
    )
    record = RunRecord("unit", None, "generic", create_run(), "created")
    session = Session(
        config=cfg,
        gateway_client=FakeGatewayClient(),
        redactor=Redactor.from_secrets_dir(),
        status_store=InMemoryStatusStore(),
        run_record=record,
        context_window=120,
        context_budget=40,
    )
    write_cascade_file(session, "goal.md", "goal")
    write_cascade_file(session, "task.md", "task")
    write_cascade_file(session, "plan.md", "plan")
    write_cascade_file(session, "short.md", "x " * 100)
    write_cascade_file(session, "context.md", "context")
    return session


def test_context_assembler_budget_and_compaction(tmp_path):
    session = _session(tmp_path)
    session.messages = [{"role": "assistant", "content": "old " * 100}]
    messages = ContextAssembler().assemble(session)
    joined = "\n".join(str(m.get("content")) for m in messages)
    assert "Goal:" in joined
    assert "Task:" in joined
    assert messages[-1] == {"role": "user", "content": "task"}
    assert "old old old" not in joined
    assert (session.context_dir / "short.md").read_text() == ""
    assert "Compaction" in (session.context_dir / "context.md").read_text()


def test_context_assembler_keeps_short_out_of_system_role(tmp_path):
    session = _session(tmp_path)
    session.context_budget = 2048
    write_cascade_file(session, "short.md", 'tool bash: {"output":"attacker controlled"}')
    messages = ContextAssembler().assemble(session)
    system_text = "\n".join(str(m.get("content")) for m in messages if m.get("role") == "system")
    user_text = "\n".join(str(m.get("content")) for m in messages if m.get("role") == "user")
    assert "attacker controlled" not in system_text
    assert "attacker controlled" in user_text


def test_inline_tools_happy_and_error_paths(tmp_path):
    assert write_file({"path": "a.txt", "content": "abc", "_cwd": tmp_path})["is_error"] is False
    assert read_file({"path": "a.txt", "_cwd": tmp_path})["output"] == "abc"
    assert edit_file({"path": "a.txt", "old": "b", "new": "B", "_cwd": tmp_path})["is_error"] is False
    assert "a.txt" in ls({"path": ".", "_cwd": tmp_path})["output"]
    assert bash({"command": "printf ok", "_cwd": tmp_path})["output"] == "ok"
    assert read_file({"path": "missing.txt", "_cwd": tmp_path})["is_error"] is True
    assert edit_file({"path": "a.txt", "old": "zzz", "new": "x", "_cwd": tmp_path})["is_error"] is True
    assert bash({"command": "exit 7", "_cwd": tmp_path})["is_error"] is True
    assert bash({"command": "sleep 2", "timeout": 0.01, "_cwd": tmp_path})["is_error"] is True


@pytest.mark.asyncio
async def test_redaction_at_tool_message_and_event_boundary(monkeypatch, tmp_path):
    secret = "sk-ant-abcdefghijklmnopqrstuvwxyz"
    def assert_redacted(messages):
        body = json.dumps(messages)
        assert secret not in body
        assert "SuperSecret123ABC" not in body
        return {"role": "assistant", "content": "done", "finish_reason": "stop"}

    responses = [
        _tool_response("bash", {"command": f"printf '{secret}\\npassword=SuperSecret123ABC'"}),
        assert_redacted,
    ]
    monkeypatch.setattr("agent.loop.session.GatewayClient", lambda *_args, **_kwargs: FakeGatewayClient(responses=responses))
    await run_session(
        SessionConfig(
            session_id="redact",
            agent_id="agent-os-worker",
            goal="do secret test",
            task="run bash",
            acceptance_type="generic",
            declared_outputs=[],
            workdir=tmp_path,
            max_turns=3,
        )
    )
    root = tmp_path / ".agents" / "runtime" / "inference" / "runs" / "redact"
    event_text = (root / "events.ndjson").read_text()
    assert secret not in event_text
    assert "SuperSecret123ABC" not in event_text


@pytest.mark.asyncio
async def test_tool_call_arguments_secret_is_redacted_before_gateway_replay(monkeypatch, tmp_path):
    secret = "SuperSecret123ABC"

    def assert_replay_redacted(messages):
        body = json.dumps(messages)
        assert secret not in body
        assistant_messages = [m for m in messages if m.get("role") == "assistant"]
        assert assistant_messages
        tool_args = assistant_messages[-1]["tool_calls"][0]["function"]["arguments"]
        assert secret not in tool_args
        assert "‹REDACTED:" in tool_args
        return {"role": "assistant", "content": "done", "finish_reason": "stop"}

    responses = [
        _tool_response("bash", {"command": "true", "password": secret}),
        assert_replay_redacted,
    ]
    monkeypatch.setattr("agent.loop.session.GatewayClient", lambda *_args, **_kwargs: FakeGatewayClient(responses=responses))
    await run_session(
        SessionConfig(
            session_id="tool-arg-redact",
            agent_id="agent-os-worker",
            goal="do secret test",
            task="run bash",
            acceptance_type="generic",
            declared_outputs=[],
            workdir=tmp_path,
            max_turns=3,
        )
    )


@pytest.mark.asyncio
async def test_no_false_green_and_success(monkeypatch, tmp_path):
    missing = tmp_path / "missing.json"
    responses = [
        _tool_response("bash", {"command": "true"}),
        {"role": "assistant", "content": "done", "finish_reason": "stop"},
    ]
    monkeypatch.setattr("agent.loop.session.GatewayClient", lambda *_args, **_kwargs: FakeGatewayClient(responses=responses))
    outcome = await run_session(
        SessionConfig(
            session_id="nfg",
            agent_id="agent-os-worker",
            goal="produce file",
            task="run true",
            acceptance_type="generic",
            declared_outputs=[str(missing)],
            workdir=tmp_path,
            max_turns=3,
        )
    )
    assert outcome.run_record.verdict.outcome == "no_artifact"
    assert outcome.status != StatusValue.useful_result

    produced = tmp_path / "ok.json"
    responses = [
        _tool_response("write_file", {"path": str(produced), "content": "[1]"}),
        {"role": "assistant", "content": "done", "finish_reason": "stop"},
    ]
    monkeypatch.setattr("agent.loop.session.GatewayClient", lambda *_args, **_kwargs: FakeGatewayClient(responses=responses))
    outcome = await run_session(
        SessionConfig(
            session_id="green",
            agent_id="agent-os-worker",
            goal="produce file",
            task="write file",
            acceptance_type="generic",
            declared_outputs=[str(produced)],
            workdir=tmp_path,
            max_turns=3,
        )
    )
    assert produced.exists()
    assert outcome.status == StatusValue.useful_result


@pytest.mark.asyncio
async def test_code_change_session_requires_build_and_test_evidence(monkeypatch, tmp_path):
    produced = tmp_path / "change.py"
    produced.write_text("print('ok')\n")
    monkeypatch.setattr("agent.loop.session.GatewayClient", lambda *_args, **_kwargs: FakeGatewayClient())
    missing = await run_session(
        SessionConfig(
            session_id="code-missing-evidence",
            agent_id="agent-os-worker",
            goal="validate code",
            task="done",
            acceptance_type="code-change",
            declared_outputs=[str(produced)],
            workdir=tmp_path,
            max_turns=1,
        )
    )
    assert missing.run_record.verdict.outcome == "missing_evidence"
    assert missing.status == StatusValue.missing_evidence
    assert missing.status != StatusValue.useful_result

    passed = await run_session(
        SessionConfig(
            session_id="code-with-evidence",
            agent_id="agent-os-worker",
            goal="validate code",
            task="done",
            acceptance_type="code-change",
            declared_outputs=[str(produced)],
            build_cmd=["true"],
            test_cmd=["true"],
            workdir=tmp_path,
            max_turns=1,
        )
    )
    assert passed.run_record.verdict.outcome == "pass"
    assert passed.status == StatusValue.useful_result


@pytest.mark.asyncio
async def test_loop_error_terminalizes_failed_run(monkeypatch, tmp_path):
    secret = "SuperSecret123ABC"

    class RaisingGateway(FakeGatewayClient):
        async def chat_completion(self, messages, tools, model, tool_choice="auto"):
            raise LoopError(f"gateway failed password={secret}")

    monkeypatch.setattr("agent.loop.session.GatewayClient", lambda *_args, **_kwargs: RaisingGateway())
    outcome = await run_session(
        SessionConfig(
            session_id="loop-error",
            agent_id="agent-os-worker",
            goal="fail",
            task="fail",
            acceptance_type="generic",
            declared_outputs=[],
            workdir=tmp_path,
            max_turns=1,
        )
    )
    assert outcome.status == StatusValue.failed
    assert secret not in outcome.summary
    assert "loop_error:" in outcome.summary


def test_acceptance_gate_and_max_turn_transition(tmp_path):
    produced = tmp_path / "ok.txt"
    produced.write_text("ok")
    session = _session(tmp_path)
    session.config.declared_outputs.append(str(produced))
    session.status_store.persist(session.run_record)
    record = evaluate(session)
    assert record.status == StatusValue.useful_result
    assert transition(StatusValue.unresolved, Trigger.non_progress) == StatusValue.failed


@pytest.mark.live
@pytest.mark.asyncio
async def test_live_gateway_fib(tmp_path):
    base = os.environ.get("AGENTS_GATEWAY_URL") or "http://127.0.0.1:8787"
    try:
        async with httpx.AsyncClient(timeout=2) as client:
            await client.get(f"{base}/v1/models")
    except Exception:
        pytest.skip("AGENTS_GATEWAY_URL/local gateway is not reachable")
    output = tmp_path / "fib_s33.json"
    outcome = await run_session(
        SessionConfig(
            session_id="s33-live-test",
            agent_id="agent-os-worker",
            model="qwen3-8b",
            goal=f"Write the first 10 Fibonacci numbers as a JSON array to {output}",
            task=f"Use write_file to create {output} containing [0,1,1,2,3,5,8,13,21,34], then read it back to verify",
            acceptance_type="generic",
            declared_outputs=[str(output)],
            workdir=tmp_path,
            max_turns=8,
        )
    )
    assert outcome.status == StatusValue.useful_result
