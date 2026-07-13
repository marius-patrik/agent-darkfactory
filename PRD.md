# DarkFactory PRD

> This file defines the DarkFactory component contract. The root Agent OS PRD
> owns product scope, versioning, and publication. DarkFactory enforces each
> managed repository's own `PRD.md` as the source for that repository's backlog.

## Vision

DarkFactory is the GitHub-native control-plane component of Agent OS. **GitHub is the remote user control plane**: the owner steers managed repository work by editing PRDs, filing or labeling issues, and commenting on PRs. DarkFactory turns PRDs into sequenced backlogs, backlog into Agent OS work turns, and reviewed work into merged code. Local execution, identity, memory, models, and state remain exclusively owned by Agent OS.

The manual workflow it absorbs is a human-driven orchestrator fanning out workers to audit packages, synthesize a roadmap, sequence issues across repositories, run parallel streams, and close the loop with review gates. DarkFactory makes that durable and reconstructible from GitHub state while delegating every model-backed turn to the canonical Agent OS runtime.

## Identity and current state

- GitHub App **mp-agents** (App ID 3827239), installed account-wide (`repository_selection: all`, contents + PRs write). Secrets `DARK_FACTORY_APP_ID` / `DARK_FACTORY_PRIVATE_KEY` configured; `CODEX_AUTH_JSON` available for worker auth.
- Existing assets: webhook server (`src/bot.ts`, `src/server.ts`), managed-file sync (`src/managed-sync.ts`, `src/managed-files.ts` reading the canonical `agent-os-data/managed-repository` child), isolated CI Codex reviewer, and repository-setup enforcement.
- Runtime strategy: GitHub Actions owns deterministic schedule, dispatch, and control-repository events. Managed repository `df:ready` labels and `/df run` comments are picked up by the orchestrator or webhook path without exposing control-repository secrets. Model-backed workers run only on trusted `df-local` self-hosted runners through the canonical `agents` launcher and Agent OS state.

## Product boundary and integration principle

DarkFactory is a separate GitHub-native product with its own repository,
version history, issues, releases, and operational ledger repository. It
integrates with Agent OS for local provider execution, identity, memory,
sessions, and secrets, but neither product is absorbed into the other. The
layering is:

- `packages/core/src/harness` is the canonical managed runtime for Agent OS sessions, orchestration, memory injection, and worker execution.
- **DarkFactory** owns GitHub control-plane translation (issues, labels, PRs,
  comments, and work units), deterministic orchestration, enforcement sync,
  review gates, and authenticated operational ledgers in
  `marius-patrik/darkfactory-data`.
- **Agent OS** owns local provider execution, identity, memory, sessions,
  secrets, and the canonical `.agents` state authority. DarkFactory delegates
  model turns through the `agents` launcher and does not duplicate that state.
- `packages/core/src/inference` and `packages/core/src/gateway` provide the model/execution substrate; `packages/core/src/manager` owns package, state, memory, sessions, providers, and secrets; the Agent OS root PRD binds the components into one program.

Every DarkFactory milestone must preserve this integration boundary: a complete
independent product that composes cleanly with Agent OS through explicit
contracts.

## Token economy (first-class design principle)

DarkFactory **automates** the orchestration work style; it does not replicate it with model calls. Deterministic code is the default; AI tokens are spent only where judgment is irreplaceable. Concretely:

- **Zero-token by default**: sequencing (priority + Blocked-by graph resolution), dispatch, concurrency caps, branch/PR/label/merge mechanics, dashboards, state reconstruction, enforcement conformance checks (required-file lists, CI conclusions, git cleanliness), and PRD↔backlog structural diffing are ALL pure code — no model in the loop.
- **Tokens only for**: implementing issues (L3 workers — the core spend), writing issue bodies from PRD deltas when a template can't, semantic deep audits (rare, scheduled sparsely), review gates, and L0 escalation runs.
- **L0 is a state machine first**: each orchestrator tick runs deterministic rules (ready→dispatch, blocked→requeue, red→file incident issue). An AI orchestrator run happens ONLY when the rules hit an explicit "needs judgment" condition (conflicting priorities, repeated worker failure, PRD ambiguity) — and its brief is minimal, not a global context dump.
- **Small briefs**: workers get the issue body + acceptance criteria + AGENTS.md pointer, not repository dumps; context is fetched by the worker on demand.
- **Measured**: every loop records its token spend in the run ledger; token cost per merged PR is a tracked metric and a standing optimization target.

## Architecture

- **Control plane**: GitHub — PRD.md (product truth), issues (work units, sequenced via labels + `Blocked-by: #N` body headers), labels (`P0|P1|P2`, `df:ready`, `df:running`, `df:blocked`, `stream:<name>`), PR checks (CI + Codex Review), comments (slash commands), Actions (execution triggers).
- **Execution plane**: trusted `df-local` workers invoke `agents run` with the issue as the task brief and repository `AGENTS.md` + PRD as context. One worker = one issue = one branch = one PR. The isolated Codex review container remains an external CI boundary only.
- **State**: GitHub repositories and `.darkfactory/` control metadata plus the single Agent OS state authority under `$AGENTS_HOME`; no DarkFactory-owned database, model state, or memory.
- **Managed data**: exactly one `agent-os-data` registration at `$AGENTS_ROOT/data/agent-os`; DarkFactory reads only its `managed-repository` child and accepts no alternate path.
- **Policy**: the managed `.darkfactory/` files define orchestration, enforcement, labels, branching, and installer expectations.

