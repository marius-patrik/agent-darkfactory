# DarkFactory PRD

> This file defines the DarkFactory product contract. Andromeda owns the
> integration-root contract; DarkFactory owns its product scope, versioning,
> and publication. DarkFactory enforces each
> managed repository's own `PRD.md` as the source for that repository's backlog.

## Vision

DarkFactory is the GitHub-native control-plane component of Agent OS. **GitHub is the remote user control plane**: the owner steers managed repository work by editing PRDs, filing or labeling issues, and commenting on PRs. DarkFactory turns PRDs into sequenced backlogs, backlog into Agent OS work turns, and reviewed work into merged code. Local execution, identity, memory, models, and state remain exclusively owned by Agent OS.

The manual workflow it absorbs is a human-driven orchestrator fanning out workers to audit packages, synthesize a roadmap, sequence issues across repositories, run parallel streams, and close the loop with review gates. DarkFactory makes that durable and reconstructible from GitHub state while delegating every model-backed turn to the canonical Agent OS runtime.

## Identity and current state

- GitHub App **mp-agents** (App ID 3827239), installed account-wide (`repository_selection: all`). Product workflows retain their required contents/actions/issues/PR write grants; repository doctor additionally requires read-only administration, checks, secrets, and commit-status visibility and downscopes each minted token. Secrets `DARK_FACTORY_APP_ID` / `DARK_FACTORY_PRIVATE_KEY` are configured; provider credentials remain under canonical Agent OS authority.
- Existing assets: webhook server (`src/bot.ts`, `src/server.ts`), managed-file sync (`src/managed-sync.ts`, `src/managed-files.ts`), provider-agnostic DarkFactory Autoreview, repository doctor, and repository-setup enforcement. Managed sync resolves the sole canonical Andromeda-data authority at `$AGENTS_HOME`; unrelated data registrations may coexist without claiming that repository or path.
- Runtime strategy: GitHub Actions owns deterministic schedule, dispatch, and control-repository events. The evaluator alone applies or revokes managed-repository `df:ready`; `/df run` requests that same evaluation and never writes readiness directly. The orchestrator or webhook path picks up the derived state without exposing control-repository secrets. Model-backed workers run only on trusted `df-local` self-hosted runners through the canonical `agents` launcher and Agent OS state.

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
- **Small composed briefs**: workers get one checksummed role/policy/tier/effort/repository/output composition with delimited issue data and verified state, not repository dumps; repository guidance is fetched from the isolated checkout on demand.
- **Measured**: every loop records its token spend in the run ledger; token cost per merged PR is a tracked metric and a standing optimization target.

## Architecture

- **Control plane**: GitHub — PRD.md (product truth), issues (work units, sequenced via labels + `Blocked-by: #N` body headers), labels (`P0|P1|P2`, evaluator-owned `df:ready`, `df:running`, `df:blocked`, `stream:<name>`), PR checks (Validate + DarkFactory Autoreview), comments (slash commands), Actions (execution triggers).
- **Execution plane**: trusted `df-local` workers invoke `agents run` with independently authorized model tier and effort. One worker = one issue = one branch = one PR. DarkFactory Autoreview uses bounded medium review/fix rounds and an independent high confirmation through the same canonical Agent OS boundary.
- **State**: GitHub repositories and `.darkfactory/` control metadata plus the single Agent OS state authority under `$AGENTS_HOME`; no DarkFactory-owned database, model state, or memory.
- **Managed data**: canonical Andromeda-data is checked out at `$AGENTS_HOME`; DarkFactory reads only its `managed-repository` child. No alternate state root or second checkout authority is permitted. Runtime receipts use the separate darkfactory-data ledger authority.
- **Policy**: the managed `.darkfactory/` files define orchestration, enforcement, labels, branching, and installer expectations.

## Core loops

