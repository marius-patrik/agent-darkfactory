import { describe, expect, test } from "bun:test";
import { appendFile, lstat, mkdir, mkdtemp, open, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendSessionMessage,
  appendImportedSessionMessages,
  beginSessionTurn,
  completeSessionTurn,
  createSession,
  listSessionSummaries,
  loadSessionEvents,
  loadSessionStateReadOnly,
  loadTranscript,
  sessionPaths,
  type ImportedSessionMessage,
} from "../../sdk/harness/session";
import { exportEventBundle, importEventBundle, enableEventSync } from "../event-sync";
import { readSecret, writeSecret } from "../secrets";
import { ensureSharedState, sharedState, sharedStateAt, type SharedState } from "../state";
import {
  reconcileDesktopSessions,
  type ReconcileDesktopSessionsOptions,
} from "../session-capture";
import {
  buildSessionCaptureTaskSpec,
  createWindowsSessionCaptureScheduler,
  installSessionCapture,
  SESSION_CAPTURE_EXECUTION_LIMIT,
  SESSION_CAPTURE_INTERVAL,
  sessionCaptureStatus,
  sessionCaptureWrapper,
  sessionCaptureWrapperPath,
  uninstallSessionCapture,
  type SessionCaptureScheduler,
  type SessionCaptureTaskInfo,
} from "../session-capture-lifecycle";
import { renewableLockDatabasePath } from "../state-lock";

const CLAUDE_SESSION = "8d466c8b-498b-4a1b-b9f5-282e5e666bbc";
const CODEX_SESSION = "019f8f67-479f-72f3-8ef3-ceed3f8218dc";
const CODEX_PARENT_SESSION = "019f8ae2-1b2a-75d1-830e-9b20313548cd";
const CODEX_ROOT_SESSION = "019f7450-efa8-7fb3-b843-b01e3482ae47";
const CLI_PATH = path.resolve(import.meta.dir, "..", "cli.ts");

function cleanEnvironment(): Record<string, string | undefined> {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    if (key.startsWith("ANDROMEDA_")) delete environment[key];
  }
  return environment;
}

function jsonl(records: unknown[]): string {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

function claudeRecord(
  type: "user" | "assistant",
  uuid: string,
  timestamp: string,
  content: unknown,
): Record<string, unknown> {
  return {
    type,
    uuid,
    parentUuid: null,
    sessionId: CLAUDE_SESSION,
    timestamp,
    entrypoint: "claude-desktop",
    version: "2.1.215",
    cwd: "C:\\workspace",
    message: {
      role: type,
      model: type === "assistant" ? "claude-opus-4-8" : undefined,
      content,
    },
  };
}

function claudeRecordForSession(
  sessionId: string,
  uuid: string,
  timestamp: string,
  content: string,
  padding = "",
): Record<string, unknown> {
  return {
    ...claudeRecord("user", uuid, timestamp, content),
    sessionId,
    ...(padding.length > 0 ? { capturePadding: padding } : {}),
  };
}

function codexRecords(): unknown[] {
  return [
    {
      timestamp: "2026-07-23T10:00:00.000Z",
      type: "session_meta",
      payload: {
        id: CODEX_SESSION,
        timestamp: "2026-07-23T10:00:00.000Z",
        cwd: "C:\\workspace",
        originator: "Codex Desktop",
        cli_version: "0.145.0-alpha.27",
        model_provider: "openai",
      },
    },
    {
      timestamp: "2026-07-23T10:00:01.000Z",
      type: "turn_context",
      payload: { model: "gpt-5.4", turn_id: "turn-1" },
    },
    {
      timestamp: "2026-07-23T10:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "msg-system",
        role: "developer",
        content: [{ type: "input_text", text: "system policy" }],
      },
    },
    {
      timestamp: "2026-07-23T10:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        id: "msg-user",
        role: "user",
        content: [{ type: "input_text", text: "question" }],
      },
    },
    {
      timestamp: "2026-07-23T10:00:04.000Z",
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "private chain of thought token=do-not-copy" },
    },
    {
      timestamp: "2026-07-23T10:00:05.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "answer" },
    },
    {
      timestamp: "2026-07-23T10:00:05.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "answer" }],
      },
    },
  ];
}

function codexSessionMeta(
  id: string,
  parentThreadId: string | null,
  timestamp: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp,
    type: "session_meta",
    payload: {
      id,
      session_id: parentThreadId === null ? id : CODEX_ROOT_SESSION,
      timestamp,
      cwd: id === CODEX_SESSION ? "C:\\owner-workspace" : "C:\\ancestor-workspace",
      originator: id === CODEX_SESSION ? "Codex Desktop" : "ancestor-originator",
      cli_version: id === CODEX_SESSION ? "0.145.0-alpha.27" : "0.100.0",
      ...(parentThreadId
        ? {
            parent_thread_id: parentThreadId,
            forked_from_id: parentThreadId,
          }
        : {}),
      ...overrides,
    },
  };
}

function codexResponseMessage(
  role: "user" | "assistant",
  id: string,
  content: string,
  timestamp: string,
): Record<string, unknown> {
  return {
    timestamp,
    type: "response_item",
    payload: {
      type: "message",
      id,
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text: content }],
    },
  };
}

async function captureFixture(): Promise<{
  root: string;
  state: SharedState;
  claudeRoot: string;
  codexRoot: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-capture-"));
  const state = sharedState(root);
  await ensureSharedState(state);
  const claudeRoot = path.join(root, "provider-evidence", ".claude", "projects");
  const codexRoot = path.join(root, "provider-evidence", ".codex", "sessions");
  await mkdir(path.join(claudeRoot, "C--"), { recursive: true });
  await mkdir(path.join(codexRoot, "2026", "07", "23"), { recursive: true });
  return { root, state, claudeRoot, codexRoot };
}