## Core loops

- [x] **L0 Orchestrator** (NEW — replaces the orchestrator session): a scheduled brain run, with additional control-repository triggers, using a synthesized global-state brief: all installed repos' git/CI/backlog/PRD state, stream ledgers, open blockers. Managed repository pickup is schedule-driven through cron orchestrate ticks and workflow-run chaining. Each run does exactly what the human-driven orchestrator session does today: assess state, plan/replan waves, sequence and ready issues, dispatch L3 workers within concurrency caps, unstick blocked lanes, post a status digest to the dashboard, and escalate genuinely owner-only decisions as labeled question issues (`df:ask-owner`) instead of blocking. The orchestrator holds no memory outside GitHub — every run reconstructs state from repos, ledgers in `.darkfactory/`, and issue history, so it is fully resumable and replaceable.
- [x] **L1 Sync** (exists — harden): managed repository-local baseline files pushed to every installed repo via PRs. Executable DarkFactory workflow/script payloads come from this package; shared policy and repository context come from `$AGENTS_ROOT/data/agent-os/managed-repository`; duplicate ownership fails closed. DarkFactory manages itself first.
- [x] **L2 Review** (exists on some repos — universalize): Codex Review gate on every PR, Docker-isolated, schema-validated verdicts; merge blocked until green.
- [x] **L3 Work** (NEW — the heart): pick next `df:ready` issue respecting priority + `Blocked-by` + stream lane → create branch `df/<issue>-<slug>` → worker implements with validation → push → open PR referencing the issue → gates run → automerge on green → issue closes. Failure paths: worker comments its blocker on the issue, labels `df:blocked`, releases the lane.
- [x] **L4 Planning** (NEW): scheduled + on-PRD-change reconciliation — parse PRD.md, diff against open backlog, file/update/close issues so backlog ≡ PRD, maintain sequencing labels and `Blocked-by` graphs. This is the PRD-as-source-of-truth enforcement.
- [x] **L5 Audit** (NEW): scheduled deep audits per repo (git state, health, enforcement conformance, PRD drift, doc staleness) producing findings-as-issues — the automated version of the fleet audit that bootstrapped this roadmap.
- [x] **L6 Orchestration** (NEW): cross-repo waves and streams — parallel lanes per package, concurrency caps, wave gates (hygiene before enforcement before features), a status dashboard (pinned issue or Project) updated by the bot.

## User controls (all on GitHub)

- Edit `PRD.md` → L4 replans the backlog (PRD-edit triggers run in the edited repository with the repository token).
- Label an issue `df:ready` (or let L4 auto-ready sequenced work) → the issue is queued for L3 dispatch on the next scheduled orchestrator tick or workflow-run chain.
- Comment `/df plan`, `/df audit`, or `/df pause` on issues/PRs → the request is scoped to that repo/issue where a control-repository bridge exists.
- `workflow_dispatch` for manual wave starts; until the webhook server is deployed, `/df run` in managed repositories is represented by `df:ready` and picked up on the next scheduled orchestrator tick, while the control-repository orchestrator dispatches L3 workers across managed repositories via `workflow_dispatch` so app/Codex secrets stay out of managed-repo workflows.
- Merge/close/comment exactly as on any repo — the bot treats human actions as authoritative.

## Milestones

- [x] **M1 — Minimum work loop (dogfood ASAP)**: Actions workflow in DarkFactory that spawns a codex worker for one scheduled `df:ready` issue, with control-repository event triggers as a low-latency path only where control secrets are present → branch → PR → existing review gate → automerge. Acceptance: one issue in a target repo goes label-to-merged after scheduled pickup with zero terminal use. First dogfood targets: `dream` (small), then `agents-plugin`.
- [x] **M2 — Planning loop / PRD enforcement**: PRD→backlog reconciliation for one repo, then all. Acceptance: editing PRD.md files/updates sequenced issues automatically; drift report issue when code contradicts PRD.
- [x] **M3 — Orchestrator loop & streams**: L0 shipped — sequencing engine (priorities, Blocked-by graph, stream lanes, concurrency caps), cross-repo waves, scheduled orchestrator runs dispatching workers, dashboard, and `df:ask-owner` escalation. Local worker execution is delegated to the canonical Agent OS manager rather than a DarkFactory-owned provider stack.
- [x] **M4 — Audit loop**: scheduled per-repo deep audits filing findings-as-issues feeding L4 sequencing. Acceptance: a regression (dirty submodule, red CI, stale doc) is detected and issued within one schedule period.
- [x] **M5 — Full replacement**: Agent OS integration, managed-baseline evolution, self-improvement PRs, and webhook service operation through Agent OS for low latency. Acceptance: a month of managed repository work with GitHub as the remote interface and one Agent OS runtime/state authority.

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
- Self-improvement is continuous: friction found while working = new issue on DarkFactory, sequenced into the backlog.
