# DarkFactory PRD

> This file at the repository root is the **source of truth** for DarkFactory. DarkFactory itself enforces this convention on every repo it manages: the root `PRD.md` defines the product; the backlog, branches, PRs, and releases are derived from it. Edits to this file are the primary way to steer the product.

## Vision

DarkFactory is a GitHub-native autonomous engineering system. **GitHub is the only user control plane**: the owner steers by editing PRDs, filing/labeling issues, and commenting on PRs — nothing else. DarkFactory turns PRDs into sequenced backlogs, backlog into branches and PRs built by AI workers, PRs through enforced review gates into merged code and releases. It fully replaces the local dev-terminal workflow (interactive agent sessions driving repos by hand) with durable, observable, resumable automation.

The system it replaces looks like this (the manual workflow it must absorb): a human-driven orchestrator fans out AI workers to deep-audit every package of a monorepo, synthesizes a master roadmap, queues ~100 sequenced issues across 16 repos, runs parallel hygiene/enforcement/implementation streams, and closes the loop with review gates and releases. DarkFactory v2 makes that a product — **including the orchestrator itself**. The interactive AI orchestrator session coordinating this work today is replaced completely by DarkFactory's orchestrator loop: no terminal session, no chat thread, no human-in-the-loop except through GitHub.

## Identity & current state (v0.1)

- GitHub App **mp-agents** (App ID 3827239), installed account-wide (`repository_selection: all`, contents + PRs write). Secrets `DARK_FACTORY_APP_ID` / `DARK_FACTORY_PRIVATE_KEY` configured; `CODEX_AUTH_JSON` available for worker auth.
- Existing assets: webhook server scaffold (`src/bot.ts`, `src/server.ts`), managed-file sync (`src/managed-sync.ts`, `src/managed-files.ts` reading `data/data-agentos/managed-repository`), Docker Codex reviewer, release workflow, repo-setup enforcement.
- Runtime strategy: **GitHub Actions first** (schedule + `workflow_dispatch` + issue/PR events). The always-on webhook server is a later optimization, not a prerequisite. Workers are `codex exec` runs in Docker on Actions runners; later they dispatch to self-hosted runners/cluster via agents-manager + inference-engine.

## One system (integration principle)

DarkFactory is NOT a standalone product — it is the **GitHub control-plane adapter of one integrated system** rooted in agents-mono. The layering:

