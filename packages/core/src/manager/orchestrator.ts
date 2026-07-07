import path from "node:path";
import { mkdir } from "node:fs/promises";
import type { SharedState } from "./state";

export interface OrchestratorHeartbeat {
  lastBeatAt: string;
  nextCheckAt: string;
  provider: string;
  model: string;
}

export interface OrchestratorLedgerEntry {
  at: string;
  action: string;
  repo?: string;
  issue?: number;
  note?: string;
}

export interface OrchestratorStateDoc {
  baton: {
    holder: string;
    since: string;
    provider: string;
    model: string;
  };
  heartbeat: OrchestratorHeartbeat;
  ledger: OrchestratorLedgerEntry[];
}

export const orchestratorStateDir = (state: SharedState): string => path.join(state.stateDir, "orchestrator");

export async function ensureOrchestratorState(state: SharedState): Promise<void> {
  await mkdir(orchestratorStateDir(state), { recursive: true });
}

export function orchestratorStateMarkdown(doc: OrchestratorStateDoc): string {
  const ledgerRows = doc.ledger
    .map(
      (entry) =>
        `| ${entry.at} | ${entry.action} | ${entry.repo ?? ""} | ${entry.issue ?? ""} | ${entry.note ?? ""} |`,
    )
    .join("\n");
  return `# Orchestrator State

## Baton
- holder: ${doc.baton.holder}
- since: ${doc.baton.since}
- provider: ${doc.baton.provider}/${doc.baton.model}

## Heartbeat
- lastBeatAt: ${doc.heartbeat.lastBeatAt}
- nextCheckAt: ${doc.heartbeat.nextCheckAt}
- provider: ${doc.heartbeat.provider}/${doc.heartbeat.model}

## Ledger

| at | action | repo | issue | note |
|---|---|---|---|---|
${ledgerRows}
`;
}

function extractSection(text: string, heading: string): string {
  const pattern = new RegExp(`(?:^|\\n)## ${heading}\\n([\\s\\S]*?)(?=\\n## |\\n# |$)`);
  const match = text.match(pattern);
  return match ? match[1].trim() : "";
}

export function parseStateMarkdown(text: string): OrchestratorStateDoc {
  const doc: Partial<OrchestratorStateDoc> = {
    baton: { holder: "", since: "", provider: "", model: "" },
    heartbeat: { lastBeatAt: "", nextCheckAt: "", provider: "", model: "" },
    ledger: [],
  };

  const batonSection = extractSection(text, "Baton");
  const batonHolder = batonSection.match(/^- holder: (.+)$/m);
  const batonSince = batonSection.match(/^- since: (.+)$/m);
  const batonProvider = batonSection.match(/^- provider: (.+)\/(.+)$/m);
  if (batonHolder) doc.baton = { ...(doc.baton as OrchestratorStateDoc["baton"]), holder: batonHolder[1].trim() };
  if (batonSince) doc.baton = { ...(doc.baton as OrchestratorStateDoc["baton"]), since: batonSince[1].trim() };
  if (batonProvider) {
    doc.baton = {
      ...(doc.baton as OrchestratorStateDoc["baton"]),
      provider: batonProvider[1].trim(),
      model: batonProvider[2].trim(),
    };
  }

  const heartbeatSection = extractSection(text, "Heartbeat");
  const beatLast = heartbeatSection.match(/^- lastBeatAt: (.+)$/m);
  const beatNext = heartbeatSection.match(/^- nextCheckAt: (.+)$/m);
  const beatProvider = heartbeatSection.match(/^- provider: (.+)\/(.+)$/m);
  if (beatLast) doc.heartbeat = { ...(doc.heartbeat as OrchestratorHeartbeat), lastBeatAt: beatLast[1].trim() };
  if (beatNext) doc.heartbeat = { ...(doc.heartbeat as OrchestratorHeartbeat), nextCheckAt: beatNext[1].trim() };
  if (beatProvider) {
    doc.heartbeat = {
      ...(doc.heartbeat as OrchestratorHeartbeat),
      provider: beatProvider[1].trim(),
      model: beatProvider[2].trim(),
    };
  }

  const ledgerSection = extractSection(text, "Ledger");
  const ledgerLines = ledgerSection.split("\n").filter((line) => line.startsWith("| ") && !line.includes("---"));
  // Skip the header row.
  doc.ledger = ledgerLines.slice(1).map((line) => {
    const cells = line.split("|").map((c) => c.trim());
    return {
      at: cells[1] ?? "",
      action: cells[2] ?? "",
      repo: cells[3] || undefined,
      issue: cells[4] ? Number(cells[4]) : undefined,
      note: cells[5] || undefined,
    };
  });

  return doc as OrchestratorStateDoc;
}

