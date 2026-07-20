from __future__ import annotations

import json
import random
from pathlib import Path
from typing import Any

from genesis_os.birth.curriculum import action, prompt_for
from genesis_os.storage import ExperienceLedger
from genesis_os.training.dataset import read_examples
from genesis_os.types import Actor, Event, EventKind, TrainingExample


def _payload_text(payload: Any) -> str:
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        for key in ("content", "text", "message", "reason"):
            value = payload.get(key)
            if isinstance(value, str) and value.strip():
                return value
        return json.dumps(payload, ensure_ascii=False, sort_keys=True)
    return str(payload)


class ExperienceCompiler:
    """Converts exact Wake trajectories into selective consolidation targets."""

    def __init__(self, ledger: ExperienceLedger, *, seed: int = 1337) -> None:
        self.ledger = ledger
        self.seed = seed

    def compile(
        self,
        *,
        after_sequence: int,
        validation_fraction: float,
        max_examples: int,
        replay_paths: list[Path],
        replay_examples: int,
    ) -> tuple[list[TrainingExample], list[TrainingExample], dict[str, int]]:
        rng = random.Random(self.seed + after_sequence)
        events = self.ledger.events(
            after_sequence=after_sequence,
            limit=max(self.ledger.latest_sequence() - after_sequence, 1),
        )
        results_by_call: dict[str, Event] = {}
        for event in events:
            if event.kind == EventKind.TOOL_RESULT:
                call_id = event.payload.get("call_id")
                if isinstance(call_id, str):
                    results_by_call[call_id] = event

        examples: list[TrainingExample] = []
        counts = {"trajectory": 0, "memory": 0, "message": 0, "replay": 0}
        for event in events:
            if len(examples) >= max_examples:
                break
            if event.kind == EventKind.STATE and event.payload.get("phase") == "action_selection":
                prompt = event.payload.get("prompt")
                parsed = event.payload.get("parsed_call")
                if not isinstance(prompt, str) or not isinstance(parsed, dict):
                    continue
                call_id = parsed.get("id")
                result = results_by_call.get(call_id) if isinstance(call_id, str) else None
                if result is not None and not bool(result.payload.get("ok", False)):
                    # Failed actions remain in the ledger but are not converted into positive imitation targets.
                    continue
                target = action(str(parsed.get("tool")), dict(parsed.get("arguments", {})))
                next_context = None
                outcome = 1.0
                if result is not None:
                    next_context = prompt_for(
                        f"Tool result after action: {json.dumps(result.payload, ensure_ascii=False)}",
                        source="sleep_replay",
                    )
                examples.append(
                    TrainingExample(
                        prompt=prompt,
                        target=target,
                        task="wake_trajectory",
                        weight=max(0.5, event.importance),
                        provenance={
                            "event_id": event.id,
                            "event_hash": event.event_hash,
                            "release": event.payload.get("release"),
                            "verified_tool_success": result is None
                            or result.payload.get("ok", False),
                        },
                        next_context=next_context,
                        outcome=outcome,
                    )
                )
                counts["trajectory"] += 1
            elif event.kind == EventKind.MEMORY:
                text = _payload_text(event.payload)
                if not text.strip():
                    continue
                examples.extend(self._memory_examples(event, text))
                counts["memory"] += 3
            elif event.kind == EventKind.OBSERVATION and event.actor == Actor.USER:
                content = event.payload.get("content")
                if isinstance(content, str) and content.strip():
                    examples.append(
                        TrainingExample(
                            prompt=prompt_for(
                                "What was the exact user observation in the supplied autobiographical event?",
                                memories=[event],
                                source="sleep_memory",
                            ),
                            target=action("communication.respond", {"text": content}),
                            task="autobiographical_user_recall",
                            weight=1.0,
                            provenance={"event_id": event.id, "event_hash": event.event_hash},
                        )
                    )
                    counts["message"] += 1

        replay_pool: list[TrainingExample] = []
        for path in replay_paths:
            if path.exists():
                replay_pool.extend(read_examples(path))
        if replay_pool and replay_examples > 0:
            if len(replay_pool) > replay_examples:
                replay_pool = rng.sample(replay_pool, replay_examples)
            for example in replay_pool:
                examples.append(
                    example.model_copy(
                        update={
                            "weight": min(example.weight, 1.0),
                            "provenance": {
                                **example.provenance,
                                "sleep_replay": True,
                            },
                        }
                    )
                )
            counts["replay"] += len(replay_pool)

        rng.shuffle(examples)
        if len(examples) < 2:
            return examples, [], counts
        validation_size = max(1, int(len(examples) * validation_fraction))
        return examples[validation_size:], examples[:validation_size], counts

    @staticmethod
    def _memory_examples(event: Event, text: str) -> list[TrainingExample]:
        base = {
            "event_id": event.id,
            "event_hash": event.event_hash,
            "source": event.source,
        }
        return [
            TrainingExample(
                prompt=prompt_for(
                    "Recall the exact content of this autobiographical memory.",
                    memories=[event],
                    source="sleep_memory",
                ),
                target=action("communication.respond", {"text": text}),
                task="autobiographical_content",
                weight=max(1.0, event.importance),
                provenance=base,
            ),
            TrainingExample(
                prompt=prompt_for(
                    "Give the immutable event identifier supporting this memory.",
                    memories=[event],
                    source="sleep_memory",
                ),
                target=action("communication.respond", {"text": event.id}),
                task="autobiographical_provenance",
                weight=1.0,
                provenance=base,
            ),
            TrainingExample(
                prompt=prompt_for(
                    "When was this memory recorded? Return the exact ISO timestamp.",
                    memories=[event],
                    source="sleep_memory",
                ),
                target=action("communication.respond", {"text": event.timestamp.isoformat()}),
                task="autobiographical_chronology",
                weight=0.8,
                provenance=base,
            ),
        ]
