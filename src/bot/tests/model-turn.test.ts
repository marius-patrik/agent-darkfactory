import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ModelTurnError,
  classifyRepositoryOverlay,
  composeModelTurn,
  executeModelTurn,
  validationCommandsForRepository,
  type ModelTurnIntent
} from "../model-turn.js";
import { defaultPromptsRoot } from "../prompts.js";

// @ts-ignore Workflow policy helpers are native ESM, not built TypeScript modules.
const modelPolicyModule: any = await import("../../../scripts/df-model-policy.mjs");

const REVISION = "0123456789abcdef0123456789abcdef01234567";
const NOW = new Date("2026-07-15T12:00:00.000Z");

function intent(overrides: Partial<ModelTurnIntent> = {}): ModelTurnIntent {
  const repository = { owner: "marius-patrik", repo: "DarkFactory", defaultBranch: "dev" };
  return {
    runId: "run-51-integration",
    triggeredBy: "workflow",
    profile: "profile/implementer",
    repository,
    repositoryPaths: ["package.json", "src/index.ts", "tests/index.ts"],
    workItem: {
      kind: "issue",
      number: 51,
      author: "marius-patrik",
      url: "https://github.com/marius-patrik/DarkFactory/issues/51",
      title: "Integrate prompt composition",
      body: "Use one composition boundary.",
      comments: []
    },
    draftIntent: null,
    policy: {
      branching: "Use one issue branch and one reviewed pull request.",
      labels: ["P1", "df:running"],
      enforcement: "Require green validation and the configured review gate."
    },
    validation: { commands: ["npm run check"] },
    verified: {
      observedAt: NOW.toISOString(),
      facts: ["Issue 51 is open and the selected base is dev."]
    },
    effort: "medium",
    controlRevision: REVISION,
    now: NOW,
    ...overrides
  };
}

function successfulReceipt(request: any) {
  return {
    schemaVersion: 2,
    requested: { modelTier: request.modelTier, effort: request.effort },
    routing: {
      policyVersion: "fixture-route-policy-v1",
      primary: { provider: "fixture-primary", model: "fixture/primary-model", agentPreset: "Fixture-Primary", providerVersion: "1.0.0" },
      skipped: []
    },
    resolved: {
      provider: "fixture-provider",
      model: "fixture/model-v1",
      agentPreset: "Fixture",
      providerVersion: "1.0.0", toolPolicy: "standard"
    },
    attempts: [{ number: 1, outcome: "success", reason: null }],
    usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
    outcome: "success",
    blockReason: null
  };
}

test("CLI and Actions compose byte-identical prompts and complete immutable provenance", async () => {
  const logicalInput = intent();
  const cli = await composeModelTurn(logicalInput);
  const actions = await composeModelTurn(structuredClone(logicalInput));
  assert.equal(cli.prompt, actions.prompt);
  assert.deepEqual(cli.provenance, actions.provenance);
  assert.equal(cli.provenance.controlRevision, REVISION);
  assert.equal(cli.provenance.profile.id, "profile/implementer");
  assert.equal(cli.provenance.selection.modelTier, "medium");
  assert.equal(cli.provenance.selection.effort, "medium");
  assert.equal(cli.provenance.selection.repositoryOverlay, "overlay/bun-node");
  assert.ok(cli.provenance.artifacts.some((artifact) => artifact.id === "output/implementer"));
  assert.match(cli.provenance.promptChecksum, /^sha256:[0-9a-f]{64}$/);
  assert.match(cli.provenance.manifest.checksum, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(cli.provenance), /DARK_FACTORY_TOKEN|never-forward|PRIVATE_KEY|AUTH_JSON/i);
});

test("repository overlay and validation selection share one trusted classification", () => {
  const repository = { owner: "marius-patrik", repo: "example" };
  assert.equal(classifyRepositoryOverlay(repository, ["go.mod", "cmd/main.go"]), "overlay/go");
  assert.deepEqual(validationCommandsForRepository(repository, ["go.mod", "cmd/main.go"]), ["go test ./..."]);
  assert.equal(
    classifyRepositoryOverlay(repository, ["package.json", "go.mod", "pyproject.toml"]),
    "overlay/mixed-monorepo"
  );
  assert.deepEqual(
    validationCommandsForRepository(repository, ["package.json", "go.mod", "pyproject.toml"]),
    ["npm run check", "go test ./...", "uv run pytest"]
  );
  assert.throws(() => classifyRepositoryOverlay(repository, ["README.md"]), /cannot be classified/);
});