- [x] **L0 Orchestrator** (NEW — replaces the orchestrator session): a scheduled brain run, with additional control-repository triggers, using a synthesized global-state brief: all installed repos' git/CI/backlog/PRD state, stream ledgers, open blockers. Managed repository pickup is schedule-driven through cron orchestrate ticks and workflow-run chaining. Each run does exactly what the human-driven orchestrator session does today: assess state, plan/replan waves, sequence and ready issues, dispatch L3 workers within concurrency caps, unstick blocked lanes, post a status digest to the dashboard, and escalate genuinely owner-only decisions as labeled question issues (`df:ask-owner`) instead of blocking. The orchestrator holds no memory outside GitHub — every run reconstructs state from repos, ledgers in `.darkfactory/`, and issue history, so it is fully resumable and replaceable.
- [x] **L1 Sync** (exists — harden): managed repository-local baseline files pushed to every installed repo via PRs. Executable DarkFactory workflow/script payloads come from this package; shared policy and repository context come from `$AGENTS_HOME/managed-repository`; duplicate ownership fails closed. DarkFactory manages itself first, while runtime receipts remain in darkfactory-data.
- [x] **L2 Review**: provider-agnostic DarkFactory Autoreview performs medium-tier review-to-clean, high-tier final confirmation, issue review, bounded hash-bound autofix, and durable per-round receipts through canonical Agent OS. Agent OS alone resolves providers, models, authentication, and policy-authorized pre-turn fallback. Merge is blocked until the exact check is green.
- [x] **L3 Work** (NEW — the heart): pick next `df:ready` issue respecting priority + `Blocked-by` + stream lane → create branch `df/<issue>-<slug>` → worker implements with validation → push → open PR referencing the issue → gates run → automerge on green → issue closes. Failure paths: worker comments its blocker on the issue, labels `df:blocked`, releases the lane.
- [x] **L4 Planning** (NEW): scheduled + on-PRD-change reconciliation — parse PRD.md, diff against open backlog, file/update/close issues so backlog ≡ PRD, maintain sequencing labels and `Blocked-by` graphs. This is the PRD-as-source-of-truth enforcement.
- [x] **L5 Repository doctor**: deterministic diagnose/report engine for branch/release truth, protections, checks, managed drift, issue dependencies, repository boundaries/layout, submodules, local checkout state, and worker-session cwd isolation. Diagnosis is read-only; explicit report mode reconciles stable findings-as-issues; repair is separate.
- [x] **L6 Orchestration** (NEW): cross-repo waves and streams — parallel lanes per package, concurrency caps, wave gates (hygiene before enforcement before features), a status dashboard (pinned issue or Project) updated by the bot.
- [x] **L7 Release convergence**: one marker-owned, resumable engine classifies main/dev ancestry and exact Git trees, reconciles main-ahead or diverged state through reviewed heads, releases verified dev through `release/<sha>`, proves current Validate plus high-confirmed Autoreview evidence, verifies declared tag/artifact/publication policy, and emits downstream receipts without force, bypass, or default-branch writes. The selected invariant is reviewed PR ancestry plus exact tree identity, so normal merge-commit SHA differences converge without a protected-ref write. Missing-dev recovery alone remains fail-closed behind an App-owned owner-action issue because a PR cannot target a nonexistent base branch.
- [x] **L8 Human development CLI**: `df` is the canonical executable and
  `darkfactory` is its exact compatibility alias. A versioned command registry
  exposes repository, issue, planning, work, PR, release, submodule, run,
  receipt, runner, and explanation surfaces with safe read-only defaults and
  per-command trust/permission/failure help. Interactive issue drafting uses
  the high model tier with independently selected effort, keeps atomic local
  draft state, runs the shared issue Autoreview/autofix protocol, shows the
  final diff, and requires exact reviewed-digest approval before idempotent
  publication. A separate zero-token trusted-main hygiene loop inventories
  bounded canonical Agent OS draft state, emits sanitized durable owner
  reminders after a versioned threshold, and expires review evidence until an
  explicit owner resume completes a fresh high confirmation; it never drafts,
  publishes, or deletes content. Existing issue/PR commands require explicit versions; stale
  state, missing canonical Agent OS, unresolved owner decisions, malformed
  model output, or incomplete receipts block before semantic mutation.

## User controls (all on GitHub)

