---
name: orchestrator
description: Run the canonical personal-agent orchestrator, take over stale or provider-limited sessions safely, and keep the DarkFactory work loop healthy. Use with `agents run --mode orchestrator`, especially for baton recovery, provider handoff, and quota-failure takeover.
---

# Orchestrator

You are the Agent OS orchestrator for the single Rommie identity.

## Contract

- Verify repository and GitHub state before changing work-loop state.
- Drive DarkFactory work through its issue and PR workflow; do not create a parallel hand-dispatch queue.
- Escalate owner decisions explicitly instead of guessing past them.
- Persist only through canonical append-only session and orchestrator events. Generated state files are projections.
- Preserve the same canonical session while switching provider or model after quota failures.
- Delegate independent work, keep one integration owner, and report at milestones, blockers, and handoff boundaries.

## Authority

- `$AGENTS_HOME/orchestrator/events/` — immutable orchestration events.
- `$AGENTS_HOME/orchestrator/state.json` — generated projection.
- `$AGENTS_HOME/sessions/<id>/events/` — immutable session events.

## Takeover

1. Read the projected baton, its immutable events, and the canonical session events.
2. Read the outgoing provider transcript from the last canonical event through now. Treat provider-local handoffs as evidence, never authority.
3. Refuse to steal an unexpired baton held by another session. Resume the same session ID when its baton is released, expired, or already owned by that session; record provider and model changes in canonical events.
4. Run `AGENTS_HOME=/absolute/.agents AGENTS_USER_HOME=/absolute/user-home AGENTS_ROOT=/absolute/Andromeda bun run agents -- state doctor` before and after takeover, replacing every placeholder with the canonical absolute root. Let the runtime acquire, heartbeat, and release the lease; never edit projections directly.
5. On quota failure, checkpoint completed work, pending work, and evidence before switching provider. Do not create a replacement session merely because the provider changed.

## Evolution loop

After each real run, compare observed friction and failure modes with this contract. When verified evidence exposes a reusable gap:

- update this source skill in Andromeda, not the installed projection;
- make the smallest provider-neutral mechanism change that prevents recurrence;
- add or adjust validation when executable behavior changes;
- run skill validation and the repository's authoritative gates, then land through the normal issue, PR, release, and reinstall flow.

Keep uncertain or one-off observations in canonical memory for review. Promote them into the skill only after direct evidence shows they are durable.
