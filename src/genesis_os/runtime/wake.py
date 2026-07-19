from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from genesis_os.config import RuntimeSettings, WorkspacePaths
from genesis_os.model.prompts import render_prompt
from genesis_os.runtime.policy import ActionPolicy
from genesis_os.storage import ArtifactStore, ExperienceLedger
from genesis_os.tools.builtins import register_builtin_tools
from genesis_os.tools.context import ToolContext
from genesis_os.tools.kernel import ToolKernel
from genesis_os.tools.policy import ToolPolicy
from genesis_os.tools.registry import ToolRegistry
from genesis_os.types import (
    Actor,
    EventDraft,
    EventKind,
    Observation,
    ToolCall,
    ToolResult,
    new_id,
)


@dataclass(slots=True)
class WakeResult:
    session_id: str
    messages: list[str] = field(default_factory=list)
    tool_results: list[ToolResult] = field(default_factory=list)
    raw_generations: list[str] = field(default_factory=list)
    yielded: bool = False
    sleep_requested: bool = False
    final_sequence: int = 0


class WakeRuntime:
    """Persistent action loop. Every organism act is forced through ToolKernel.invoke()."""

    def __init__(
        self,
        *,
        workspace: str | Path,
        policy: ActionPolicy,
        settings: RuntimeSettings | None = None,
        services: dict[str, Any] | None = None,
    ) -> None:
        self.paths = WorkspacePaths.from_root(workspace)
        self.paths.ensure()
        self.settings = settings or RuntimeSettings()
        self.policy = policy
        self.ledger = ExperienceLedger(self.paths.database)
        self.artifacts = ArtifactStore(self.paths.artifacts)
        self.registry = ToolRegistry(self.paths.dynamic_tools)
        register_builtin_tools(self.registry)
        self.registry.refresh_dynamic()
        self.kernel = ToolKernel(self.registry, ToolPolicy.from_settings(self.settings))
        self.services = dict(services or {})
        self.services.update(
            {
                "tool_registry": self.registry,
                "tool_kernel": self.kernel,
            }
        )

    async def observe(
        self,
        observation: Observation,
        *,
        session_id: str | None = None,
    ) -> WakeResult:
        session = session_id or new_id("session")
        actor = Actor.USER if observation.source in {"user", "andromeda"} else Actor.ENVIRONMENT
        observation_event = self.ledger.append(
            EventDraft(
                kind=EventKind.OBSERVATION,
                actor=actor,
                payload=observation.model_dump(mode="json"),
                session_id=session,
                importance=0.8,
                source=observation.source,
            )
        )
        context = ToolContext(
            session_id=session,
            paths=self.paths,
            settings=self.settings,
            ledger=self.ledger,
            artifacts=self.artifacts,
            services=dict(self.services),
        )
        prior_result: ToolResult | None = None
        result = WakeResult(session_id=session)
        repair_note: str | None = None
        for step in range(self.settings.max_tool_steps):
            self.registry.refresh_dynamic()
            memories = self.ledger.search(
                observation.content,
                limit=self.settings.memory_results,
            )
            active_observation = observation
            if repair_note:
                active_observation = Observation(
                    source="runtime.tool_call_repair",
                    content=(
                        "Your previous output was not a valid tool call. Emit exactly one JSON tool call. "
                        f"Parser feedback: {repair_note}"
                    ),
                    structured={"original_observation": observation.model_dump(mode="json")},
                )
            prompt = render_prompt(
                tool_catalog=self.registry.render_catalog(),
                observation=active_observation,
                memories=memories,
                prior_result=prior_result,
                self_state=self.policy.self_state,
            )
            try:
                call, raw = self.policy.generate_tool_call(
                    prompt,
                    session_id=session,
                    max_new_tokens=self.settings.max_generation_tokens,
                    temperature=self.settings.temperature,
                    top_p=self.settings.top_p,
                    tool_specs=self.registry.specs(),
                )
            except Exception as error:
                raw = getattr(error, "raw", "")
                result.raw_generations.append(str(raw))
                repair_note = f"{type(error).__name__}: {error}"
                self.ledger.append(
                    EventDraft(
                        kind=EventKind.ERROR,
                        actor=Actor.HARNESS,
                        payload={"phase": "tool_call_parse", "error": repair_note, "step": step},
                        session_id=session,
                        causation_id=observation_event.id,
                        importance=0.9,
                        source="wake.runtime",
                    )
                )
                continue
            repair_note = None
            result.raw_generations.append(raw)
            self.ledger.append(
                EventDraft(
                    kind=EventKind.STATE,
                    actor=Actor.ORGANISM,
                    payload={
                        "phase": "action_selection",
                        "prompt": prompt,
                        "raw_generation": raw,
                        "parsed_call": call.model_dump(mode="json"),
                        "step": step,
                        "release": self.policy.self_state,
                    },
                    session_id=session,
                    causation_id=observation_event.id,
                    correlation_id=call.id,
                    importance=0.7,
                    source="wake.runtime",
                )
            )
            prior_result = await self.kernel.invoke(context, call)
            result.tool_results.append(prior_result)
            if context.flags.get("yielded") or context.flags.get("sleep_requested"):
                break
        else:
            forced = await self.kernel.invoke(
                context,
                ToolCall(tool="runtime.yield", arguments={"reason": "maximum tool steps reached"}),
            )
            result.tool_results.append(forced)
        result.messages.extend(context.messages)
        result.yielded = bool(context.flags.get("yielded"))
        result.sleep_requested = bool(context.flags.get("sleep_requested"))
        result.final_sequence = self.ledger.latest_sequence()
        return result

    async def invoke_tool(
        self,
        call: ToolCall,
        *,
        session_id: str | None = None,
    ) -> ToolResult:
        session = session_id or new_id("session")
        context = ToolContext(
            session_id=session,
            paths=self.paths,
            settings=self.settings,
            ledger=self.ledger,
            artifacts=self.artifacts,
            services=dict(self.services),
        )
        return await self.kernel.invoke(context, call)
