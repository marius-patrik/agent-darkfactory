# Decisions

## 2026-07-11 — One Agent OS authority

- Shared identity, memory, roles, skills, sessions, providers, and model choices
  are authoritative only under `$AGENTS_HOME`.
- DarkFactory synchronizes repository-local guidance and policy; it does not
  publish or version a copied global agent floor.
- The sole `agent-os-data` registration resolves directly to the canonical
  `marius-patrik/Andromeda-data` checkout at `$AGENTS_HOME`; unrelated data
  registrations may coexist but cannot claim that repository or path.
- Local worker execution uses the canonical `agents` launcher and its configured
  defaults. DarkFactory carries no provider registry, failover list, or model pin.
- DarkFactory Autoreview uses logical model tiers through the canonical `agents`
  launcher for both issue and pull-request review. It is provider-agnostic and
  does not rely on a repository-pinned model.
- Managed setup is reviewable through pull requests and never bypasses protected
  default branches.

## 2026-07-16 — Reviewed release convergence

- Main/dev convergence means exact Git tree identity backed by trusted reviewed
  pull-request ancestry; merge-commit SHA identity is not required.
- DarkFactory never simulates SHA identity with a protected-ref write. Missing
  `dev` remains an explicit owner action because a pull request cannot target a
  nonexistent base branch.
