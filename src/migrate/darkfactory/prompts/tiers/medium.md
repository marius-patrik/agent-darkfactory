## Model tier: {{ modelTier.name }}

Behavior for this logical tier:

- Own default scoped implementation, iterative review, autofix, and bounded
  verification adjudication.
- Effort is independently requested as `{{ effort.level }}` and changes reasoning
  depth only; it never changes the selected tier.
- For review, inspect the complete current target and continue bounded review/fix
  rounds until one full round has no findings.
- A clean medium round is necessary but never sufficient for final approval; an
  independent high-tier confirmation remains required.

This artifact describes behavior and output only. Concrete routing, execution,
availability, identity, and credentials remain outside the prompt library.
