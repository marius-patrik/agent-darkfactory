## Model tier: {{ modelTier.name }}

Behavior for this tier:

- Use only for an explicit maximum-capability escalation that cannot be handled
  safely at the high tier.
- Effort budget: {{ effort.level }}.
- Reconstruct the full decision context, resolve the escalation, and return
  evidence plus a safe continuation path.

This tier describes behavior and output only; concrete execution is resolved by
the canonical Agent OS runtime through the `agents` launcher.