export async function readOrchestratorState(state: SharedState): Promise<OrchestratorStateDoc | null> {
  const file = path.join(orchestratorStateDir(state), "STATE.md");
  if (!(await Bun.file(file).exists())) return null;
  return parseStateMarkdown(await Bun.file(file).text());
}

export async function writeOrchestratorState(state: SharedState, doc: OrchestratorStateDoc): Promise<void> {
  await ensureOrchestratorState(state);
  const file = path.join(orchestratorStateDir(state), "STATE.md");
  await Bun.write(file, orchestratorStateMarkdown(doc));
}

export async function appendOrchestratorLedger(
  state: SharedState,
  sessionId: string,
  entry: Omit<OrchestratorLedgerEntry, "at">,
): Promise<void> {
  const now = new Date().toISOString();
  const doc = (await readOrchestratorState(state)) ?? defaultOrchestratorState(state, "unknown", "unknown", sessionId);
  doc.ledger.push({ ...entry, at: now });
  await writeOrchestratorState(state, doc);
}

export async function writeOrchestratorHeartbeat(
  state: SharedState,
  sessionId: string,
  heartbeat: Omit<OrchestratorHeartbeat, "lastBeatAt" | "nextCheckAt">,
): Promise<void> {
  const now = new Date();
  const doc =
    (await readOrchestratorState(state)) ?? defaultOrchestratorState(state, heartbeat.provider, heartbeat.model, sessionId);
  doc.heartbeat = {
    ...heartbeat,
    lastBeatAt: now.toISOString(),
    nextCheckAt: new Date(now.getTime() + 60_000).toISOString(),
  };
  await writeOrchestratorState(state, doc);
}

export async function initializeOrchestratorState(
  state: SharedState,
  sessionId: string,
  provider: string,
  model: string,
): Promise<void> {
  if (await readOrchestratorState(state)) return;
  await writeOrchestratorState(state, defaultOrchestratorState(state, provider, model, sessionId));
}

export function defaultOrchestratorState(
  state: SharedState,
  provider: string,
  model: string,
  sessionId: string,
): OrchestratorStateDoc {
  const now = new Date().toISOString();
  return {
    baton: {
      holder: sessionId,
      since: now,
      provider,
      model,
    },
    heartbeat: {
      lastBeatAt: now,
      nextCheckAt: new Date(Date.now() + 60_000).toISOString(),
      provider,
      model,
    },
    ledger: [],
  };
}

export function orchestratorSystemPrompt(): string {
  return `You are the agents-mono orchestrator session.

Your job is to keep the DarkFactory automation loop healthy and moving forward.

Core behavior contract:
- VERIFY on GitHub before acting. Check workflow runs, issue labels, PR checks, and the data-agentos ledger before making decisions.
- Drive the label-driven dispatch loop: df:ready -> df:running -> df-work -> follow-through.
- Never hand-dispatch a worker CLI when the loop can carry the work. Route work through PRD items and labeled issues.
- Escalate via df:ask-owner when a decision needs Patrik; do not guess past a human blocker.
- Keep the orchestrator heartbeat and ledger under .agents/orchestrator/ in STATE.md-compatible format.
- Survive rate limits by switching provider/model when a quota error is observed; preserve session context across switches.
- Report to the user only when the loop is blocked or at takeover boundaries.

State files:
- .agents/orchestrator/STATE.md — baton holder, heartbeat, and ledger.
- The ledger records dispatch, observation, escalation, and takeover events.

You may use the switch_provider, switch_model, list_providers, and set_status tools to manage the session.`.trim();
}
