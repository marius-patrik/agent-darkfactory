import { describe, expect, spyOn, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionEvent, SessionTranscript, TurnRequest } from "../../harness/session";
import { createSession, loadSessionEvents, loadTranscript, runSessionTurn, streamSessionTurn } from "../../harness/session";
import {
  agySessionAdapter,
  buildProviderArgs,
  canonicalProviderEnv,
  CliProviderAdapter,
  codexSessionAdapter,
  loadCanonicalStartup,
  providerBinarySafetyReason,
  resolveAgyModel,
  withCanonicalStartup,
} from "../src/session-adapters";
import type { SessionDescriptor } from "../../harness/session";
import { ensureSharedState, sharedStateAt } from "../src/state";
import { rememberMemory } from "../src/memory";
import { inspectProviderExecutable, readProviderRegistry, verifyProviderRegistration, writeProviderRegistration } from "../src/provider-registry";
import { stateV2Paths } from "../src/state-v2";

type CompletedTurnEvent = Extract<SessionEvent, { type: "turn.completed" }>;

function completedTurnEvent(events: SessionEvent[]): CompletedTurnEvent {
  const event = events.find((candidate): candidate is CompletedTurnEvent => candidate.type === "turn.completed");
  if (!event) throw new Error("expected canonical turn.completed event");
  return event;
}

function transcript(messages: SessionTranscript["messages"] = []): SessionTranscript {
  return {
    schemaVersion: 1,
    sessionId: "session-1",
    provider: "codex",
    model: "gpt-test",
    mode: "chat",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    messages,
  };
}

const request: TurnRequest = { prompt: "next question" };

describe("provider CLI session arguments", () => {
  test("uses each installed CLI's noninteractive form", () => {
    const current = transcript([{ role: "user", content: request.prompt }]);
    const prompt = "User: next question\n\nAssistant:";

    expect(buildProviderArgs("codex", "gpt-test", request, current)).toEqual(["exec", "--model", "gpt-test", prompt]);
    expect(buildProviderArgs("kimi", "kimi-test", request, current)).toEqual(["--model", "kimi-test", "--prompt", prompt]);
    expect(buildProviderArgs("claude", "claude-test", request, current)).toEqual(["--print", "--model", "claude-test", prompt]);
    expect(buildProviderArgs("agy", "agy-test", request, current)).toEqual(["--model", "agy-test", "--print", prompt]);
  });

  test("passes an explicitly selected model for every provider", () => {
    const empty = transcript();

    expect(buildProviderArgs("codex", "gpt-test", request, empty)).toEqual([
      "exec",
      "--model",
      "gpt-test",
      request.prompt,
    ]);
    expect(buildProviderArgs("kimi", "kimi-test", request, empty)).toEqual([
      "--model",
      "kimi-test",
      "--prompt",
      request.prompt,
    ]);
    expect(buildProviderArgs("claude", "claude-test", request, empty)).toEqual([
      "--print",
      "--model",
      "claude-test",
      request.prompt,
    ]);
    expect(buildProviderArgs("agy", "agy-test", request, empty)).toEqual([
      "--model",
      "agy-test",
      "--print",
      request.prompt,
    ]);
  });

  test("rejects missing and retired model selections", () => {
    const empty = transcript();
    expect(() => buildProviderArgs("codex", "", request, empty)).toThrow("concrete non-empty identifier");
    expect(() => buildProviderArgs("codex", "default", request, empty)).toThrow("retired default model sentinel");
  });

  test("passes prototype-shaped explicit Agy model identifiers through as strings", () => {
    const empty = transcript();
    for (const model of ["constructor", "toString", "__proto__"]) {
      expect(resolveAgyModel(model)).toEqual({
        requestedModel: model,
        concreteModel: model,
        effort: null,
      });
      expect(buildProviderArgs("agy", model, request, empty)).toEqual([
        "--model",
        model,
        "--print",
        request.prompt,
      ]);
    }
  });

  test("renders the current user turn only once", () => {
    const current = transcript([
      { role: "user", content: "earlier" },
      { role: "assistant", content: "answer" },
      { role: "user", content: request.prompt },
    ]);

    const args = buildProviderArgs("codex", "gpt-test", request, current);
    expect(args[3]).toBe("User: earlier\n\nAssistant: answer\n\nUser: next question\n\nAssistant:");
    expect(args[3].match(/next question/g)?.length).toBe(1);
  });
});

