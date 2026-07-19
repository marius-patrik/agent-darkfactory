from __future__ import annotations

from dataclasses import dataclass

from genesis_os.sleep.spec import PromotionGateSpec
from genesis_os.types import EvaluationResult


@dataclass(frozen=True, slots=True)
class PromotionDecision:
    promote: bool
    reasons: tuple[str, ...]
    metrics: dict[str, float]


class PromotionGate:
    def __init__(self, spec: PromotionGateSpec) -> None:
        self.spec = spec

    def decide(
        self,
        *,
        parent_new: EvaluationResult,
        candidate_new: EvaluationResult,
        parent_foundation: EvaluationResult,
        candidate_foundation: EvaluationResult,
        ledger_valid: bool,
    ) -> PromotionDecision:
        reasons: list[str] = []
        parent_new_loss = parent_new.metrics["validation_loss"]
        candidate_new_loss = candidate_new.metrics["validation_loss"]
        improvement = parent_new_loss - candidate_new_loss
        if candidate_new_loss > parent_new_loss + self.spec.max_new_loss_regression:
            reasons.append(
                f"new-experience loss regressed: {parent_new_loss:.6f} -> {candidate_new_loss:.6f}"
            )
        if improvement < self.spec.min_new_loss_improvement:
            reasons.append(
                f"new-experience loss improvement {improvement:.6f} below "
                f"{self.spec.min_new_loss_improvement:.6f}"
            )
        parent_foundation_loss = parent_foundation.metrics["validation_loss"]
        candidate_foundation_loss = candidate_foundation.metrics["validation_loss"]
        allowed_foundation = parent_foundation_loss * (
            1.0 + self.spec.max_foundation_relative_regression
        )
        if candidate_foundation_loss > allowed_foundation:
            reasons.append(
                f"foundation loss regressed beyond bound: {parent_foundation_loss:.6f} -> "
                f"{candidate_foundation_loss:.6f} (allowed {allowed_foundation:.6f})"
            )
        parent_tool = parent_foundation.metrics.get("tool_name_accuracy", 0.0)
        candidate_tool = candidate_foundation.metrics.get("tool_name_accuracy", 0.0)
        if candidate_tool + self.spec.max_tool_accuracy_drop < parent_tool:
            reasons.append(
                f"tool routing accuracy dropped: {parent_tool:.4f} -> {candidate_tool:.4f}"
            )
        if self.spec.require_ledger_integrity and not ledger_valid:
            reasons.append("autobiographical ledger integrity verification failed")
        return PromotionDecision(
            promote=not reasons,
            reasons=tuple(reasons),
            metrics={
                "new_loss_parent": parent_new_loss,
                "new_loss_candidate": candidate_new_loss,
                "new_loss_improvement": improvement,
                "foundation_loss_parent": parent_foundation_loss,
                "foundation_loss_candidate": candidate_foundation_loss,
                "foundation_tool_accuracy_parent": parent_tool,
                "foundation_tool_accuracy_candidate": candidate_tool,
            },
        )