describe("desktop session capture regression triplet", () => {
  test("success: backfills Claude and Codex, preserves provenance, and admits only continuing appends", async () => {
    const fixture = await captureFixture();
    try {
      const claudePath = path.join(fixture.claudeRoot, "C--", `${CLAUDE_SESSION}.jsonl`);
      const codexPath = path.join(
        fixture.codexRoot,
        "2026",
        "07",
        "23",
        `rollout-2026-07-23T10-00-00-${CODEX_SESSION}.jsonl`,
      );
      await writeFile(
        claudePath,
        jsonl([
          {
            ...claudeRecord(
              "user",
              "claude-meta-1",
              "2026-07-23T08:59:59.000Z",
              "local-command-caveat",
            ),
            isMeta: true,
          },
          claudeRecord("user", "claude-user-1", "2026-07-23T09:00:00.000Z", "hello"),
          claudeRecord("assistant", "claude-assistant-1", "2026-07-23T09:00:01.000Z", [
            { type: "thinking", thinking: "private reasoning secret=do-not-copy" },
            { type: "tool_use", id: "tool-1", name: "Read", input: { api_key: "do-not-copy" } },
            { type: "text", text: "visible answer" },
          ]),
          claudeRecord("user", "claude-tool-result", "2026-07-23T09:00:02.000Z", [
            { type: "tool_result", tool_use_id: "tool-1", content: "raw tool payload" },
          ]),
        ]),
      );
      await writeFile(codexPath, jsonl(codexRecords()));

      const first = await reconcileDesktopSessions(fixture.state, {
        claudeRoot: fixture.claudeRoot,
        codexRoot: fixture.codexRoot,
      });
      expect(first).toMatchObject({
        scannedFiles: 2,
        reconciledFiles: 2,
        importedSessions: 2,
        importedMessages: 4,
        failedFiles: 0,
      });

      const claudeId = `desktop-claude-${CLAUDE_SESSION}`;
      const codexId = `desktop-codex-${CODEX_SESSION}`;
      const claudeTranscript = await loadTranscript(fixture.state, claudeId);
      expect(claudeTranscript?.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "hello"],
        ["assistant", "visible answer"],
      ]);
      expect(JSON.stringify(claudeTranscript)).not.toContain("private reasoning");
      expect(JSON.stringify(claudeTranscript)).not.toContain("raw tool payload");
      expect(JSON.stringify(claudeTranscript)).not.toContain("api_key");
      expect(JSON.stringify(claudeTranscript)).not.toContain("local-command-caveat");
      expect(claudeTranscript?.messages[1]?.metadata).toMatchObject({
        sourceProvider: "claude",
        nativeSessionId: CLAUDE_SESSION,
        sourcePath: `.claude/projects/C--/${CLAUDE_SESSION}.jsonl`,
        sourceRecordId: "claude-assistant-1",
        sourceTimestamp: "2026-07-23T09:00:01.000Z",
      });
      const codexTranscript = await loadTranscript(fixture.state, codexId);
      expect(codexTranscript?.messages.map((message) => [message.role, message.content])).toEqual([
        ["user", "question"],
        ["assistant", "answer"],
      ]);
      expect(codexTranscript?.messages[1]?.metadata?.sourceRecordId).toMatch(
        /^response-7-[a-f0-9]{32}$/,
      );
      expect(JSON.stringify(codexTranscript)).not.toContain("system policy");
      expect(JSON.stringify(codexTranscript)).not.toContain("private chain of thought");

      const claudeEvents = await loadSessionEvents(fixture.state, claudeId);
      expect(claudeEvents[0]?.at).toBe("2026-07-23T09:00:00.000Z");
      const importedCompletion = claudeEvents.find(
        (event): event is Extract<typeof event, { type: "turn.completed" }> =>
          event.type === "turn.completed" && event.data.receipt?.sourceRecordId === "claude-assistant-1",
      );
      expect(importedCompletion?.at).toBe("2026-07-23T09:00:01.000Z");
      expect(importedCompletion?.data.receipt).toMatchObject({
        nativeSessionId: CLAUDE_SESSION,
        sourcePath: `.claude/projects/C--/${CLAUDE_SESSION}.jsonl`,
      });
      expect((await loadSessionStateReadOnly(fixture.state, claudeId))?.metadata).toMatchObject({
        exchange: "local-only",
        exchangeReason: "provider-transcript",
      });

      const unchanged = await reconcileDesktopSessions(fixture.state, {
        claudeRoot: fixture.claudeRoot,
        codexRoot: fixture.codexRoot,
      });
      expect(unchanged).toMatchObject({
        importedSessions: 0,
        importedMessages: 0,
        skippedFiles: 2,
        failedFiles: 0,
      });

      await appendFile(
        claudePath,
        jsonl([claudeRecord("user", "claude-user-2", "2026-07-23T09:00:03.000Z", "continue")]),
      );
      const continued = await reconcileDesktopSessions(fixture.state, {
        claudeRoot: fixture.claudeRoot,
        codexRoot: fixture.codexRoot,
      });
      expect(continued).toMatchObject({
        importedSessions: 0,
        existingSessions: 1,
        importedMessages: 1,
        existingMessages: 0,
        skippedFiles: 1,
        failedFiles: 0,
      });
      expect((await loadTranscript(fixture.state, claudeId))?.messages.at(-1)?.content).toBe("continue");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("continuing Codex event transport is ignored until its canonical response_item arrives", async () => {
    const fixture = await captureFixture();
    try {
      const codexPath = path.join(
        fixture.codexRoot,
        "2026",
        "07",
        "23",
        `rollout-2026-07-23T10-00-00-${CODEX_SESSION}.jsonl`,
      );
      const [sessionMeta, turnContext] = codexRecords();
      await writeFile(
        codexPath,
        jsonl([
          sessionMeta,
          turnContext,
          {
            timestamp: "2026-07-23T10:00:02.000Z",
            type: "event_msg",
            payload: { type: "agent_message", message: "event-first answer" },
          },
        ]),
      );
      const beforeResponse = await reconcileDesktopSessions(fixture.state, {
        providers: ["codex"],
        codexRoot: fixture.codexRoot,
      });
      expect(beforeResponse).toMatchObject({
        importedSessions: 0,
        importedMessages: 0,
        skippedFiles: 1,
        failedFiles: 0,
      });

      await appendFile(
        codexPath,
        jsonl([
          {
            timestamp: "2026-07-23T10:00:03.000Z",
            type: "response_item",
            payload: {
              type: "message",
              id: "canonical-response",
              role: "assistant",
              content: [{ type: "output_text", text: "event-first answer" }],
            },
          },
        ]),
      );
      const afterResponse = await reconcileDesktopSessions(fixture.state, {
        providers: ["codex"],
        codexRoot: fixture.codexRoot,
      });
      expect(afterResponse).toMatchObject({
        importedSessions: 1,
        importedMessages: 1,
        failedFiles: 0,
      });
      expect(
        (await loadTranscript(fixture.state, `desktop-codex-${CODEX_SESSION}`))?.messages.map(
          (message) => message.content,
        ),
      ).toEqual(["event-first answer"]);

      const repeat = await reconcileDesktopSessions(fixture.state, {
        providers: ["codex"],
        codexRoot: fixture.codexRoot,
      });
      expect(repeat).toMatchObject({ importedMessages: 0, skippedFiles: 1, failedFiles: 0 });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("denied failure: rejects an additional Codex session_meta instead of blending rollout identities", async () => {
    const fixture = await captureFixture();
    try {
      const codexPath = path.join(
        fixture.codexRoot,
        "2026",
        "07",
        "23",
        `rollout-2026-07-23T10-00-00-${CODEX_SESSION}.jsonl`,
      );
      const records = codexRecords();
      records.splice(1, 0, {
        timestamp: "2026-07-23T10:00:00.500Z",
        type: "session_meta",
        payload: {
          id: "019f8f67-479f-72f3-8ef3-ceed3f8218dd",
          timestamp: "2026-07-23T10:00:00.500Z",
        },
      });
      await writeFile(codexPath, jsonl(records));
      const report = await reconcileDesktopSessions(fixture.state, {
        providers: ["codex"],
        codexRoot: fixture.codexRoot,
      });
      expect(report.failedFiles).toBe(1);
      expect(report.errors[0]).toMatchObject({ code: "provider_drift", retryable: false });
      expect(await loadSessionStateReadOnly(fixture.state, `desktop-codex-${CODEX_SESSION}`)).toBeNull();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("success: validates complete and owner-only-truncated Codex lineage without importing ancestor messages", async () => {
    for (const variant of ["complete", "owner-only-truncated"] as const) {
      const fixture = await captureFixture();
      try {
        const codexPath = path.join(
          fixture.codexRoot,
          "2026",
          "07",
          "23",
          `rollout-2026-07-23T10-00-00-${CODEX_SESSION}.jsonl`,
        );
        const lineage =
          variant === "complete"
            ? [
                codexSessionMeta(
                  CODEX_SESSION,
                  CODEX_PARENT_SESSION,
                  "2026-07-23T10:00:00.000Z",
                ),
                codexSessionMeta(
                  CODEX_PARENT_SESSION,
                  CODEX_ROOT_SESSION,
                  "2026-07-22T10:00:00.000Z",
                ),
                codexSessionMeta(
                  CODEX_ROOT_SESSION,
                  null,
                  "2026-07-21T10:00:00.000Z",
                ),
              ]
            : [
                // Codex desktop sometimes stores only the owner meta while retaining
                // the root UUID in session_id; id + filename remain the owner identity.
                codexSessionMeta(
                  CODEX_SESSION,
                  CODEX_PARENT_SESSION,
                  "2026-07-23T10:00:00.000Z",
                ),
              ];
        await writeFile(
          codexPath,
          jsonl([
            ...lineage,
            codexResponseMessage(
              "user",
              "ancestor-user",
              "ancestor question",
              "2026-07-22T10:00:01.000Z",
            ),
            codexResponseMessage(
              "assistant",
              "ancestor-assistant",
              "ancestor answer",
              "2026-07-22T10:00:02.000Z",
            ),
            {
              timestamp: "2026-07-23T10:00:01.000Z",
              type: "inter_agent_communication_metadata",
              payload: { trigger_turn: true },
            },
            codexResponseMessage(
              "assistant",
              "owner-assistant",
              `owner answer ${variant}`,
              "2026-07-23T10:00:02.000Z",
            ),
          ]),
        );

        const report = await reconcileDesktopSessions(fixture.state, {
          providers: ["codex"],
          codexRoot: fixture.codexRoot,
        });
        expect(report).toMatchObject({
          importedSessions: 1,
          importedMessages: 1,
          failedFiles: 0,
        });
        const sessionId = `desktop-codex-${CODEX_SESSION}`;
        expect(
          (await loadTranscript(fixture.state, sessionId))?.messages.map(
            (message) => message.content,
          ),
        ).toEqual([`owner answer ${variant}`]);
        expect((await loadSessionStateReadOnly(fixture.state, sessionId))?.metadata).toMatchObject({
          entrypoint: "Codex Desktop",
          version: "0.145.0-alpha.27",
          sourceWorkdir: "C:\\owner-workspace",
        });
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("denied failure: rejects malformed, unlinked, repeated, and non-contiguous Codex lineage", async () => {
    const cases: Array<{ name: string; records: unknown[] }> = [
      {
        name: "unlinked",
        records: [
          codexSessionMeta(CODEX_SESSION, CODEX_PARENT_SESSION, "2026-07-23T10:00:00.000Z"),
          codexSessionMeta(CODEX_ROOT_SESSION, null, "2026-07-22T10:00:00.000Z"),
        ],
      },
      {
        name: "non-contiguous",
        records: [
          codexSessionMeta(CODEX_SESSION, CODEX_PARENT_SESSION, "2026-07-23T10:00:00.000Z"),
          codexResponseMessage("assistant", "inherited", "inherited", "2026-07-22T10:00:00.000Z"),
          codexSessionMeta(CODEX_PARENT_SESSION, null, "2026-07-22T09:00:00.000Z"),
        ],
      },
      {
        name: "repeated-owner",
        records: [
          codexSessionMeta(CODEX_SESSION, CODEX_PARENT_SESSION, "2026-07-23T10:00:00.000Z"),
          codexSessionMeta(CODEX_SESSION, null, "2026-07-22T10:00:00.000Z"),
        ],
      },
      {
        name: "cycle",
        records: [
          codexSessionMeta(CODEX_SESSION, CODEX_PARENT_SESSION, "2026-07-23T10:00:00.000Z"),
          codexSessionMeta(
            CODEX_PARENT_SESSION,
            CODEX_SESSION,
            "2026-07-22T10:00:00.000Z",
          ),
          codexSessionMeta(CODEX_SESSION, null, "2026-07-21T10:00:00.000Z"),
        ],
      },
      {
        name: "conflicting-fork",
        records: [
          codexSessionMeta(CODEX_SESSION, CODEX_PARENT_SESSION, "2026-07-23T10:00:00.000Z"),
          codexSessionMeta(
            CODEX_PARENT_SESSION,
            CODEX_ROOT_SESSION,
            "2026-07-22T10:00:00.000Z",
            { forked_from_id: CODEX_SESSION },
          ),
        ],
      },
      {
        name: "malformed-root-session-id",
        records: [
          codexSessionMeta(
            CODEX_SESSION,
            CODEX_PARENT_SESSION,
            "2026-07-23T10:00:00.000Z",
            { session_id: "not-a-uuid" },
          ),
        ],
      },
    ];

    for (const item of cases) {
      const fixture = await captureFixture();
      try {
        await writeFile(
          path.join(
            fixture.codexRoot,
            "2026",
            "07",
            "23",
            `rollout-2026-07-23T10-00-00-${CODEX_SESSION}.jsonl`,
          ),
          jsonl(item.records),
        );
        const report = await reconcileDesktopSessions(fixture.state, {
          providers: ["codex"],
          codexRoot: fixture.codexRoot,
        });
        expect(report.failedFiles, item.name).toBe(1);
        expect(report.errors[0], item.name).toMatchObject({
          code: "provider_drift",
          retryable: false,
        });
        expect(
          await loadSessionStateReadOnly(
            fixture.state,
            `desktop-codex-${CODEX_SESSION}`,
          ),
          item.name,
        ).toBeNull();
      } finally {
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  });

  test("denied failure: caps Codex lineage depth and requires an exact boolean owner trigger", async () => {
    const fixture = await captureFixture();
    try {
      const ancestors = Array.from(
        { length: 16 },
        (_, index) => `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      );
      const depthRecords = [
        codexSessionMeta(CODEX_SESSION, ancestors[0], "2026-07-23T10:00:00.000Z"),
        ...ancestors.map((id, index) =>
          codexSessionMeta(
            id,
            ancestors[index + 1] ?? null,
            `2026-07-22T10:00:${String(index).padStart(2, "0")}.000Z`,
          ),
        ),
      ];
      const codexPath = path.join(
        fixture.codexRoot,
        "2026",
        "07",
        "23",
        `rollout-2026-07-23T10-00-00-${CODEX_SESSION}.jsonl`,
      );
      await writeFile(codexPath, jsonl(depthRecords));
      const depth = await reconcileDesktopSessions(fixture.state, {
        providers: ["codex"],
        codexRoot: fixture.codexRoot,
      });
      expect(depth.errors[0]).toMatchObject({
        code: "provider_drift",
        message: expect.stringContaining("depth 16"),
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }

    for (const triggerTurn of [false, "true"] as const) {
      const triggerFixture = await captureFixture();
      try {
        await writeFile(
          path.join(
            triggerFixture.codexRoot,
            "2026",
            "07",
            "23",
            `rollout-2026-07-23T10-00-00-${CODEX_SESSION}.jsonl`,
          ),
          jsonl([
            codexSessionMeta(
              CODEX_SESSION,
              CODEX_PARENT_SESSION,
              "2026-07-23T10:00:00.000Z",
            ),
            {
              timestamp: "2026-07-23T10:00:01.000Z",
              type: "inter_agent_communication_metadata",
              payload: { trigger_turn: triggerTurn },
            },
            codexResponseMessage(
              "assistant",
              "owner-assistant",
              "must remain hidden",
              "2026-07-23T10:00:02.000Z",
            ),
          ]),
        );
        const report = await reconcileDesktopSessions(triggerFixture.state, {
          providers: ["codex"],
          codexRoot: triggerFixture.codexRoot,
        });
        if (triggerTurn === false) {
          expect(report).toMatchObject({ failedFiles: 0, importedSessions: 0, skippedFiles: 1 });
        } else {
          expect(report.errors[0]).toMatchObject({ code: "provider_drift" });
        }
        expect(
          await loadSessionStateReadOnly(
            triggerFixture.state,
            `desktop-codex-${CODEX_SESSION}`,
          ),
        ).toBeNull();
      } finally {
        await rm(triggerFixture.root, { recursive: true, force: true });
      }
    }
  });

  test("edge input: defers a partial final JSONL record and resumes it after the provider completes the append", async () => {
    const fixture = await captureFixture();
    try {
      const claudePath = path.join(fixture.claudeRoot, "C--", `${CLAUDE_SESSION}.jsonl`);
      const firstLine = JSON.stringify(
        claudeRecord("user", "claude-user-1", "2026-07-23T09:00:00.000Z", "hello"),
      );
      const completedAssistant = JSON.stringify(
        claudeRecord("assistant", "claude-assistant-1", "2026-07-23T09:00:01.000Z", "answer"),
      );
      const split = Math.floor(completedAssistant.length / 2);
      await writeFile(claudePath, `${firstLine}\n${completedAssistant.slice(0, split)}`);

      const partial = await reconcileDesktopSessions(fixture.state, {
        providers: ["claude"],
        claudeRoot: fixture.claudeRoot,
      });
      expect(partial).toMatchObject({
        importedSessions: 1,
        importedMessages: 1,
        deferredFiles: 1,
        failedFiles: 0,
      });

      await appendFile(claudePath, `${completedAssistant.slice(split)}\n`);
      const completed = await reconcileDesktopSessions(fixture.state, {
        providers: ["claude"],
        claudeRoot: fixture.claudeRoot,
      });
      expect(completed).toMatchObject({
        existingSessions: 1,
        importedMessages: 1,
        existingMessages: 0,
        failedFiles: 0,
      });
      expect(
        (await loadTranscript(fixture.state, `desktop-claude-${CLAUDE_SESSION}`))?.messages.map(
          (message) => message.content,
        ),
      ).toEqual(["hello", "answer"]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("denied failure: rejects malformed and rewritten evidence without advancing or changing canonical content", async () => {
    const fixture = await captureFixture();
    try {
      const claudePath = path.join(fixture.claudeRoot, "C--", `${CLAUDE_SESSION}.jsonl`);
      const admitted = jsonl([
        claudeRecord("user", "claude-user-1", "2026-07-23T09:00:00.000Z", "alpha"),
      ]);
      await writeFile(claudePath, `${admitted}not-json\n`);
      const malformed = await reconcileDesktopSessions(fixture.state, {
        providers: ["claude"],
        claudeRoot: fixture.claudeRoot,
      });
      expect(malformed.failedFiles).toBe(1);
      expect(malformed.errors[0]).toMatchObject({ code: "malformed_jsonl", retryable: false });
      expect(await loadSessionStateReadOnly(fixture.state, `desktop-claude-${CLAUDE_SESSION}`)).toBeNull();

      await writeFile(claudePath, admitted);
      const recovered = await reconcileDesktopSessions(fixture.state, {
        providers: ["claude"],
        claudeRoot: fixture.claudeRoot,
      });
      expect(recovered).toMatchObject({ importedSessions: 1, importedMessages: 1, failedFiles: 0 });

      await writeFile(
        claudePath,
        jsonl([claudeRecord("user", "claude-user-1", "2026-07-23T09:00:00.000Z", "omega")]),
      );
      const rewritten = await reconcileDesktopSessions(fixture.state, {
        providers: ["claude"],
        claudeRoot: fixture.claudeRoot,
      });
      expect(rewritten.failedFiles).toBe(1);
      expect(rewritten.errors[0]).toMatchObject({ code: "source_rewritten", retryable: false });
      expect(
        (await loadTranscript(fixture.state, `desktop-claude-${CLAUDE_SESSION}`))?.messages[0]?.content,
      ).toBe("alpha");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("edge input: rejects an evidence root reached through a symlink or junction ancestor", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-ancestor-link-"));
    try {
      const state = sharedState(path.join(root, "state"));
      await ensureSharedState(state);
      const physicalParent = path.join(root, "physical-provider");
      const physicalRoot = path.join(physicalParent, "projects");
      await mkdir(physicalRoot, { recursive: true });
      const linkedParent = path.join(root, "linked-provider");
      await symlink(
        physicalParent,
        linkedParent,
        process.platform === "win32" ? "junction" : "dir",
      );

      const report = await reconcileDesktopSessions(state, {
        providers: ["claude"],
        claudeRoot: path.join(linkedParent, "projects"),
      });
      expect(report.failedFiles).toBe(1);
      expect(report.errors[0]).toMatchObject({
        code: "unsafe_source_root",
        retryable: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied failure: rejects a transcript file that is a symlink", async () => {
    const fixture = await captureFixture();
    try {
      const physical = path.join(fixture.root, "physical-transcript.jsonl");
      await writeFile(
        physical,
        jsonl([claudeRecord("user", "linked-user", "2026-07-23T09:00:00.000Z", "linked")]),
      );
      const linked = path.join(fixture.claudeRoot, "C--", `${CLAUDE_SESSION}.jsonl`);
      await symlink(physical, linked, "file");

      const report = await reconcileDesktopSessions(fixture.state, {
        providers: ["claude"],
        claudeRoot: fixture.claudeRoot,
      });
      expect(report.failedFiles).toBe(1);
      expect(report.errors[0]).toMatchObject({
        code: "unsafe_source_path",
        retryable: false,
      });
      expect(await loadSessionStateReadOnly(fixture.state, `desktop-claude-${CLAUDE_SESSION}`)).toBeNull();
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("edge input: a hidden-only Claude page advances safely before a visible page", async () => {
    const fixture = await captureFixture();
    try {
      const claudePath = path.join(fixture.claudeRoot, "C--", `${CLAUDE_SESSION}.jsonl`);
      await writeFile(
        claudePath,
        jsonl([
          {
            ...claudeRecord(
              "user",
              "hidden-page-record",
              "2000-01-01T00:00:00.000Z",
              "hidden page content",
            ),
            isMeta: true,
            capturePadding: "h".repeat(6_000),
          },
          {
            ...claudeRecord(
              "assistant",
              "visible-page-record",
              "2026-07-23T10:00:00.000Z",
              "visible page answer",
            ),
            capturePadding: "v".repeat(3_000),
          },
        ]),
      );
      const options: ReconcileDesktopSessionsOptions = {
        providers: ["claude"],
        claudeRoot: fixture.claudeRoot,
        limits: {
          maximumLineBytes: 7_000,
          maximumFileBytes: 7_100,
          maximumTotalBytes: 30_000,
        },
      };

      const hiddenPage = await reconcileDesktopSessions(fixture.state, options);
      expect(hiddenPage).toMatchObject({
        reconciledFiles: 1,
        importedSessions: 0,
        importedMessages: 0,
        skippedFiles: 1,
        deferredFiles: 1,
        failedFiles: 0,
      });
      expect(
        await loadSessionStateReadOnly(
          fixture.state,
          `desktop-claude-${CLAUDE_SESSION}`,
        ),
      ).toBeNull();

      const visiblePage = await reconcileDesktopSessions(fixture.state, options);
      expect(visiblePage).toMatchObject({
        importedSessions: 1,
        importedMessages: 1,
        failedFiles: 0,
      });
      const sessionId = `desktop-claude-${CLAUDE_SESSION}`;
      const transcript = await loadTranscript(fixture.state, sessionId);
      expect(transcript?.messages.map((message) => message.content)).toEqual([
        "visible page answer",
      ]);
      expect(JSON.stringify(transcript)).not.toContain("hidden page content");
      expect((await loadSessionEvents(fixture.state, sessionId))[0]?.at).toBe(
        "2026-07-23T10:00:00.000Z",
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test("denied failure: rejects a tampered open Codex lineage checkpoint", async () => {
    const fixture = await captureFixture();
    try {
      const codexPath = path.join(
        fixture.codexRoot,
        "2026",
        "07",
        "23",
        `rollout-2026-07-23T10-00-00-${CODEX_SESSION}.jsonl`,
      );
      const owner = JSON.stringify(
        codexSessionMeta(
          CODEX_SESSION,
          CODEX_PARENT_SESSION,
          "2026-07-23T10:00:00.000Z",
        ),
      );
      const partialTrigger = JSON.stringify({
        timestamp: "2026-07-23T10:00:01.000Z",
        type: "inter_agent_communication_metadata",
        payload: { trigger_turn: true },
      }).slice(0, 20);
      await writeFile(codexPath, `${owner}\n${partialTrigger}`);
      const first = await reconcileDesktopSessions(fixture.state, {
        providers: ["codex"],
        codexRoot: fixture.codexRoot,
      });
      expect(first).toMatchObject({ deferredFiles: 1, failedFiles: 0 });

      const cursorPath = path.join(
        fixture.state.stateDir,
        "runtime",
        "session-capture",
        "cursor.json",
      );
      const cursor = JSON.parse(await readFile(cursorPath, "utf8")) as {
        files: Record<
          string,
          { sessionSeed: { codexProgress: { expectedParentSessionId: string } } }
        >;
      };
      cursor.files[
        `codex:2026/07/23/rollout-2026-07-23T10-00-00-${CODEX_SESSION}.jsonl`
      ].sessionSeed.codexProgress.expectedParentSessionId = CODEX_ROOT_SESSION;
      await writeFile(cursorPath, `${JSON.stringify(cursor, null, 2)}\n`);

      const tampered = await reconcileDesktopSessions(fixture.state, {
        providers: ["codex"],
        codexRoot: fixture.codexRoot,
      });
      expect(tampered).toMatchObject({ failedFiles: 1 });
      expect(tampered.errors[0]).toMatchObject({
        code: "cursor_invalid",
        retryable: false,
      });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

test("paged capture makes progress beyond 64 MiB and still admits a later file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-large-paged-"));
  try {
    const state = sharedState(path.join(root, "state"));
    const evidenceRoot = path.join(root, "provider", "C--");
    await ensureSharedState(state);
    await mkdir(evidenceRoot, { recursive: true });
    const largeSession = "00000000-0000-4000-8000-000000000001";
    const laterSession = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const padding = "p".repeat(3_900_000);
    const largePath = path.join(evidenceRoot, `${largeSession}.jsonl`);
    await writeFile(
      largePath,
      jsonl(
        Array.from({ length: 18 }, (_, index) =>
          claudeRecordForSession(
            largeSession,
            `large-record-${index + 1}`,
            `2026-07-23T09:00:${String(index).padStart(2, "0")}.000Z`,
            `large ${index + 1}`,
            padding,
          ),
        ),
      ),
    );
    await writeFile(
      path.join(evidenceRoot, `${laterSession}.jsonl`),
      jsonl([
        claudeRecordForSession(
          laterSession,
          "later-record-1",
          "2026-07-23T10:00:00.000Z",
          "later file",
        ),
      ]),
    );
    expect((await stat(largePath)).size).toBeGreaterThan(64 * 1024 * 1024);

    const first = await reconcileDesktopSessions(state, {
      providers: ["claude"],
      claudeRoot: path.dirname(evidenceRoot),
    });
    expect(first.failedFiles).toBe(0);
    expect(first.deferredFiles).toBeGreaterThanOrEqual(1);
    expect(
      (await loadTranscript(state, `desktop-claude-${largeSession}`))?.messages.length,
    ).toBeGreaterThan(0);
    expect(
      (await loadTranscript(state, `desktop-claude-${laterSession}`))?.messages.map(
        (message) => message.content,
      ),
    ).toEqual(["later file"]);

    const second = await reconcileDesktopSessions(state, {
      providers: ["claude"],
      claudeRoot: path.dirname(evidenceRoot),
    });
    expect(second.failedFiles).toBe(0);
    expect(
      (await loadTranscript(state, `desktop-claude-${largeSession}`))?.messages.length,
    ).toBe(18);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("paged capture rotates after a run budget and eventually reaches the later source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-page-rotation-"));
  try {
    const state = sharedState(path.join(root, "state"));
    const evidenceRoot = path.join(root, "provider", "C--");
    await ensureSharedState(state);
    await mkdir(evidenceRoot, { recursive: true });
    const sessions = [
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
      "10000000-0000-4000-8000-000000000003",
      "10000000-0000-4000-8000-000000000004",
    ];
    for (const [sessionIndex, sessionId] of sessions.entries()) {
      await writeFile(
        path.join(evidenceRoot, `${sessionId}.jsonl`),
        jsonl(
          Array.from({ length: 2 }, (_, messageIndex) =>
            claudeRecordForSession(
              sessionId,
              `rotation-${sessionIndex + 1}-${messageIndex + 1}`,
              `2026-07-23T09:0${sessionIndex}:0${messageIndex}.000Z`,
              `rotation ${sessionIndex + 1}.${messageIndex + 1}`,
              "r".repeat(5_000),
            ),
          ),
        ),
      );
    }
    const options: ReconcileDesktopSessionsOptions = {
      providers: ["claude"],
      claudeRoot: path.dirname(evidenceRoot),
      limits: {
        maximumLineBytes: 6_000,
        maximumFileBytes: 7_000,
        maximumTotalBytes: 20_500,
      },
    };

    const first = await reconcileDesktopSessions(state, options);
    expect(first.failedFiles).toBe(0);
    expect(first.errors).toEqual([
      expect.objectContaining({ code: "scan_limit", retryable: true }),
    ]);
    expect(
      await loadSessionStateReadOnly(state, `desktop-claude-${sessions[3]}`),
    ).toBeNull();

    const second = await reconcileDesktopSessions(state, options);
    expect(
      (await loadTranscript(state, `desktop-claude-${sessions[3]}`))?.messages[0]?.content,
    ).toBe("rotation 4.1");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a shrunk source fails without blocking the next rotated source", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-shrink-rotation-"));
  try {
    const state = sharedState(path.join(root, "state"));
    const evidenceRoot = path.join(root, "provider", "C--");
    await ensureSharedState(state);
    await mkdir(evidenceRoot, { recursive: true });
    const firstSession = "20000000-0000-4000-8000-000000000001";
    const laterSession = "20000000-0000-4000-8000-000000000002";
    const firstPath = path.join(evidenceRoot, `${firstSession}.jsonl`);
    await writeFile(
      firstPath,
      jsonl([
        claudeRecordForSession(
          firstSession,
          "shrink-first",
          "2026-07-23T09:00:00.000Z",
          "before shrink",
        ),
      ]),
    );
    await reconcileDesktopSessions(state, {
      providers: ["claude"],
      claudeRoot: path.dirname(evidenceRoot),
    });

    await writeFile(firstPath, "");
    await writeFile(
      path.join(evidenceRoot, `${laterSession}.jsonl`),
      jsonl([
        claudeRecordForSession(
          laterSession,
          "shrink-later",
          "2026-07-23T09:01:00.000Z",
          "after shrink",
        ),
      ]),
    );
    const report = await reconcileDesktopSessions(state, {
      providers: ["claude"],
      claudeRoot: path.dirname(evidenceRoot),
    });
    expect(report.errors).toContainEqual(
      expect.objectContaining({ code: "source_rewritten", retryable: false }),
    );
    expect(
      (await loadTranscript(state, `desktop-claude-${laterSession}`))?.messages[0]?.content,
    ).toBe("after shrink");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the deterministic old-page audit eventually detects an early-page mutation outside the guards", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-old-page-audit-"));
  try {
    const state = sharedState(path.join(root, "state"));
    const evidenceRoot = path.join(root, "provider", "C--");
    await ensureSharedState(state);
    await mkdir(evidenceRoot, { recursive: true });
    const sessionId = "30000000-0000-4000-8000-000000000001";
    const transcriptPath = path.join(evidenceRoot, `${sessionId}.jsonl`);
    await writeFile(
      transcriptPath,
      jsonl(
        Array.from({ length: 4 }, (_, index) =>
          claudeRecordForSession(
            sessionId,
            `audit-${index + 1}`,
            `2026-07-23T09:00:0${index}.000Z`,
            `audit ${index + 1}`,
            "a".repeat(5_000),
          ),
        ),
      ),
    );
    const options: ReconcileDesktopSessionsOptions = {
      providers: ["claude"],
      claudeRoot: path.dirname(evidenceRoot),
      limits: {
        maximumLineBytes: 6_000,
        maximumFileBytes: 7_000,
        maximumTotalBytes: 30_000,
      },
    };
    for (let run = 0; run < 4; run += 1) {
      const report = await reconcileDesktopSessions(state, options);
      expect(report.failedFiles).toBe(0);
    }
    const cursorPath = path.join(state.stateDir, "runtime", "session-capture", "cursor.json");
    const cursorBefore = JSON.parse(await readFile(cursorPath, "utf8")) as {
      files: Record<
        string,
        {
          admittedBytes: number;
          pages: Array<{ offset: number; length: number }>;
          nextAuditPageIndex: number;
        }
      >;
    };
    const checkpoint = cursorBefore.files[`claude:C--/${sessionId}.jsonl`];
    expect(checkpoint.pages).toHaveLength(4);
    expect(checkpoint.nextAuditPageIndex).toBe(2);
    expect(checkpoint.pages[0].length).toBeGreaterThan(4_500);
    const handle = await open(transcriptPath, "r+");
    try {
      const probe = Buffer.alloc(1);
      await handle.read(probe, 0, 1, checkpoint.pages[0].offset + 4_500);
      expect(probe.toString()).toBe("a");
      await handle.write(Buffer.from("b"), 0, 1, checkpoint.pages[0].offset + 4_500);
    } finally {
      await handle.close();
    }

    const firstAudit = await reconcileDesktopSessions(state, options);
    const secondAudit = await reconcileDesktopSessions(state, options);
    expect(firstAudit.failedFiles).toBe(0);
    expect(secondAudit.failedFiles).toBe(0);
    const detected = await reconcileDesktopSessions(state, options);
    expect(detected.errors).toContainEqual(
      expect.objectContaining({
        code: "source_rewritten",
        message: expect.stringContaining("checkpoint page 1"),
      }),
    );
    const cursorAfter = JSON.parse(await readFile(cursorPath, "utf8")) as {
      files: Record<string, { admittedBytes: number }>;
    };
    expect(cursorAfter.files[`claude:C--/${sessionId}.jsonl`].admittedBytes).toBe(
      checkpoint.admittedBytes,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("andromeda sessions ingest exposes the reconciler through the renamed CLI", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-capture-cli-"));
  try {
    const workspace = path.join(root, "workspace");
    const stateHome = path.join(root, "state");
    const userHome = path.join(root, "user");
    const projectRoot = path.join(userHome, ".claude", "projects", "C--");
    await mkdir(workspace, { recursive: true });
    await mkdir(projectRoot, { recursive: true });
    await writeFile(
      path.join(projectRoot, `${CLAUDE_SESSION}.jsonl`),
      jsonl([claudeRecord("user", "claude-user-cli", "2026-07-23T09:00:00.000Z", "from cli")]),
    );

    const processResult = Bun.spawn(
      [process.execPath, CLI_PATH, "sessions", "ingest", "--provider", "claude", "--json"],
      {
        cwd: workspace,
        env: {
          ...cleanEnvironment(),
          ANDROMEDA_HOME: stateHome,
          ANDROMEDA_ROOT: workspace,
          ANDROMEDA_USER_HOME: userHome,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(processResult.stdout).text(),
      new Response(processResult.stderr).text(),
      processResult.exited,
    ]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toMatchObject({
      importedSessions: 1,
      importedMessages: 1,
      failedFiles: 0,
    });
    const state = sharedStateAt(workspace, stateHome, userHome);
    expect(
      (await loadTranscript(state, `desktop-claude-${CLAUDE_SESSION}`))?.messages.map(
        (message) => message.content,
      ),
    ).toEqual(["from cli"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("bulk import reads once, replays at most twice, and writes one projection for the whole backfill", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-bulk-"));
  try {
    const state = sharedState(root);
    await ensureSharedState(state);
    const sessionId = `desktop-claude-${CLAUDE_SESSION}`;
    await createSession(state, {
      provider: "claude",
      model: "claude-opus-4-8",
      sessionId,
      metadata: {
        source: "provider-transcript",
        sourceProvider: "claude",
        nativeSessionId: CLAUDE_SESSION,
        sourceFormat: "claude-project-jsonl-v1",
        sourcePath: `.claude/projects/C--/${CLAUDE_SESSION}.jsonl`,
        exchange: "local-only",
        exchangeReason: "provider-transcript",
      },
      createdAt: "2026-07-23T09:00:00.000Z",
    });
    const messages: ImportedSessionMessage[] = Array.from({ length: 12 }, (_, index) => ({
      provider: "claude",
      nativeSessionId: CLAUDE_SESSION,
      sourceFormat: "claude-project-jsonl-v1",
      sourcePath: `.claude/projects/C--/${CLAUDE_SESSION}.jsonl`,
      sourceRecordId: `message-${index}`,
      sourceTimestamp: new Date(Date.parse("2026-07-23T09:00:00.000Z") + index * 1_000).toISOString(),
      message: { role: index % 2 === 0 ? "user" : "assistant", content: `message ${index}` },
    }));
    const first = await appendImportedSessionMessages(state, sessionId, messages);
    expect(first).toMatchObject({
      appended: 12,
      existing: 0,
      eventReads: 1,
      eventReplays: 2,
      projectionWrites: 1,
    });
    const second = await appendImportedSessionMessages(state, sessionId, messages);
    expect(second).toMatchObject({
      appended: 0,
      existing: 12,
      eventReads: 1,
      eventReplays: 1,
      projectionWrites: 0,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session summaries replay each bounded event stream once without projections, writes, or locks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-list-readonly-"));
  try {
    const state = sharedState(root);
    await ensureSharedState(state);
    const sessionIds = ["read-only-list-1", "read-only-list-2"];
    for (const [index, sessionId] of sessionIds.entries()) {
      const descriptor = await createSession(state, {
        provider: index === 0 ? "codex" : "claude",
        model: index === 0 ? "gpt-5.4" : "claude-opus-4-8",
        sessionId,
      });
      const turnId = await beginSessionTurn(state, descriptor.sessionId);
      await appendSessionMessage(state, descriptor.sessionId, turnId, {
        role: "user",
        content: `summary ${index + 1}`,
      });
      await completeSessionTurn(state, descriptor.sessionId, turnId);
      const paths = sessionPaths(state, sessionId);
      await writeFile(paths.stateFile, `{"tampered":"state-${index + 1}"}\n`);
      await writeFile(paths.transcriptFile, `{"tampered":"transcript-${index + 1}"}\n`);
    }
    const before = await Promise.all(
      sessionIds.flatMap((sessionId) => {
        const paths = sessionPaths(state, sessionId);
        return [
          stat(paths.stateFile, { bigint: true }),
          stat(paths.transcriptFile, { bigint: true }),
        ];
      }),
    );
    await rm(path.dirname(renewableLockDatabasePath(state)), { recursive: true, force: true });

    const summaries = await listSessionSummaries(state, {
      maximumSessions: 2,
      maximumScannedEntries: 2,
      maximumEvents: 8,
      maximumEventScannedEntries: 10,
    });
    expect(summaries).toEqual([
      expect.objectContaining({
        sessionId: sessionIds[0],
        provider: "codex",
        model: "gpt-5.4",
        updatedAt: expect.any(String),
      }),
      expect.objectContaining({
        sessionId: sessionIds[1],
        provider: "claude",
        model: "claude-opus-4-8",
        updatedAt: expect.any(String),
      }),
    ]);
    await expect(lstat(renewableLockDatabasePath(state))).rejects.toMatchObject({ code: "ENOENT" });
    const after = await Promise.all(
      sessionIds.flatMap((sessionId) => {
        const paths = sessionPaths(state, sessionId);
        return [
          stat(paths.stateFile, { bigint: true }),
          stat(paths.transcriptFile, { bigint: true }),
        ];
      }),
    );
    expect(after.map((entry) => entry.mtimeNs)).toEqual(before.map((entry) => entry.mtimeNs));
    await expect(
      listSessionSummaries(state, { maximumEvents: 7, maximumEventScannedEntries: 10 }),
    ).rejects.toThrow(/maximumEvents 7/);
    await expect(
      listSessionSummaries(state, { maximumEvents: 8, maximumEventScannedEntries: 9 }),
    ).rejects.toThrow(/maximumEventScannedEntries 9/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event exchange skips each local-only imported session atomically and reports the reason", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-local-only-"));
  try {
    const source = sharedState(path.join(root, "source"));
    const target = sharedState(path.join(root, "target"));
    await ensureSharedState(source);
    await ensureSharedState(target);
    await enableEventSync(source, true);
    const syncKey = await readSecret(source, "ANDROMEDA_SYNC_KEY");
    await writeSecret(target, "ANDROMEDA_SYNC_KEY", syncKey);
    await enableEventSync(target);

    const importedId = `desktop-claude-${CLAUDE_SESSION}`;
    await createSession(source, {
      provider: "claude",
      model: "claude-opus-4-8",
      sessionId: importedId,
      metadata: {
        source: "provider-transcript",
        sourceProvider: "claude",
        nativeSessionId: CLAUDE_SESSION,
        sourceFormat: "claude-project-jsonl-v1",
        sourcePath: `.claude/projects/C--/${CLAUDE_SESSION}.jsonl`,
        exchange: "local-only",
        exchangeReason: "provider-transcript",
      },
      createdAt: "2026-07-23T09:00:00.000Z",
    });
    await appendImportedSessionMessages(source, importedId, [
      {
        provider: "claude",
        nativeSessionId: CLAUDE_SESSION,
        sourceFormat: "claude-project-jsonl-v1",
        sourcePath: `.claude/projects/C--/${CLAUDE_SESSION}.jsonl`,
        sourceRecordId: "secret-shaped-example",
        sourceTimestamp: "2026-07-23T09:00:01.000Z",
        message: {
          role: "user",
          content: "api_key=example-value-that-must-stay-local",
          metadata: {
            source: "provider-transcript",
            sourceProvider: "claude",
            nativeSessionId: CLAUDE_SESSION,
            sourcePath: `.claude/projects/C--/${CLAUDE_SESSION}.jsonl`,
            sourceRecordId: "secret-shaped-example",
            sourceTimestamp: "2026-07-23T09:00:01.000Z",
          },
        },
      },
    ]);
    await createSession(source, {
      provider: "codex",
      model: "gpt-5.4",
      sessionId: "roaming-session",
      workdir: "/workspace",
    });

    const bundle = path.join(root, "events.bundle.json");
    const exported = await exportEventBundle(source, bundle);
    expect(exported).toMatchObject({
      skippedSessions: 1,
      skippedSessionReasons: { "provider-transcript": 1 },
    });
    await importEventBundle(target, bundle);
    expect(await loadSessionStateReadOnly(target, importedId)).toBeNull();
    expect(await loadSessionStateReadOnly(target, "roaming-session")).not.toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event exchange does not trust forged provider-transcript metadata without a completed imported turn", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-forged-local-only-"));
  try {
    const state = sharedState(root);
    await ensureSharedState(state);
    await enableEventSync(state, true);
    const forgedId = `desktop-claude-${CLAUDE_SESSION}`;
    await createSession(state, {
      provider: "claude",
      model: "claude-opus-4-8",
      sessionId: forgedId,
      metadata: {
        source: "provider-transcript",
        sourceProvider: "claude",
        nativeSessionId: CLAUDE_SESSION,
        sourceFormat: "claude-project-jsonl-v1",
        sourcePath: `.claude/projects/C--/${CLAUDE_SESSION}.jsonl`,
        exchange: "local-only",
        exchangeReason: "provider-transcript",
      },
      createdAt: "2026-07-23T09:00:00.000Z",
    });

    await expect(exportEventBundle(state, path.join(root, "forged.bundle.json"))).rejects.toThrow(
      "secret-like field",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event exchange scans generic local-only sessions and rejects secret-shaped history", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-generic-local-only-"));
  try {
    const state = sharedState(root);
    await ensureSharedState(state);
    await enableEventSync(state, true);
    await createSession(state, {
      provider: "claude",
      model: "claude-opus-4-8",
      sessionId: "generic-local-only",
      metadata: {
        exchange: "local-only",
        exchangeReason: "provider-transcript",
      },
      createdAt: "2026-07-23T09:00:00.000Z",
    });
    const turnId = await beginSessionTurn(state, "generic-local-only");
    await appendSessionMessage(state, "generic-local-only", turnId, {
      role: "user",
      content: "api_key=example-value-that-must-not-roam",
    });
    await completeSessionTurn(state, "generic-local-only", turnId);

    await expect(exportEventBundle(state, path.join(root, "generic.bundle.json"))).rejects.toThrow(
      "secret-like",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("event exchange rejects traversal-shaped provider source provenance", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-traversal-provenance-"));
  try {
    const state = sharedState(root);
    await ensureSharedState(state);
    await enableEventSync(state, true);
    const forgedId = `desktop-claude-${CLAUDE_SESSION}`;
    const sourcePath = `.claude/projects/../C--/${CLAUDE_SESSION}.jsonl`;
    await createSession(state, {
      provider: "claude",
      model: "claude-opus-4-8",
      sessionId: forgedId,
      metadata: {
        source: "provider-transcript",
        sourceProvider: "claude",
        nativeSessionId: CLAUDE_SESSION,
        sourceFormat: "claude-project-jsonl-v1",
        sourcePath,
        exchange: "local-only",
        exchangeReason: "provider-transcript",
      },
      createdAt: "2026-07-23T09:00:00.000Z",
    });
    await appendImportedSessionMessages(state, forgedId, [
      {
        provider: "claude",
        nativeSessionId: CLAUDE_SESSION,
        sourceFormat: "claude-project-jsonl-v1",
        sourcePath,
        sourceRecordId: "traversal-source-record",
        sourceTimestamp: "2026-07-23T09:00:01.000Z",
        message: {
          role: "user",
          content: "api_key=example-value-that-must-not-roam",
          metadata: {
            source: "provider-transcript",
            sourceProvider: "claude",
            nativeSessionId: CLAUDE_SESSION,
            sourcePath,
            sourceRecordId: "traversal-source-record",
            sourceTimestamp: "2026-07-23T09:00:01.000Z",
          },
        },
      },
    ]);

    await expect(exportEventBundle(state, path.join(root, "traversal.bundle.json"))).rejects.toThrow(
      "secret-like",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows capture lifecycle installs a hidden WScript task and uninstalls only its exact task", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-session-capture-task-"));
  try {
    const state = sharedState(root);
    await ensureSharedState(state);
    await mkdir(path.join(state.stateDir, "bin"), { recursive: true });
    await writeFile(path.join(state.stateDir, "bin", "andromeda.ps1"), "exit 0\n");
    let installed: SessionCaptureTaskInfo | null = null;
    const scheduler: SessionCaptureScheduler = {
      query: async () => installed,
      install: async (spec) => {
        installed = {
          name: spec.name,
          path: spec.path,
          enabled: true,
          actionCount: 1,
          executable: spec.executable,
          arguments: spec.arguments,
          triggerCount: 1,
          interval: spec.interval,
          hidden: true,
          multipleInstances: "IgnoreNew",
          principalUser: spec.principalUser,
          logonType: "Interactive",
          runLevel: "Limited",
          executionLimit: spec.executionLimit,
        };
      },
      uninstall: async () => {
        installed = null;
      },
    };
    const options = {
      platform: "win32" as const,
      systemRoot: "C:\\Windows",
      principal: () => "ACME\\patrik",
      scheduler,
    };
    const status = await installSessionCapture(state, options);
    expect(status).toMatchObject({
      installed: true,
      enabled: true,
      healthy: true,
      interval: SESSION_CAPTURE_INTERVAL,
      executionLimit: SESSION_CAPTURE_EXECUTION_LIMIT,
    });
    const spec = buildSessionCaptureTaskSpec(state, "ACME\\patrik", "C:\\Windows");
    expect(spec.executable.toLowerCase()).toBe("c:\\windows\\system32\\wscript.exe");
    expect(spec.arguments).toBe(`//B //Nologo "${sessionCaptureWrapperPath(state)}"`);
    const wrapper = await readFile(sessionCaptureWrapperPath(state), "utf8");
    expect(wrapper).toBe(sessionCaptureWrapper(state, "C:\\Windows"));
    expect(wrapper).toContain("shell.Run(command, 0, True)");
    expect(wrapper).toContain("-WindowStyle Hidden");
    expect(wrapper).not.toContain("cmd.exe");
    expect(await sessionCaptureStatus(state, options)).toMatchObject({ healthy: true });

    const queriedTask = await scheduler.query();
    if (!queriedTask) throw new Error("test scheduler did not retain the installed task");
    const healthyTask = structuredClone(queriedTask);
    for (const [drift, issue] of [
      [{ principalUser: "ACME\\other" }, "scheduled capture principal drifted"],
      [{ logonType: "Password" }, "scheduled capture task logon type drifted"],
      [{ runLevel: "Highest" }, "scheduled capture task run level drifted"],
      [{ executionLimit: "PT30M" }, "scheduled capture execution limit drifted"],
    ] as const) {
      installed = { ...healthyTask, ...drift };
      expect(await sessionCaptureStatus(state, options)).toMatchObject({
        healthy: false,
        issues: expect.arrayContaining([issue]),
      });
    }
    installed = healthyTask;
    expect(await uninstallSessionCapture(state, options)).toMatchObject({ installed: false, healthy: true });
    await expect(lstat(sessionCaptureWrapperPath(state))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows scheduler backend emits a bounded hidden five-minute task definition", async () => {
  const scripts: string[] = [];
  const scheduler = createWindowsSessionCaptureScheduler(async (script) => {
    scripts.push(script);
    return {
      code: 0,
      stdout: script.includes("ConvertTo-Json") ? "__MISSING__\n" : "",
      stderr: "",
    };
  });
  const spec = {
    name: "Andromeda-Session-Capture",
    path: "\\",
    executable: "C:\\Windows\\System32\\wscript.exe",
    arguments: '//B //Nologo "C:\\Andromeda\\bin\\session-capture.vbs"',
    principalUser: "ACME\\patrik",
    interval: "PT5M",
    executionLimit: "PT4M",
  };
  expect(await scheduler.query()).toBeNull();
  await scheduler.install(spec);
  await scheduler.uninstall(spec);

  expect(scripts).toHaveLength(3);
  expect(scripts[0]).toContain("principalUser = [string]$task.Principal.UserId");
  expect(scripts[0]).toContain("executionLimit = [string]$task.Settings.ExecutionTimeLimit");
  expect(scripts[1]).toContain("New-ScheduledTaskAction");
  expect(scripts[1]).toContain("New-TimeSpan -Minutes 5");
  expect(scripts[1]).toContain("-MultipleInstances IgnoreNew -Hidden");
  expect(scripts[1]).toContain("-ExecutionTimeLimit (New-TimeSpan -Minutes 4)");
  expect(scripts[1]).toContain("-LogonType Interactive -RunLevel Limited");
  expect(scripts[2]).toContain("Unregister-ScheduledTask");
});