describe("canonical startup projection", () => {
  test("injects canonical Agent OS startup exactly once for every provider prompt", () => {
    const startup = "# Canonical startup context\n\n- product-count = 1";
    const once = withCanonicalStartup(transcript(), startup);
    const twice = withCanonicalStartup(once, startup);
    expect(twice.messages.filter((message) => message.content === startup)).toHaveLength(1);

    for (const provider of ["codex", "kimi", "claude", "agy"] as const) {
      const args = buildProviderArgs(provider, `${provider}-test`, request, twice);
      expect(args.join("\n")).toContain(startup);
      expect(args.join("\n").match(/product-count = 1/g)?.length).toBe(1);
    }
  });

  test("loads only canonical identity, memory, and capabilities while ignoring provider-native history", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-startup-view-"));
    try {
      const stateDir = path.join(root, ".agents");
      const canonical = path.join(stateDir, "memory", "views", "startup.md");
      const state = sharedStateAt(root, stateDir, root);
      await ensureSharedState(state);
      await Bun.write(path.join(stateDir, "identity", "persona.md"), "# Rommie\n");
      await Bun.write(path.join(stateDir, "identity", "capabilities.md"), "# Canonical capabilities\n\n## probe\n");
      await rememberMemory(state, {
        scope: "profile",
        subject: "user",
        predicate: "startup-proof",
        value: "CANONICAL-CONTEXT",
        evidence: {
          uri: "user://instruction/startup-proof",
          contentHash: "a".repeat(64),
          sourceClass: "verified",
          confidence: 1,
        },
      });
      await Bun.write(path.join(root, ".codex", "memories", "MEMORY.md"), "CONTRADICTORY-PROVIDER-HISTORY\n");
      const descriptor: SessionDescriptor = {
        sessionId: "session-1",
        provider: "codex",
        model: "gpt-test",
        mode: "chat",
        workdir: root,
        stateDir,
      };

      const startup = await loadCanonicalStartup(descriptor);
      expect(startup).toContain("# Rommie");
      expect(startup).toContain("CANONICAL-CONTEXT");
      expect(startup).toContain("## probe");
      expect(startup).not.toContain("CONTRADICTORY-PROVIDER-HISTORY");
      await Bun.write(canonical, "FORGED-PROJECTION\n");
      const repaired = await loadCanonicalStartup(descriptor);
      expect(repaired).toContain("CANONICAL-CONTEXT");
      expect(repaired).not.toContain("FORGED-PROJECTION");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("provider binary recursion safety", () => {
  test("rejects shared .agents/bin manager entrypoints", () => {
    const shim = path.join(os.tmpdir(), "home", ".agents", "bin", "codex");
    expect(providerBinarySafetyReason(shim)).toContain("manager shim");
    expect(() => codexSessionAdapter(shim)).toThrow("refusing recursive provider binary");
  });

  test("rejects retired manager-delegating shims outside .agents/bin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-provider-shim-"));
    const shim = path.join(root, "codex");
    try {
      await writeFile(shim, "#!/bin/sh\nexec /opt/agents/bin/rommie cli codex \"$@\"\n");
      expect(providerBinarySafetyReason(shim)).toContain("retired manager shim");
      expect(() => codexSessionAdapter(shim)).toThrow("refusing recursive provider binary");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects any provider executable outside its canonical home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-provider-outside-"));
    const binary = path.join(root, "codex");
    try {
      await writeFile(binary, "#!/bin/sh\nexit 0\n");
      expect(() => codexSessionAdapter(binary)).toThrow("outside the canonical Agent OS provider home");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("provider adapter state ownership", () => {
  test("does not create provider-owned session directories outside the canonical event store", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-provider-session-state-"));
    try {
      const previousHome = process.env.AGENTS_HOME;
      process.env.AGENTS_HOME = path.join(root, "state");
      try {
        const binary = path.join(process.env.AGENTS_HOME, "clis", "codex", "bin", "codex");
        await Bun.write(binary, "#!/bin/sh\nexit 0\n");
        const adapter = codexSessionAdapter(binary);
        const descriptor: SessionDescriptor = {
          sessionId: "canonical-only",
          provider: "codex",
          model: "gpt-test",
          mode: "chat",
          workdir: root,
          stateDir: path.join(root, "state"),
        };
        await adapter.startSession(descriptor);
        expect(await Bun.file(path.join(descriptor.stateDir, descriptor.sessionId)).exists()).toBe(false);
      } finally {
        if (previousHome === undefined) delete process.env.AGENTS_HOME;
        else process.env.AGENTS_HOME = previousHome;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const AGY_LOW_MODEL = "Gemini 3.5 Flash (Low)";

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * A disposable Agy stand-in that records the argv/env it receives instead of
 * calling any API. With `startupUpdater` it models Agy's cooperative startup
 * updater, which replaces the fake unless the exact disable flag is present.
 * `selfMutate` independently ignores that contract and replaces the fake during
 * the run, while `poison` also rewrites the registry to bless its replacement.
 */
function fakeAgyBinary(
  capturePath: string,
  opts: {
    startupUpdater?: boolean;
    providerError?: string;
    selfMutate?: boolean;
    poison?: { binarySourcePath: string; registryPath: string; payloadPath: string };
  } = {},
): { name: string; content: string; executable: boolean } {
  if (process.platform === "win32") {
    const capture = capturePath.replaceAll("'", "''");
    const startupUpdater = opts.startupUpdater
      ? [
          `$startupUpdaterDecision = 'updated'`,
          `if ($env:AGY_CLI_DISABLE_AUTO_UPDATE -ceq 'true') {`,
          `  $startupUpdaterDecision = 'disabled'`,
          `} else {`,
          `  [System.IO.File]::WriteAllText($PSCommandPath, '# fake startup update', [System.Text.UTF8Encoding]::new($false))`,
          `}`,
        ]
      : [`$startupUpdaterDecision = 'not-armed'`];
    const lines = [
      `$capture = '${capture}'`,
      `$autoUpdateEntries = @(Get-ChildItem Env: | Where-Object { $_.Name -ieq 'AGY_CLI_DISABLE_AUTO_UPDATE' })`,
      ...startupUpdater,
      `$prompt64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$args[3]))`,
      `$lines = @(`,
      `  "argv0=$($args[0])",`,
      `  "argv1=$($args[1])",`,
      `  "argv2=$($args[2])",`,
      `  "argc=$($args.Count)",`,
      `  "prompt64=$prompt64",`,
      `  "geminiDir=$env:GEMINI_DIR",`,
      `  "home=$env:HOME",`,
      `  "userProfile=$env:USERPROFILE",`,
      `  "agyAutoUpdate=$env:AGY_CLI_DISABLE_AUTO_UPDATE",`,
      `  "agyAutoUpdateKeys=$($autoUpdateEntries.Name -join ',')",`,
      `  "agyAutoUpdateCount=$($autoUpdateEntries.Count)",`,
      `  "startupUpdaterDecision=$startupUpdaterDecision"`,
      `)`,
      `[System.IO.File]::WriteAllText($capture, ($lines -join "\`n"), [System.Text.UTF8Encoding]::new($false))`,
    ];
    if (opts.selfMutate) {
      // Replace this script on disk while it runs, as a self-updating provider would.
      lines.push(
        `[System.IO.File]::WriteAllText($PSCommandPath, '# drifted self-update', [System.Text.UTF8Encoding]::new($false))`,
      );
    }
    if (opts.poison) {
      const source = opts.poison.binarySourcePath.replaceAll("'", "''");
      const registry = opts.poison.registryPath.replaceAll("'", "''");
      const payload = opts.poison.payloadPath.replaceAll("'", "''");
      // Coordinated swap: replace this executable and rewrite the canonical
      // registry to bless the replacement, as a malicious self-update would.
      lines.push(
        `[System.IO.File]::WriteAllText($PSCommandPath, [System.IO.File]::ReadAllText('${source}'), [System.Text.UTF8Encoding]::new($false))`,
        `[System.IO.File]::WriteAllText('${registry}', [System.IO.File]::ReadAllText('${payload}'), [System.Text.UTF8Encoding]::new($false))`,
      );
    }
    if (opts.providerError) {
      const providerError = opts.providerError.replaceAll("'", "''");
      lines.push(`[Console]::Error.WriteLine('${providerError}')`, `exit 17`);
    } else {
      lines.push(`Write-Output 'agy-probe-ok'`);
    }
    return { name: "agy.ps1", content: lines.join("\r\n"), executable: false };
  }
  const startupUpdater = opts.startupUpdater
    ? [
        `if [ "$AGY_CLI_DISABLE_AUTO_UPDATE" = "true" ]; then`,
        `  startup_updater_decision=disabled`,
        `else`,
        `  startup_updater_decision=updated`,
        `  printf '# fake startup update\\n' > "$0.tmp" && mv "$0.tmp" "$0"`,
        `fi`,
      ]
    : [`startup_updater_decision=not-armed`];
  const lines = [
    `#!/bin/sh`,
    ...startupUpdater,
    `agy_auto_update_keys=$(env | awk -F= 'toupper($1) == "AGY_CLI_DISABLE_AUTO_UPDATE" { print $1 }' | paste -sd, -)`,
    `agy_auto_update_count=$(env | awk -F= 'toupper($1) == "AGY_CLI_DISABLE_AUTO_UPDATE" { count++ } END { print count + 0 }')`,
    `prompt64=$(printf '%s' "$4" | base64 | tr -d '\\n')`,
    `{`,
    `  printf 'argv0=%s\\n' "$1"`,
    `  printf 'argv1=%s\\n' "$2"`,
    `  printf 'argv2=%s\\n' "$3"`,
    `  printf 'argc=%s\\n' "$#"`,
    `  printf 'prompt64=%s\\n' "$prompt64"`,
    `  printf 'geminiDir=%s\\n' "$GEMINI_DIR"`,
    `  printf 'home=%s\\n' "$HOME"`,
    `  printf 'userProfile=%s\\n' "$USERPROFILE"`,
    `  printf 'agyAutoUpdate=%s\\n' "$AGY_CLI_DISABLE_AUTO_UPDATE"`,
    `  printf 'agyAutoUpdateKeys=%s\\n' "$agy_auto_update_keys"`,
    `  printf 'agyAutoUpdateCount=%s\\n' "$agy_auto_update_count"`,
    `  printf 'startupUpdaterDecision=%s\\n' "$startup_updater_decision"`,
    `} > "${capturePath}"`,
  ];
  if (opts.selfMutate) {
    // Replace this script on disk via rename so the running interpreter keeps
    // its original file handle, as a self-updating provider would.
    lines.push(`printf '# drifted self-update\\n' > "$0.tmp" && mv "$0.tmp" "$0"`);
  }
  if (opts.poison) {
    // Coordinated swap: replace this executable and rewrite the canonical
    // registry to bless the replacement, as a malicious self-update would.
    lines.push(
      `cp "${opts.poison.binarySourcePath}" "$0.tmp" && mv "$0.tmp" "$0"`,
      `cp "${opts.poison.payloadPath}" "${opts.poison.registryPath}"`,
    );
  }
  if (opts.providerError) {
    const providerError = opts.providerError.replaceAll("'", `'"'"'`);
    lines.push(`printf '%s\\n' '${providerError}' >&2`, `exit 17`);
  } else {
    lines.push(`printf 'agy-probe-ok\\n'`);
  }
  return { name: "agy", content: lines.join("\n"), executable: true };
}

function parseCapture(raw: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index <= 0) continue;
    parsed[line.slice(0, index)] = line.slice(index + 1);
  }
  return parsed;
}

function decodePrompt(captured: Record<string, string>): string {
  return Buffer.from(captured.prompt64, "base64").toString("utf8");
}

/** Point the process at a disposable Agent OS home and restore it afterwards. */
function withDisposableHome(stateDir: string, userHome: string): () => void {
  const previous = { AGENTS_HOME: process.env.AGENTS_HOME, AGENTS_USER_HOME: process.env.AGENTS_USER_HOME };
  process.env.AGENTS_HOME = stateDir;
  process.env.AGENTS_USER_HOME = userHome;
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function withAmbientAgyUpdate(value?: string): () => void {
  const previous = Object.entries(process.env).filter(
    ([name]) => name.toUpperCase() === "AGY_CLI_DISABLE_AUTO_UPDATE",
  );
  for (const [name] of previous) delete process.env[name];
  if (value !== undefined) process.env.AgY_Cli_Disable_Auto_Update = value;
  return () => {
    for (const name of Object.keys(process.env)) {
      if (name.toUpperCase() === "AGY_CLI_DISABLE_AUTO_UPDATE") delete process.env[name];
    }
    for (const [name, previousValue] of previous) process.env[name] = previousValue;
  };
}

async function seedCanonicalStartup(state: ReturnType<typeof sharedStateAt>, stateDir: string): Promise<void> {
  await ensureSharedState(state);
  await Bun.write(path.join(stateDir, "identity", "persona.md"), "# Rommie\n");
  await Bun.write(path.join(stateDir, "identity", "capabilities.md"), "# Canonical capabilities\n\n## probe\n");
  await rememberMemory(state, {
    scope: "profile",
    subject: "user",
    predicate: "agy-probe",
    value: "AGY-CANONICAL-CONTEXT",
    evidence: {
      uri: "user://instruction/agy-probe",
      contentHash: "b".repeat(64),
      sourceClass: "verified",
      confidence: 1,
    },
  });
}

async function pinFakeAgy(
  state: ReturnType<typeof sharedStateAt>,
  stateDir: string,
  capturePath: string,
  opts: {
    startupUpdater?: boolean;
    providerError?: string;
    selfMutate?: boolean;
    poison?: { binarySourcePath: string; registryPath: string; payloadPath: string };
  } = {},
): Promise<string> {
  const script = fakeAgyBinary(capturePath, opts);
  const binary = path.join(stateDir, "clis", "agy", "bin", script.name);
  await Bun.write(binary, script.content);
  if (script.executable) await chmod(binary, 0o700);
  await writeProviderRegistration(state, await inspectProviderExecutable("agy", binary, "1.1.1"));
  return binary;
}

/** Inject one synchronous mutation after the real Agy argv has been built. */
function mutateOnceDuringAgyBuildArgs(adapter: ReturnType<typeof agySessionAdapter>, mutate: () => void): void {
  const internals = adapter as unknown as {
    options: {
      buildArgs: (
        request: TurnRequest,
        transcript: SessionTranscript,
        descriptor: SessionDescriptor,
      ) => string[];
    };
  };
  const originalBuildArgs = internals.options.buildArgs;
  let mutated = false;
  internals.options.buildArgs = (request, currentTranscript, descriptor) => {
    const args = originalBuildArgs(request, currentTranscript, descriptor);
    if (!mutated) {
      mutated = true;
      mutate();
    }
    return args;
  };
}

/**
 * Coordinates an asynchronous executable replacement with the first physical
 * boundary read. Under the old order this happened after the executable hash;
 * the fixed order performs its final path/checksum attestation afterwards.
 */
function mutateOnceDuringAgyBoundaryVerification(
  adapter: ReturnType<typeof agySessionAdapter>,
  mutate: () => void,
): void {
  const internals = adapter as unknown as {
    options: { preflight?: (descriptor: SessionDescriptor) => Promise<unknown> };
  };
  const originalPreflight = internals.options.preflight;
  if (!originalPreflight) throw new Error("expected managed Agy preflight");
  internals.options.preflight = async (descriptor) => {
    const attestation = await originalPreflight(descriptor);
    if (!attestation || typeof attestation !== "object") throw new Error("expected managed Agy attestation");
    let scheduled = false;
    return new Proxy(attestation, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property === "clisDir" && !scheduled) {
          scheduled = true;
          queueMicrotask(mutate);
        }
        return value;
      },
    });
  };
}

describe("managed Agy provider boundary (issue #252)", () => {
  test("edge: runTurn forces the Agy updater opt-out after ambient and option aliases without changing non-Agy env", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-env-force-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const controlCapture = path.join(root, "control-capture.txt");
    const restoreHome = withDisposableHome(stateDir, userHome);
    const restoreUpdate = withAmbientAgyUpdate("ambient-false");
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture);
      const descriptor: SessionDescriptor = {
        sessionId: "session-agy-env-force",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      const adapter = new CliProviderAdapter({
        id: "agy",
        displayName: "Agy",
        binary,
        buildArgs: () => ["--model", AGY_LOW_MODEL, "--print", "prompt"],
        env: {
          AGY_CLI_DISABLE_AUTO_UPDATE: "option-false",
          agy_cli_disable_auto_update: "option-alias-false",
        },
      });

      expect((await adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).error).toBeUndefined();
      const captured = parseCapture(await readFile(capture, "utf8"));
      expect(captured.agyAutoUpdate).toBe("true");
      expect(captured.agyAutoUpdateKeys).toBe("AGY_CLI_DISABLE_AUTO_UPDATE");
      expect(captured.agyAutoUpdateCount).toBe("1");

      restoreUpdate();
      const restoreControlUpdate = withAmbientAgyUpdate();
      try {
        const controlScript = fakeAgyBinary(controlCapture);
        const controlBinary = path.join(root, `control-${controlScript.name}`);
        await Bun.write(controlBinary, controlScript.content);
        if (controlScript.executable) await chmod(controlBinary, 0o700);
        const control = new CliProviderAdapter({
          id: "codex",
          displayName: "Codex",
          binary: controlBinary,
          buildArgs: () => ["--model", "gpt-test", "--print", "prompt"],
          env: { AGY_CLI_DISABLE_AUTO_UPDATE: "caller-value" },
        });
        expect(
          (
            await control.runTurn(
              { ...descriptor, sessionId: "session-codex-env-control", provider: "codex", model: "gpt-test" },
              transcript(),
              { prompt: "hi" },
            )
          ).error,
        ).toBeUndefined();
        expect(parseCapture(await readFile(controlCapture, "utf8")).agyAutoUpdate).toBe("caller-value");
      } finally {
        restoreControlUpdate();
      }
    } finally {
      restoreUpdate();
      restoreHome();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("success: a managed agy/low turn reaches the provider with the exact prompt, concrete Low model, and an absolute canonical home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-success-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture, { startupUpdater: true });
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      const promptText = "Reply with the single word ok.";
      const result = await runSessionTurn(state, adapter, descriptor, { prompt: promptText });
      expect(result.error).toBeUndefined();

      // The exact prompt and the concrete Low model reach the provider boundary.
      const captured = parseCapture(await readFile(capture, "utf8"));
      expect(captured.argv0).toBe("--model");
      expect(captured.argv1).toBe(AGY_LOW_MODEL);
      expect(captured.argv2).toBe("--print");
      expect(captured.argc).toBe("4");
      const reachedPrompt = decodePrompt(captured);
      expect(reachedPrompt).toContain(promptText);
      expect(reachedPrompt).toContain("AGY-CANONICAL-CONTEXT");
      expect(reachedPrompt.match(/Reply with the single word ok\./g)?.length).toBe(1);

      // The provider home stays canonical and absolute; no user-profile fallback.
      const providerHome = path.join(stateDir, "clis", "agy");
      expect(captured.geminiDir).toBe(path.join(providerHome, ".gemini"));
      expect(captured.home).toBe(providerHome);
      expect(captured.userProfile).toBe(providerHome);
      expect(captured.agyAutoUpdate).toBe("true");
      expect(captured.agyAutoUpdateKeys).toBe("AGY_CLI_DISABLE_AUTO_UPDATE");
      expect(captured.agyAutoUpdateCount).toBe("1");
      expect(captured.startupUpdaterDecision).toBe("disabled");
      expect(path.isAbsolute(captured.geminiDir)).toBe(true);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
      const registration = (await readProviderRegistry(state)).providers.agy;
      expect(registration).toBeDefined();
      expect((await verifyProviderRegistration(registration!)).ok).toBe(true);

      // The resolved concrete model is recorded truthfully in canonical session state.
      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      const receipt = assistant?.metadata?.receipt as Record<string, unknown> | undefined;
      const expectedReceipt = {
        provider: "agy",
        requestedModel: "low",
        concreteModel: AGY_LOW_MODEL,
        effort: "low",
        agentPreset: null,
      };
      // Exact allowlist: the manager-recorded receipt carries only the
      // issue-required model/request evidence — no env, paths, auth, prompt,
      // or secret data.
      expect(receipt).toEqual(expectedReceipt);
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toEqual(
        expectedReceipt,
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("success: a managed agy/low turn accepts a safe OS-level ancestor alias and stays inside the physical attested bin", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-ancestor-alias-"));
    const physicalRoot = path.join(root, "physical");
    const aliasRoot = path.join(root, "alias");
    const physicalStateDir = path.join(physicalRoot, ".agents");
    const aliasStateDir = path.join(aliasRoot, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(aliasStateDir, userHome);
    try {
      // Create the alias parent: junction on Windows, dir symlink on POSIX.
      await mkdir(physicalRoot, { recursive: true });
      await symlink(physicalRoot, aliasRoot, process.platform === "win32" ? "junction" : "dir");

      const state = sharedStateAt(root, aliasStateDir, userHome);
      await seedCanonicalStartup(state, aliasStateDir);
      // pinFakeAgy writes through the alias, but realpath resolves to physical.
      const binary = await pinFakeAgy(state, aliasStateDir, capture);

      // Prove the configured path is textually different from its realpath.
      const resolvedBinary = await realpath(binary);
      expect(resolvedBinary).not.toBe(binary);
      expect(binary.startsWith(aliasRoot)).toBe(true);

      await Bun.write(path.join(aliasStateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      const promptText = "Reply with the single word ok.";
      const result = await runSessionTurn(state, adapter, descriptor, { prompt: promptText });
      expect(result.error).toBeUndefined();

      // Executed exactly once.
      const captured = parseCapture(await readFile(capture, "utf8"));
      expect(captured.argc).toBe("4");
      expect(captured.argv1).toBe(AGY_LOW_MODEL);
      const reachedPrompt = decodePrompt(captured);
      expect(reachedPrompt).toContain(promptText);

      // Remains under the physical attested bin.
      const physicalBinDir = await realpath(path.join(physicalStateDir, "clis", "agy", "bin"));
      const relativeToBin = path.relative(physicalBinDir, resolvedBinary);
      expect(relativeToBin.startsWith("..") || path.isAbsolute(relativeToBin)).toBe(false);

      // No forbidden user-home .gemini.
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("edge: a spaced Windows-style canonical root stays quoted and isolated from the user-profile .gemini", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents agy edge "));
    const stateDir = path.join(root, ".agents state");
    const userHome = path.join(root, "user home");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const descriptor: SessionDescriptor = {
        sessionId: "session-edge",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      const providerHome = path.join(stateDir, "clis", "agy");
      const env = canonicalProviderEnv("agy", descriptor);

      expect(env.GEMINI_DIR).toBe(path.join(providerHome, ".gemini"));
      expect(env.HOME).toBe(providerHome);
      expect(env.USERPROFILE).toBe(providerHome);
      expect(path.isAbsolute(env.GEMINI_DIR)).toBe(true);
      expect(env.GEMINI_DIR.startsWith(path.resolve(stateDir))).toBe(true);
      // No resolution path may collapse back to the user-profile .gemini directory.
      expect(env.GEMINI_DIR).not.toBe(path.join(userHome, ".gemini"));
      expect(env.USERPROFILE).not.toBe(userHome);
      expect(env.HOME).not.toBe(userHome);

      // The low tier resolves to the concrete authenticated Low model.
      expect(resolveAgyModel("low")).toMatchObject({ concreteModel: AGY_LOW_MODEL, effort: "low" });
      const args = buildProviderArgs("agy", "low", { prompt: "hello edge" }, transcript());
      expect(args).toEqual(["--model", AGY_LOW_MODEL, "--print", "hello edge"]);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: missing canonical auth fails closed before launch and leaves no forbidden home", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-denied-auth-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      const binary = await pinFakeAgy(state, stateDir, capture);
      // Deliberately no clis/agy/.gemini/oauth_creds.json.
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-denied-auth",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        "authentication is missing",
      );
      // The provider process never launched and no standalone home was created.
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: pinned-binary checksum drift (self-update) fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-denied-drift-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      const binary = await pinFakeAgy(state, stateDir, capture);
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');
      // Simulate a self-update replacing the pinned executable behind the pin.
      await Bun.write(binary, `${fakeAgyBinary(capture).content}\n# drifted self-update\n`);
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-denied-drift",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow("drift");
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: a config-root junction/symlink escape fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-config-escape-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      const binary = await pinFakeAgy(state, stateDir, capture);
      // Relocate the config root outside the provider home and link it back in.
      const outside = path.join(root, "escaped-config");
      await mkdir(outside, { recursive: true });
      await Bun.write(path.join(outside, "oauth_creds.json"), '{"token":"redacted"}');
      await symlink(
        outside,
        path.join(stateDir, "clis", "agy", ".gemini"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-config-escape",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        /symlink or junction|resolves outside its canonical location/,
      );
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: a provider-home junction/symlink escape fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-home-escape-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      // Build the real provider home outside the canonical root and link it in.
      const outsideHome = path.join(root, "escaped-home");
      await mkdir(path.join(outsideHome, "bin"), { recursive: true });
      await mkdir(path.join(stateDir, "clis"), { recursive: true });
      await symlink(
        outsideHome,
        path.join(stateDir, "clis", "agy"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const binary = await pinFakeAgy(state, stateDir, capture);
      await Bun.write(path.join(outsideHome, ".gemini", "oauth_creds.json"), '{"token":"redacted"}');
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-home-escape",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        /symlink or junction|resolves outside its canonical location/,
      );
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: a directory masquerading as the credential fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-auth-dir-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      const binary = await pinFakeAgy(state, stateDir, capture);
      await mkdir(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), { recursive: true });
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-auth-dir",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow("not a regular file");
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: a credential symlink fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-auth-symlink-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      const binary = await pinFakeAgy(state, stateDir, capture);
      const authPath = path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json");
      const outsideCreds = path.join(root, "escaped-creds.json");
      await Bun.write(outsideCreds, '{"token":"redacted"}');
      await mkdir(path.dirname(authPath), { recursive: true });
      try {
        await symlink(outsideCreds, authPath, "file");
      } catch {
        // Conditional fixture: file symlinks need privilege on some Windows hosts.
        return;
      }
      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-auth-symlink",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        /symlink or junction|resolves outside its canonical location/,
      );
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  // Windows does not honor chmod read bits, so the unreadable fixture is
  // posix-only; the implementation's open/close readability check covers both.
  (process.platform === "win32" ? test.skip : test)(
    "denied: an unreadable credential fails closed before launch",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-auth-unreadable-"));
      const stateDir = path.join(root, ".agents");
      const userHome = path.join(root, "user-home");
      const capture = path.join(root, "agy-capture.txt");
      const restore = withDisposableHome(stateDir, userHome);
      const authPath = path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json");
      try {
        const state = sharedStateAt(root, stateDir, userHome);
        await ensureSharedState(state);
        const binary = await pinFakeAgy(state, stateDir, capture);
        await Bun.write(authPath, '{"token":"redacted"}');
        await chmod(authPath, 0o000);
        const adapter = agySessionAdapter(binary);
        const descriptor: SessionDescriptor = {
          sessionId: "session-auth-unreadable",
          provider: "agy",
          model: "low",
          mode: "chat",
          workdir: root,
          stateDir,
        };
        await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow("not readable");
        expect(await pathExists(capture)).toBe(false);
        expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
      } finally {
        restore();
        await chmod(authPath, 0o600).catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  test("denied: coordinated registry and binary poison during launch preparation cannot replace S0", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-prespawn-poison-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const originalCapture = path.join(root, "agy-original-capture.txt");
    const replacementCapture = path.join(root, "agy-replacement-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, originalCapture);
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const initialRegistry = await readProviderRegistry(state);
      const initialRegistration = initialRegistry.providers.agy!;
      expect((await verifyProviderRegistration(initialRegistration)).ok).toBe(true);

      const replacementSuccess = "C3_REPLACEMENT_EXECUTED";
      const replacementScript = fakeAgyBinary(replacementCapture);
      const replacementContent = replacementScript.content.replaceAll("agy-probe-ok", replacementSuccess);
      const replacementSource = path.join(root, `replacement-${replacementScript.name}`);
      await Bun.write(replacementSource, replacementContent);
      if (replacementScript.executable) await chmod(replacementSource, 0o700);
      const inspectedReplacement = await inspectProviderExecutable(
        "agy",
        replacementSource,
        initialRegistration.version,
        initialRegistration.pinnedAt,
      );
      const poisonedRegistration = {
        ...initialRegistration,
        sha256: inspectedReplacement.sha256,
      };
      const poisonedRegistry = {
        schemaVersion: 1,
        providers: { ...initialRegistry.providers, agy: poisonedRegistration },
      };
      const registryPath = stateV2Paths(state).providersFile;
      const poisonedPayload = `${JSON.stringify(poisonedRegistry, null, 2)}\n`;

      const adapter = agySessionAdapter(binary);
      mutateOnceDuringAgyBuildArgs(adapter, () => {
        writeFileSync(binary, replacementContent, "utf8");
        writeFileSync(registryPath, poisonedPayload, "utf8");
      });
      const descriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const promptSentinel = "C3_PROMPT_MUST_NOT_REACH_PROVIDER";

      await expect(runSessionTurn(state, adapter, descriptor, { prompt: promptSentinel })).rejects.toThrow(
        "immediately before launch",
      );

      // S1 is internally valid for the replacement bytes. A final registry
      // reread would bless it, while immutable S0 must reject before execution.
      const poisonedCurrent = (await readProviderRegistry(state)).providers.agy!;
      expect(poisonedCurrent).toEqual(poisonedRegistration);
      expect((await verifyProviderRegistration(poisonedCurrent)).ok).toBe(true);
      expect(await pathExists(originalCapture)).toBe(false);
      expect(await pathExists(replacementCapture)).toBe(false);

      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("immediately before launch");
      expect(assistant?.content).not.toContain(replacementSuccess);
      expect(assistant?.content).not.toContain(promptSentinel);
      expect(assistant?.content).not.toContain("GEMINI_DIR=");
      expect(assistant?.content).not.toContain("HOME=");
      expect(assistant?.content).not.toContain("USERPROFILE=");
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: async executable replacement during boundary verification is caught before spawn", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-prespawn-interval-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const originalCapture = path.join(root, "agy-original-capture.txt");
    const replacementCapture = path.join(root, "agy-replacement-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, originalCapture);
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const replacementSuccess = "ASYNC_REPLACEMENT_EXECUTED";
      const replacementScript = fakeAgyBinary(replacementCapture);
      const replacementContent = replacementScript.content.replaceAll("agy-probe-ok", replacementSuccess);
      const adapter = agySessionAdapter(binary);
      mutateOnceDuringAgyBoundaryVerification(adapter, () => writeFileSync(binary, replacementContent, "utf8"));
      const descriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const promptSentinel = "ASYNC_PROMPT_MUST_NOT_REACH_PROVIDER";

      await expect(runSessionTurn(state, adapter, descriptor, { prompt: promptSentinel })).rejects.toThrow(
        "immediately before launch",
      );

      expect(await pathExists(originalCapture)).toBe(false);
      expect(await pathExists(replacementCapture)).toBe(false);
      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("attested executable checksum changed");
      expect(assistant?.content).not.toContain(replacementSuccess);
      expect(assistant?.content).not.toContain(promptSentinel);
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: an output-read failure cannot bypass postflight executable drift attestation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-postflight-output-error-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    let exited: Promise<number> | undefined;
    let spawnSpy: ReturnType<typeof spyOn> | undefined;
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture);
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');
      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const outputFailure = "synthetic stdout read failure";
      const replacement = `${fakeAgyBinary(capture).content}\n# persistent replacement before exit\n`;
      spawnSpy = spyOn(Bun, "spawn").mockImplementation((() => {
        const stdout = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.error(new Error(outputFailure));
          },
        });
        const stderr = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        exited = new Promise<number>((resolve, reject) => {
          setTimeout(() => {
            try {
              writeFileSync(binary, replacement, "utf8");
              resolve(0);
            } catch (error) {
              reject(error);
            }
          }, 25);
        });
        return { stdout, stderr, exited } as unknown as ReturnType<typeof Bun.spawn>;
      }) as typeof Bun.spawn);

      await expect(runSessionTurn(state, adapter, descriptor, { prompt: "must not survive drift" })).rejects.toThrow(
        "after the managed run",
      );

      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("attested executable checksum changed");
      expect(assistant?.content).not.toContain(outputFailure);
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toBeUndefined();
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      await exited?.catch(() => {});
      spawnSpy?.mockRestore();
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: auth removed during launch preparation fails before the streaming fallback can execute", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-prespawn-auth-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture);
      const authPath = path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json");
      await Bun.write(authPath, '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      mutateOnceDuringAgyBuildArgs(adapter, () => unlinkSync(authPath));
      const descriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const chunks: Array<{ type: string; delta?: string }> = [];
      const collect = async () => {
        for await (const chunk of streamSessionTurn(state, adapter, descriptor, { prompt: "auth temporal probe" })) {
          chunks.push(chunk);
        }
      };

      await expect(collect()).rejects.toThrow("immediately before launch");
      expect(await pathExists(capture)).toBe(false);
      expect(chunks.some((chunk) => chunk.type === "text" || chunk.delta?.includes("agy-probe-ok"))).toBe(false);
      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("canonical authentication is missing immediately before launch");
      expect(assistant?.content).not.toContain("agy-probe-ok");
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: executable replaced during the managed run fails closed after exit and persists no success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-midrun-drift-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture, { selfMutate: true });
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      await expect(runSessionTurn(state, adapter, descriptor, { prompt: "hi" })).rejects.toThrow("drift");

      // The fake provider emitted output and exited cleanly, yet the post-exit
      // re-verification refuses the result: no success content and no receipt.
      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("drift");
      expect(assistant?.content).toContain("after the managed run");
      expect(assistant?.content).not.toContain("agy-probe-ok");
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: executable replaced during the managed run fails closed through the streaming path with no success and no receipt", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-midrun-stream-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture, { selfMutate: true });
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      const chunks: Array<{ type: string; delta?: string }> = [];
      const collect = async () => {
        for await (const chunk of streamSessionTurn(state, adapter, descriptor, { prompt: "hi" })) {
          chunks.push(chunk);
        }
      };
      await expect(collect()).rejects.toThrow("drift");

      // No success chunk streamed, and the persisted turn carries only the error.
      expect(chunks.some((chunk) => chunk.delta?.includes("agy-probe-ok"))).toBe(false);
      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("drift");
      expect(assistant?.content).not.toContain("agy-probe-ok");
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: a coordinated registry+binary swap during the run cannot bless the replaced executable", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-registry-swap-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);

      // Pre-bake the swapped executable and a registry payload that blesses it;
      // the fake applies both during the run, as a malicious self-update would.
      const swappedSource = path.join(root, "agy-swapped");
      await Bun.write(swappedSource, `${fakeAgyBinary(capture).content}\n# coordinated swap\n`);
      const registryPath = stateV2Paths(state).providersFile;
      const payloadPath = path.join(root, "poisoned-registry.json");
      const binary = await pinFakeAgy(state, stateDir, capture, {
        poison: { binarySourcePath: swappedSource, registryPath, payloadPath },
      });
      const registry = await readProviderRegistry(state);
      const registration = registry.providers.agy!;
      // Build the poisoned registration from the real swapped fixture using the
      // production registry helpers, so the alternate executable path,
      // realpath, and sha256 all match. A hypothetical postflight that reread
      // and followed the registry would accept this target.
      const poisonedRegistration = await inspectProviderExecutable("agy", swappedSource, registration.version);
      expect((await verifyProviderRegistration(poisonedRegistration)).ok).toBe(true);
      await Bun.write(
        payloadPath,
        `${JSON.stringify({ schemaVersion: 1, providers: { agy: poisonedRegistration } }, null, 2)}\n`,
      );
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      // The real snapshot-only attestation still rejects the replaced launch
      // executable because postflight never rereads the mutable registry.
      await expect(runSessionTurn(state, adapter, descriptor, { prompt: "hi" })).rejects.toThrow("drift");

      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.content).toContain("drift");
      expect(assistant?.content).toContain("after the managed run");
      expect(assistant?.content).not.toContain("agy-probe-ok");
      expect(assistant?.metadata?.error).toBe(true);
      expect(assistant?.metadata?.receipt).toBeUndefined();
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("stream: a managed agy/low turn records the truthful receipt through the streaming path", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-stream-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const binary = await pinFakeAgy(state, stateDir, capture, { startupUpdater: true });
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor = await createSession(state, { provider: "agy", model: "low", mode: "chat", workdir: root });
      const chunks: Array<{ type: string; delta?: string }> = [];
      for await (const chunk of streamSessionTurn(state, adapter, descriptor, { prompt: "Reply with the single word ok." })) {
        chunks.push(chunk);
      }
      expect(chunks.some((chunk) => chunk.type === "text" && chunk.delta?.includes("agy-probe-ok"))).toBe(true);

      const captured = parseCapture(await readFile(capture, "utf8"));
      expect(captured.agyAutoUpdate).toBe("true");
      expect(captured.agyAutoUpdateKeys).toBe("AGY_CLI_DISABLE_AUTO_UPDATE");
      expect(captured.agyAutoUpdateCount).toBe("1");
      expect(captured.startupUpdaterDecision).toBe("disabled");
      const registration = (await readProviderRegistry(state)).providers.agy;
      expect(registration).toBeDefined();
      expect((await verifyProviderRegistration(registration!)).ok).toBe(true);

      const transcriptResult = await loadTranscript(state, descriptor.sessionId);
      const assistant = transcriptResult?.messages.find((message) => message.role === "assistant");
      expect(assistant?.metadata?.error).toBeUndefined();
      const receipt = assistant?.metadata?.receipt as Record<string, unknown> | undefined;
      const expectedReceipt = {
        provider: "agy",
        requestedModel: "low",
        concreteModel: AGY_LOW_MODEL,
        effort: "low",
        agentPreset: null,
      };
      // Exact allowlist: the manager-recorded receipt carries only the
      // issue-required model/request evidence — no env, paths, auth, prompt,
      // or secret data.
      expect(receipt).toEqual(expectedReceipt);
      expect(completedTurnEvent(await loadSessionEvents(state, descriptor.sessionId)).data.receipt).toEqual(
        expectedReceipt,
      );
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("edge: ordinary provider errors keep the truthful receipt in normal and stream paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-provider-error-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await seedCanonicalStartup(state, stateDir);
      const providerError = "fake provider rejected the request";
      const binary = await pinFakeAgy(state, stateDir, capture, { startupUpdater: true, providerError });
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');
      const adapter = agySessionAdapter(binary);
      const expectedReceipt = {
        provider: "agy",
        requestedModel: "low",
        concreteModel: AGY_LOW_MODEL,
        effort: "low",
        agentPreset: null,
      };

      const normalDescriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const normalResult = await runSessionTurn(state, adapter, normalDescriptor, { prompt: "normal error" });
      expect(normalResult.error).toContain(providerError);
      expect(normalResult.receipt).toEqual(expectedReceipt);
      const normalTranscript = await loadTranscript(state, normalDescriptor.sessionId);
      const normalAssistant = normalTranscript?.messages.find((message) => message.role === "assistant");
      expect(normalAssistant?.metadata?.error).toBe(true);
      expect(normalAssistant?.metadata?.receipt).toEqual(expectedReceipt);
      expect(completedTurnEvent(await loadSessionEvents(state, normalDescriptor.sessionId)).data.receipt).toEqual(
        expectedReceipt,
      );

      const streamDescriptor = await createSession(state, {
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
      });
      const chunks: Array<{ type: string; error?: string }> = [];
      for await (const chunk of streamSessionTurn(state, adapter, streamDescriptor, { prompt: "stream error" })) {
        chunks.push(chunk);
      }
      expect(chunks.some((chunk) => chunk.type === "error" && chunk.error?.includes(providerError))).toBe(true);
      const streamTranscript = await loadTranscript(state, streamDescriptor.sessionId);
      const streamAssistant = streamTranscript?.messages.find((message) => message.role === "assistant");
      expect(streamAssistant?.metadata?.error).toBe(true);
      expect(streamAssistant?.metadata?.receipt).toEqual(expectedReceipt);
      expect(completedTurnEvent(await loadSessionEvents(state, streamDescriptor.sessionId)).data.receipt).toEqual(
        expectedReceipt,
      );

      const captured = parseCapture(await readFile(capture, "utf8"));
      expect(captured.startupUpdaterDecision).toBe("disabled");
      const registration = (await readProviderRegistry(state)).providers.agy;
      expect(registration).toBeDefined();
      expect((await verifyProviderRegistration(registration!)).ok).toBe(true);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);

  test("denied: a bin junction/symlink escape fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-bin-escape-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      // Build the real bin directory outside the canonical provider home and
      // link it in as clis/agy/bin. The executable is physically outside the
      // canonical boundary, so a launch through the canonical path escapes.
      const outsideBin = path.join(root, "escaped-bin");
      await mkdir(outsideBin, { recursive: true });
      await mkdir(path.join(stateDir, "clis", "agy"), { recursive: true });
      await symlink(
        outsideBin,
        path.join(stateDir, "clis", "agy", "bin"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const binary = await pinFakeAgy(state, stateDir, capture);
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-bin-escape",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        /symlink or junction|resolves outside its canonical location/,
      );
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("denied: an executable symlink escape fails closed before launch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-agy-exe-symlink-"));
    const stateDir = path.join(root, ".agents");
    const userHome = path.join(root, "user-home");
    const capture = path.join(root, "agy-capture.txt");
    const restore = withDisposableHome(stateDir, userHome);
    try {
      const state = sharedStateAt(root, stateDir, userHome);
      await ensureSharedState(state);
      // Create a real executable outside the canonical bin and link it in as
      // the configured executable. The canonical bin directory stays physical,
      // but the executable itself is a symlink escape.
      const outsideBin = path.join(root, "escaped-bin");
      await mkdir(outsideBin, { recursive: true });
      const script = fakeAgyBinary(capture);
      const outsideExe = path.join(outsideBin, script.name);
      await Bun.write(outsideExe, script.content);
      if (script.executable) await chmod(outsideExe, 0o700);

      const canonicalBin = path.join(stateDir, "clis", "agy", "bin");
      await mkdir(canonicalBin, { recursive: true });
      const binary = path.join(canonicalBin, script.name);
      try {
        await symlink(outsideExe, binary, "file");
      } catch {
        // Conditional fixture: file symlinks need privilege on some Windows hosts.
        return;
      }
      await writeProviderRegistration(state, await inspectProviderExecutable("agy", binary, "1.1.1"));
      await Bun.write(path.join(stateDir, "clis", "agy", ".gemini", "oauth_creds.json"), '{"token":"redacted"}');

      const adapter = agySessionAdapter(binary);
      const descriptor: SessionDescriptor = {
        sessionId: "session-exe-symlink",
        provider: "agy",
        model: "low",
        mode: "chat",
        workdir: root,
        stateDir,
      };
      await expect(adapter.runTurn(descriptor, transcript(), { prompt: "hi" })).rejects.toThrow(
        /symlink or junction|resolves outside its canonical location/,
      );
      expect(await pathExists(capture)).toBe(false);
      expect(await pathExists(path.join(userHome, ".gemini"))).toBe(false);
    } finally {
      restore();
      await rm(root, { recursive: true, force: true });
    }
  });
});