test("every current model-backed entrypoint converges on the shared composition boundary", async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const worker = await readFile(path.join(root, ".github", "scripts", "df-work.mjs"), "utf8");
  const autoreview = await readFile(path.join(root, ".github", "scripts", "run-darkfactory-autoreview.mjs"), "utf8");
  const boundary = await readFile(path.join(root, "src", "model-turn.ts"), "utf8");
  assert.match(worker, /executeModelTurn/);
  assert.match(autoreview, /executeModelTurn/);
  assert.match(boundary, /adapters\.agentRunArguments/);
  assert.doesNotMatch(`${worker}\n${autoreview}`, /runAgentTurn|reviewPrompt|prFixPrompt|issueFixPrompt|df-task-brief|df-worker-summary/);
  assert.doesNotMatch(`${worker}\n${autoreview}`, /agentRunArguments\s*\(/);
  for (const deterministic of ["df-plan.mjs", "df-orchestrate.mjs", "df-audit.mjs", "df-sweep.mjs", "df-verify.mjs"]) {
    const source = await readFile(path.join(root, ".github", "scripts", deterministic), "utf8");
    assert.doesNotMatch(source, /executeModelTurn|agentRunArguments\s*\(/, `${deterministic} must remain model-free`);
  }
});

test("missing or stale evidence, unknown profiles, and prompt checksum drift fail closed", async () => {
  await assert.rejects(
    composeModelTurn(intent({ verified: { observedAt: NOW.toISOString(), facts: [] } })),
    /non-empty verified state/
  );
  await assert.rejects(
    composeModelTurn(intent({ verified: { observedAt: "2026-07-15T10:00:00.000Z", facts: ["old"] } })),
    /stale/
  );
  await assert.rejects(composeModelTurn(intent({ profile: "profile/not-real" })), /Unknown prompt worker profile/);

  const copy = await mkdtemp(path.join(tmpdir(), "df-model-turn-prompts-"));
  try {
    await cp(defaultPromptsRoot(), copy, { recursive: true });
    await writeFile(path.join(copy, "roles", "implementer.md"), "tampered\n");
    await assert.rejects(composeModelTurn(intent(), copy), /checksum/i);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
});

test("canonical execution rejects mismatched requests and unavailable launchers with prompt evidence", async () => {
  const policy = await modelPolicyModule.loadModelPolicy(path.resolve(import.meta.dirname, ".."));
  const request = modelPolicyModule.modelRequestForPurpose(policy, "implementation", { taskClass: "standard" });
  const root = await mkdtemp(path.join(tmpdir(), "df-model-turn-exec-"));
  try {
    await assert.rejects(
      executeModelTurn(
        {
          intent: intent(),
          request: { ...request, modelTier: "high" },
          tempRoot: path.join(root, "turns"),
          turnName: "implementation",
          cwd: root,
          executionPolicy: "workspace-write",
          environment: { ANDROMEDA_HOME: path.join(root, "missing-agents") }
        },
        {
          agentRunArguments: modelPolicyModule.agentRunArguments,
          validateAgentExecutionReceipt: modelPolicyModule.validateAgentExecutionReceipt
        }
      ),
      (error: unknown) => error instanceof ModelTurnError && error.code === "model_request_mismatch" && error.prompt !== null
    );

    await assert.rejects(
      executeModelTurn(
        {
          intent: intent(),
          request,
          tempRoot: path.join(root, "turns"),
          turnName: "implementation",
          cwd: root,
          executionPolicy: "workspace-write",
          environment: { ANDROMEDA_HOME: path.join(root, "missing-agents") }
        },
        {
          agentRunArguments: modelPolicyModule.agentRunArguments,
          validateAgentExecutionReceipt: modelPolicyModule.validateAgentExecutionReceipt
        }
      ),
      (error: unknown) => error instanceof ModelTurnError && error.code === "canonical_launcher_unavailable" && error.prompt !== null
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed model output keeps exact prompt and route receipts on the closed failure", async () => {
  const policy = await modelPolicyModule.loadModelPolicy(path.resolve(import.meta.dirname, ".."));
  const request = modelPolicyModule.modelRequestForPurpose(policy, "implementation", { taskClass: "standard" });
  const root = await mkdtemp(path.join(tmpdir(), "df-model-turn-malformed-"));
  const agentsHome = path.join(root, "agents");
  mkdirSync(path.join(agentsHome, "bin"), { recursive: true });
  writeFileSync(path.join(agentsHome, "bin", "agents.ps1"), "# fixture\n");
  try {
    await assert.rejects(
      executeModelTurn(
        {
          intent: intent(),
          request,
          tempRoot: path.join(root, "turns"),
          turnName: "implementation",
          cwd: root,
          executionPolicy: "workspace-write",
          environment: {
            ANDROMEDA_HOME: agentsHome,
            PATH: "trusted-path",
            DARK_FACTORY_TOKEN: "never-forward",
            OPENAI_API_KEY: "never-forward",
            ANTHROPIC_API_KEY: "never-forward",
            AWS_ACCESS_KEY_ID: "never-forward",
            GITHUB_PASSWORD: "never-forward",
            GOOGLE_APPLICATION_CREDENTIALS: "never-forward",
            SAFE_BUT_UNDECLARED: "never-forward"
          }
        },
        {
          agentRunArguments: modelPolicyModule.agentRunArguments,
          validateAgentExecutionReceipt: modelPolicyModule.validateAgentExecutionReceipt,
          spawn: ((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
            assert.equal(command, "pwsh");
            assert.deepEqual(options.env, { ANDROMEDA_HOME: agentsHome, PATH: "trusted-path" });
            const receiptPath = args[args.indexOf("--receipt") + 1];
            writeFileSync(receiptPath, `${JSON.stringify(successfulReceipt(request))}\n`);
            return { status: 0, stdout: "not-json", stderr: "", error: undefined };
          }) as any
        }
      ),
      (error: unknown) => {
        assert.ok(error instanceof ModelTurnError);
        assert.equal(error.code, "malformed_result");
        assert.equal(error.prompt?.controlRevision, REVISION);
        assert.equal(error.receipt?.resolved.model, "fixture/model-v1");
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