- **os/agents-harness** = the orchestration engine. The Andromeda project (migrated into the harness; its VS2–VS6 roadmap lives in harness issues #1263–#1343: cloud dispatch, cluster runtime, concurrent brain, memory, subagents, autolearn) was an attempt to implement this entire system at once — its concepts are the long-term home of orchestration: brains, workers, streams, scheduling, memory, non-progress detection.
- **DarkFactory** = the thin GitHub-native adapter: control-plane translation (issues/labels/PRs/comments ↔ work units), enforcement sync, review gates. M1–M3 ship Actions-based loops standalone so automation exists NOW, but every loop is built so its internals migrate onto harness services as the harness matures (L0 deterministic tick → harness scheduler; L3 workers → harness-managed workers/cluster; audit loop → harness observers). DarkFactory grows no second brain.
- **os/inference-engine + os/llm-gateway** = model/execution substrate; **os/agents-manager** = package/state/secrets substrate; **agents-mono root PRD** = the system-level source of truth that binds all package PRDs into one program.

Every DarkFactory milestone must state its harness-migration path. The end state is one complete project, not a bundle of separate tools.

## Token economy (first-class design principle)

DarkFactory **automates** the orchestration work style; it does not replicate it with model calls. Deterministic code is the default; AI tokens are spent only where judgment is irreplaceable. Concretely:

- **Zero-token by default**: sequencing (priority + Blocked-by graph resolution), dispatch, concurrency caps, branch/PR/label/merge mechanics, dashboards, state reconstruction, enforcement conformance checks (required-file lists, CI conclusions, git cleanliness), and PRD↔backlog structural diffing are ALL pure code — no model in the loop.
- **Tokens only for**: implementing issues (L3 workers — the core spend), writing issue bodies from PRD deltas when a template can't, semantic deep audits (rare, scheduled sparsely), review gates, and L0 escalation runs.
- **L0 is a state machine first**: each orchestrator tick runs deterministic rules (ready→dispatch, blocked→requeue, red→file incident issue). An AI orchestrator run happens ONLY when the rules hit an explicit "needs judgment" condition (conflicting priorities, repeated worker failure, PRD ambiguity) — and its brief is minimal, not a global context dump.
- **Small briefs**: workers get the issue body + acceptance criteria + AGENTS.md pointer, not repository dumps; context is fetched by the worker on demand.
- **Measured**: every loop records its token spend in the run ledger; token cost per merged PR is a tracked metric and a standing optimization target.

## Architecture

- **Control plane**: GitHub — PRD.md (product truth), issues (work units, sequenced via labels + `Blocked-by: #N` body headers), labels (`P0|P1|P2`, `df:ready`, `df:running`, `df:blocked`, `stream:<name>`), PR checks (CI + Codex Review), comments (slash commands), Actions (execution triggers).
- **Execution plane**: containerized `codex exec` workers with the repo checked out, the issue as the task brief, and repo `AGENTS.md` + PRD as context. One worker = one issue = one branch = one PR.
- **State**: the repos themselves plus `.darkfactory/` metadata (policies, stream definitions, run ledgers). No external database.
- **Policy**: `.darkfactory/policy.json` per repo — what may run automatically, worker limits, protected paths, merge rules, release rules.

## Core loops

- **L0 Orchestrator** (NEW — replaces the orchestrator session): a scheduled + event-driven brain run (AI worker with a synthesized global-state brief: all installed repos' git/CI/backlog/PRD state, stream ledgers, open blockers). Each run does exactly what the human-driven orchestrator session does today: assess state, plan/replan waves, sequence and ready issues, dispatch L3 workers within concurrency caps, unstick blocked lanes, post a status digest to the dashboard, and escalate genuinely owner-only decisions as labeled question issues (`df:ask-owner`) instead of blocking. The orchestrator holds no memory outside GitHub — every run reconstructs state from repos, ledgers in `.darkfactory/`, and issue history, so it is fully resumable and replaceable.
- **L1 Sync** (exists — harden): managed baseline files pushed to every installed repo via PRs. Baseline source: `data-agentos/managed-repository`. Must become self-applying (DarkFactory manages itself first).
- **L2 Review** (exists on some repos — universalize): Codex Review gate on every PR, Docker-isolated, schema-validated verdicts; merge blocked until green.
- **L3 Work** (NEW — the heart): pick next `df:ready` issue respecting priority + `Blocked-by` + stream lane → create branch `df/<issue>-<slug>` → worker implements with validation → push → open PR referencing the issue → gates run → automerge on green → issue closes. Failure paths: worker comments its blocker on the issue, labels `df:blocked`, releases the lane.
- **L4 Planning** (NEW): scheduled + on-PRD-change reconciliation — parse PRD.md, diff against open backlog, file/update/close issues so backlog ≡ PRD, maintain sequencing labels and `Blocked-by` graphs. This is the PRD-as-source-of-truth enforcement.
- **L5 Audit** (NEW): scheduled deep audits per repo (git state, health, enforcement conformance, PRD drift, doc staleness) producing findings-as-issues — the automated version of the fleet audit that bootstrapped this roadmap.
- **L6 Orchestration** (NEW): cross-repo waves and streams — parallel lanes per package, concurrency caps, wave gates (hygiene before enforcement before features), a status dashboard (pinned issue or Project) updated by the bot.

## User controls (all on GitHub)

- Edit `PRD.md` → L4 replans the backlog (PRD-edit triggers run in the edited repository with the repository token).
- Label an issue `df:ready` (or let L4 auto-ready sequenced work) → the issue is queued for L3 dispatch.
- Comment `/df plan`, `/df audit`, `/df pause`, `/df release` on issues/PRs → the request is scoped to that repo/issue where a control-repository bridge exists.
- `workflow_dispatch` for manual wave starts; until the webhook server is deployed, `/df run` is represented by `df:ready` plus the control-repository orchestrator dispatching L3 workers across managed repositories via `workflow_dispatch`, so app/Codex secrets stay out of managed-repo workflows.
- Merge/close/comment exactly as on any repo — the bot treats human actions as authoritative.

## Milestones

- **M1 — Minimum work loop (dogfood ASAP)**: Actions workflow in agent-darkfactory that, on `df:ready` label or `/df run`, spawns a codex worker for one issue → branch → PR → existing review gate → automerge. Acceptance: one issue in a target repo goes label-to-merged with zero terminal use. First dogfood targets: `dream` (small), then `agents-plugin`.
- **M2 — Planning loop / PRD enforcement**: PRD→backlog reconciliation for one repo, then all. Acceptance: editing PRD.md files/updates sequenced issues automatically; drift report issue when code contradicts PRD.
- **M3 — Orchestrator loop & streams**: L0 shipped — sequencing engine (priorities, Blocked-by graph, stream lanes, concurrency caps), cross-repo waves, scheduled orchestrator runs dispatching workers, dashboard, `df:ask-owner` escalation. Acceptance: the agents-mono backlog (113 issues) drains through DarkFactory in parallel lanes **with zero orchestrator terminal sessions** — the session that built this system is retired.
- **M4 — Audit loop**: scheduled per-repo deep audits filing findings-as-issues feeding L4 sequencing. Acceptance: a regression (dirty submodule, red CI, stale doc) is detected and issued within one schedule period.
- **M5 — Full replacement**: releases, managed-baseline evolution, self-improvement PRs (DarkFactory files and implements issues against its own PRD), webhook server deployment for low latency. Acceptance: a month of repo work with GitHub as the only interface.

## Non-goals (now)

- Multi-tenant / marketplace distribution; other users' accounts.
- Replacing GitHub-native review UX; the bot augments, never bypasses, gates.
- A separate web dashboard — GitHub Projects/issues are the dashboard.
- Webhook server before Actions-based loops are proven.

## Merge and follow-through policy

- Worker dispatch is only allowed when the target repository supports GitHub auto-merge; the worker preflight blocks before cloning/running Codex if it is disabled.
- On protected branches, the follow-through sweep arms GitHub auto-merge and lets the branch protection gate complete the merge.
- On unprotected branches, or when auto-merge cannot be armed because no required checks exist, the sweep may directly merge a green worker PR after verifying that all required status checks (if any) are present and passing and a short settle window has passed.
- Direct merge on a worker PR with no checks configured is only allowed when the target repository is explicitly listed in the DarkFactory no-check allowlist; otherwise the PR is skipped so a missing CI configuration cannot silently bypass the gate.
- Direct merge is never used as a bypass: red or missing required checks block the merge, and the worker issue is labeled `df:blocked`.

## Operating rules for workers

- Issue = contract: acceptance criteria in the issue body are the definition of done; validation must pass before PR.
- Never force-push, never bypass gates, never merge red, never touch parked repos (`skyblock-agent` product, `Fabrica`).
- Every action leaves a GitHub trace (comment, check, label) — silence is a bug.
- Self-improvement is continuous: friction found while working = new issue on agent-darkfactory, sequenced into the backlog.
