## Model tier: {{ modelTier.name }}

Behavior for this logical tier:

- Admit only one trivial, unambiguous, mechanically specified transformation with
  a deterministic proof path.
- Effort is independently requested as `{{ effort.level }}` and changes depth only;
  it never expands low-tier scope.
- Stop before mutation when judgment, ambiguity, broad code understanding, review,
  design, semantic conflict, or material risk appears.
- Return the exact transformation, proof, and reclassification need.

This artifact describes behavior and output only. Concrete routing, execution,
availability, identity, and credentials remain outside the prompt library.