- Edit `PRD.md` → L4 replans the backlog (PRD-edit triggers run in the edited repository with the repository token).
- Resolve issue-contract or environment findings and remove any owner brake; the machine evaluator applies `df:ready` only when the complete current predicate passes, and dispatch recomputes that predicate before claiming work. Humans never apply the readiness label.
- Comment `/df plan`, `/df doctor`, or `/df pause` on issues/PRs → the request is scoped to that repo/issue where a control-repository bridge exists. CLI/workflow doctor diagnosis is already available; bot command parity is tracked by #39.
- Run `df help <command>` for the same engines from a human terminal. `df issue
  ready` reports the evaluator verdict and never labels an issue directly;
  `df lane resume` requests re-evaluation and never force-applies readiness.
- `workflow_dispatch` can request an immediate evaluation or wave observation. `/df run` is an evaluation request bound to the current issue version; it neither labels nor dispatches directly. The control-repository orchestrator remains the sole L3 dispatcher across managed repositories so app and provider credentials stay out of managed-repo workflows.
- Merge/close/comment exactly as on any repo — the bot treats human actions as authoritative.

## Milestones

- [x] **M1 — Minimum work loop (dogfood ASAP)**: Actions workflow in DarkFactory that spawns a canonical Agent OS worker for one scheduled `df:ready` issue, with control-repository event triggers as a low-latency path only where control secrets are present → branch → PR → existing review gate → automerge. Acceptance: one issue in a target repo goes label-to-merged after scheduled pickup with zero terminal use.
- [x] **M2 — Planning loop / PRD enforcement**: PRD→backlog reconciliation for one repo, then all. Acceptance: editing PRD.md files/updates sequenced issues automatically; drift report issue when code contradicts PRD.
- [x] **M3 — Orchestrator loop & streams**: L0 shipped — sequencing engine (priorities, Blocked-by graph, stream lanes, concurrency caps), cross-repo waves, scheduled orchestrator runs dispatching workers, dashboard, and `df:ask-owner` escalation. Local worker execution is delegated to the canonical Agent OS manager rather than a DarkFactory-owned provider stack.
- [x] **M4 — Repository-doctor loop**: scheduled deterministic diagnosis and explicit per-finding issue reconciliation feeding L4 sequencing. Acceptance: branch/protection drift, managed drift, stale/red PRs, issue contradictions, submodule drift, and observable local-state violations are detected within one schedule period.
- [x] **M5 — Full replacement**: Agent OS integration, managed-baseline evolution, self-improvement PRs, and webhook service operation through Agent OS for low latency. Acceptance: a month of managed repository work with GitHub as the remote interface and one Agent OS runtime/state authority.
- [x] **M6 — Automated release lane**: `df release` status/plan/reconcile/run/verify plus the trusted scheduled/event workflow own dev-to-main convergence and post-release evidence. Acceptance: a green dev-ahead repository reaches one verified released main, linked issue closure, policy-branch preservation, exact tree convergence through reviewed PR ancestry, and a durable downstream receipt without terminal intervention; missing protected branches remain explicit owner-only recovery.

## Non-goals (now)

- Multi-tenant / marketplace distribution; other users' accounts.
- Replacing GitHub-native review UX; the bot augments, never bypasses, gates.
- A separate web dashboard — GitHub Projects/issues are the dashboard.
- Webhook server before Actions-based loops are proven.

## Merge and follow-through policy

- Worker dispatch is only allowed when the target repository supports GitHub auto-merge; the worker preflight blocks before cloning/running Agent OS if it is disabled.
- On protected branches, the follow-through sweep arms GitHub auto-merge and lets the branch protection gate complete the merge.
- Missing, inaccessible, or unprotected target-branch policy is a fail-closed setup/owner finding. A worker PR may merge only through normal auto-merge after the exact protected branch exposes current App-bound `Validate` and `DarkFactory Autoreview` gates.
- No no-check allowlist or direct-merge fallback exists. Red, pending, missing, wrong-App, or unobservable required checks block before merge and return the issue to machine evaluation after the cause is resolved.

## Operating rules for workers

- Issue = contract: acceptance criteria in the issue body are the definition of done; validation must pass before PR.
- Never force-push, never bypass gates, never merge red, never touch parked repos (`Fabrica`, `SkyAgent`, `Singularity`, or `LifeQuest`) until owner policy reactivates them.
- Every action leaves a GitHub trace (comment, check, label) — silence is a bug.
- Self-improvement is continuous: friction found while working = new issue on DarkFactory, sequenced into the backlog.
