"""Task-class model routing policy.

The router maps work classes used by DarkFactory workers and harnesses to an
ordered set of configured model candidates. It only returns models that the
registry can actually serve, while preserving the ordered fallback policy for
callers that want to inspect why a candidate was skipped.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import yaml

from llm_gateway.quota import QuotaTracker
from llm_gateway.registry import ModelEntry, ModelRegistry, generate_request_id
from llm_gateway.trace import TraceLogger

DEFAULT_ROUTING_POLICY_PATH = Path(__file__).resolve().parent.parent / "registry" / "routing.yaml"


class TaskRoutingError(Exception):
    pass


@dataclass(frozen=True)
class RouteCandidate:
    provider: str
    model_id: str
    params: dict[str, Any]
    budget_cap_tokens: int | None = None
    budget_cap_cost_usd: float | None = None


@dataclass(frozen=True)
class RouteResolution:
    task_class: str
    provider: str
    model_id: str
    model: str
    params: dict[str, Any]
    fallback_model_ids: list[str]
    budget_cap_tokens: int | None
    budget_cap_cost_usd: float | None
    candidates: list[dict[str, Any]]

    def to_dict(self) -> dict[str, Any]:
        return {
            "task_class": self.task_class,
            "provider": self.provider,
            "model_id": self.model_id,
            "model": self.model,
            "params": self.params,
            "fallback_model_ids": self.fallback_model_ids,
            "budget_cap_tokens": self.budget_cap_tokens,
            "budget_cap_cost_usd": self.budget_cap_cost_usd,
            "candidates": self.candidates,
        }


class TaskRoutingPolicy:
    def __init__(self, policy_path: Path | None = None) -> None:
        self.policy_path = policy_path or DEFAULT_ROUTING_POLICY_PATH
        self._classes: dict[str, list[RouteCandidate]] = {}
        self.load()

    def load(self) -> None:
        if not self.policy_path.exists():
            raise TaskRoutingError(f"Routing policy file not found: {self.policy_path}")
        raw = yaml.safe_load(self.policy_path.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise TaskRoutingError("Routing policy must be a YAML object")
        if raw.get("schema_version") != "gateway-routing-v1":
            raise TaskRoutingError("Routing policy schema_version must be gateway-routing-v1")

        classes = raw.get("classes")
        if not isinstance(classes, dict) or not classes:
            raise TaskRoutingError("Routing policy requires at least one class")

        parsed: dict[str, list[RouteCandidate]] = {}
        for name, class_data in classes.items():
            if not isinstance(name, str) or not name:
                raise TaskRoutingError("Routing class names must be non-empty strings")
            if not isinstance(class_data, dict):
                raise TaskRoutingError(f"Routing class '{name}' must be an object")
            candidates = class_data.get("candidates")
            if not isinstance(candidates, list) or not candidates:
                raise TaskRoutingError(f"Routing class '{name}' requires candidates")
            parsed[name] = [self._candidate(name, item) for item in candidates]
        self._classes = parsed

    def classes(self) -> list[str]:
        return list(self._classes)

    def candidates_for(self, task_class: str) -> list[RouteCandidate]:
        try:
            return list(self._classes[task_class])
        except KeyError as exc:
            raise TaskRoutingError(f"Unknown task class '{task_class}'") from exc

    @staticmethod
    def _candidate(task_class: str, data: Any) -> RouteCandidate:
        if not isinstance(data, dict):
            raise TaskRoutingError(f"Candidate in class '{task_class}' must be an object")
        provider = data.get("provider")
        model_id = data.get("model_id")
        if not isinstance(provider, str) or not provider:
            raise TaskRoutingError(f"Candidate in class '{task_class}' requires provider")
        if not isinstance(model_id, str) or not model_id:
            raise TaskRoutingError(f"Candidate in class '{task_class}' requires model_id")
        params = data.get("params", {})
        if not isinstance(params, dict):
            raise TaskRoutingError(f"Candidate '{model_id}' params must be an object")
        budget = data.get("budget", {})
        if budget is None:
            budget = {}
        if not isinstance(budget, dict):
            raise TaskRoutingError(f"Candidate '{model_id}' budget must be an object")
        return RouteCandidate(
            provider=provider,
            model_id=model_id,
            params=params,
            budget_cap_tokens=_optional_int(budget.get("max_tokens")),
            budget_cap_cost_usd=_optional_float(budget.get("max_cost_usd")),
        )


class TaskRouter:
    def __init__(
        self,
        registry: ModelRegistry,
        policy: TaskRoutingPolicy | None = None,
        quota: QuotaTracker | None = None,
        tracer: TraceLogger | None = None,
    ) -> None:
        self.registry = registry
        self.policy = policy or TaskRoutingPolicy()
        self.quota = quota or QuotaTracker()
        self.tracer = tracer

    def resolve(self, task_class: str) -> RouteResolution:
        candidates = self.policy.candidates_for(task_class)
        inspected: list[dict[str, Any]] = []
        selected: tuple[RouteCandidate, ModelEntry] | None = None
        for candidate in candidates:
            entry = self.registry.get(candidate.model_id)
            status = self._candidate_status(candidate, entry)
            inspected.append(
                {
                    "provider": candidate.provider,
                    "model_id": candidate.model_id,
                    "available": status is None,
                    "unavailable_reason": status,
                    "params": candidate.params,
                }
            )
            if selected is None and status is None and entry is not None:
                selected = (candidate, entry)
        if selected is not None:
            candidate, entry = selected
            resolution = self._resolution(task_class, candidate, entry, candidates, inspected)
            self.quota.record_route_resolution(
                provider=resolution.provider,
                task_class=task_class,
                model_id=resolution.model_id,
            )
            if self.tracer is not None:
                self.tracer.log(
                    trace_id=generate_request_id(),
                    event_type="route.resolve",
                    model_id=resolution.model_id,
                    role=entry.role,
                    provider=resolution.provider,
                    resolved_model_id=resolution.model_id,
                    extra={
                        "task_class": task_class,
                        "params": resolution.params,
                        "fallback_model_ids": resolution.fallback_model_ids,
                    },
                )
            return resolution
        raise TaskRoutingError(f"No available model route for task class '{task_class}'")

    @staticmethod
    def _candidate_status(candidate: RouteCandidate, entry: ModelEntry | None) -> str | None:
        if entry is None:
            return "model_not_found"
        if entry.provider != candidate.provider:
            return f"provider_mismatch:{entry.provider}"
        if not entry.enabled:
            return "model_disabled"
        return None

    @staticmethod
    def _resolution(
        task_class: str,
        candidate: RouteCandidate,
        entry: ModelEntry,
        candidates: list[RouteCandidate],
        inspected: list[dict[str, Any]],
    ) -> RouteResolution:
        fallback_model_ids = [item.model_id for item in candidates if item.model_id != candidate.model_id]
        return RouteResolution(
            task_class=task_class,
            provider=entry.provider,
            model_id=entry.id,
            model=entry.model,
            params=dict(candidate.params),
            fallback_model_ids=fallback_model_ids,
            budget_cap_tokens=candidate.budget_cap_tokens,
            budget_cap_cost_usd=candidate.budget_cap_cost_usd,
            candidates=inspected,
        )


def _optional_int(value: Any) -> int | None:
    if value is None:
        return None
    return int(value)


def _optional_float(value: Any) -> float | None:
    if value is None:
        return None
    return float(value)
