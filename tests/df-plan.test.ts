import assert from "node:assert/strict";
import test from "node:test";

const PRD_CONTENT = `## Core loops

- **L0 Orchestrator**: keeps the backlog sequenced. Acceptance: backlog drains.
`;

const COMPLETED_PRD_CONTENT = `## Core loops

- [x] **L0 Orchestrator**: keeps the backlog sequenced. Acceptance: backlog drains.
`;

function makeIssue(number: number, state: string, body: string, labels: string[] = []) {
  return { number, state, body, labels: labels.map((name) => ({ name })), html_url: `https://github.com/marius-patrik/example/issues/${number}` };
}

function createMockGh(options: {
  closer?: { login: string } | null;
  controlIssues?: any[];
} = {}) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  let askOwnerNumber = 100;

  const gh = {
    async request(method: string, path: string, body?: unknown) {
      calls.push({ method, path, body });

      if (method === "GET" && path === "/repos/marius-patrik/example") {
        return { default_branch: "main", allow_auto_merge: true };
      }

      if (method === "POST" && path === "/repos/marius-patrik/example/labels") return {};
      if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/labels") return {};

      if (method === "GET" && path === "/repos/marius-patrik/example/git/trees/main?recursive=1") {
        return { tree: [{ type: "blob", path: "PRD.md" }] };
      }

      if (method === "GET" && path === "/repos/marius-patrik/example/contents/PRD.md?ref=main") {
        return {
          type: "file",
          encoding: "base64",
          content: Buffer.from(PRD_CONTENT, "utf8").toString("base64")
        };
      }

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=all&per_page=100&page=1") {
        return [
          makeIssue(1, "closed", `<!-- df-prd:core-loops-l0 -->\n## Source\n\nPRD.md > Core loops > L0 Orchestrator`)
        ];
      }

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=all&per_page=100&page=2") return [];

      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=1") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/issues?state=open&per_page=100&page=2") return [];

      if (method === "GET" && path === "/repos/marius-patrik/example/pulls?state=open&per_page=100&page=1") return [];
      if (method === "GET" && path === "/repos/marius-patrik/example/pulls?state=open&per_page=100&page=2") return [];

      if (method === "GET" && path === "/repos/marius-patrik/example/issues/1") {
        return makeIssue(1, "closed", `<!-- df-prd:core-loops-l0 -->\n## Source\n\nPRD.md > Core loops > L0 Orchestrator`);
      }

      if (method === "GET" && path === "/repos/marius-patrik/example/issues/1/timeline?per_page=100&page=1") {
        if (options.closer) {
          return [{ event: "closed", actor: options.closer }];
        }
        return [];
      }

      if (method === "POST" && path === "/repos/marius-patrik/example/issues/1/comments") return {};

      if (method === "GET" && path === "/repos/marius-patrik/agent-darkfactory/issues?state=all&per_page=100&page=1") {
        return options.controlIssues || [];
      }

      if (method === "GET" && path === "/repos/marius-patrik/agent-darkfactory/issues?state=all&per_page=100&page=2") return [];

      if (method === "GET" && path === "/repos/marius-patrik/agent-darkfactory/issues/100") {
        return { number: 100, state: "open", body: "", labels: [], html_url: "https://github.com/marius-patrik/agent-darkfactory/issues/100" };
      }

      if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/issues/100/labels") return {};
      if (method === "DELETE" && path.startsWith("/repos/marius-patrik/agent-darkfactory/issues/100/labels/")) return {};

      if (method === "POST" && path === "/repos/marius-patrik/agent-darkfactory/issues") {
        const created = { number: askOwnerNumber, html_url: `https://github.com/marius-patrik/agent-darkfactory/issues/${askOwnerNumber}` };
        askOwnerNumber += 1;
        return created;
      }

      if (method === "PATCH" && path === "/repos/marius-patrik/agent-darkfactory/issues/100") {
        return { number: 100, html_url: "https://github.com/marius-patrik/agent-darkfactory/issues/100" };
      }

      if (method === "POST" && path === "/repos/marius-patrik/example/issues/1/labels") return {};
      if (method === "DELETE" && path.startsWith("/repos/marius-patrik/example/issues/1/labels/")) return {};

      if (method === "PATCH" && path === "/repos/marius-patrik/example/issues/1") {
        return { number: 1, html_url: "https://github.com/marius-patrik/example/issues/1", state: "open" };
      }

      throw new Error(`Unexpected GitHub request: ${method} ${path}`);
    }
  };

  return { gh, calls, nextAskOwnerNumber: () => askOwnerNumber };
}

test("human-closed + PRD-incomplete → no reopen, single idempotent ask-owner escalation", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { reconcileRepository } = await import("../.github/scripts/df-plan.mjs?unit=df-plan-human-closed-test");

  const { gh, calls } = createMockGh({ closer: { login: "marius-patrik" }, controlIssues: [] });

  const result = await reconcileRepository({
    gh,
    targetRepo: { owner: "marius-patrik", repo: "example" },
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
    dataRepo: "marius-patrik/darkfactory-data",
    trigger: "schedule",
    sourceRef: "main",
    planAll: false,
    writeLedger: false
  });

  const reopenPatch = calls.find((call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/example/issues/1");
  assert.equal(reopenPatch, undefined, "should not reopen a human-closed issue");

  const comment = calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/example/issues/1/comments");
  assert.ok(comment, "should post a comment on the closed issue");
  assert.match(String(comment?.body?.body || ""), /PRD still lists/);

  const askOwnerCreate = calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/agent-darkfactory/issues");
  assert.ok(askOwnerCreate, "should create an ask-owner issue in the control repo");
  assert.match(String(askOwnerCreate?.body?.body || ""), /df-ask-owner:human-closed-prd:marius-patrik-example:core-loops-l0/);
  assert.deepEqual(askOwnerCreate?.body?.labels, ["P1", "df:ask-owner", "df:class:hard"]);

  const escalationAction = result.ledger.actions.find((action: any) => action.action === "escalate-human-closed-prd-issue");
  assert.ok(escalationAction, "ledger records the escalation action");
  assert.equal(escalationAction.escalation.closer, "marius-patrik");

  // Second tick with the ask-owner issue now present: should update, not duplicate.
  const askOwnerIssue = { number: 100, body: String(askOwnerCreate?.body?.body || ""), state: "open", labels: [], html_url: "https://github.com/marius-patrik/agent-darkfactory/issues/100" };
  const { gh: gh2, calls: calls2 } = createMockGh({ closer: { login: "marius-patrik" }, controlIssues: [askOwnerIssue] });

  await reconcileRepository({
    gh: gh2,
    targetRepo: { owner: "marius-patrik", repo: "example" },
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
    dataRepo: "marius-patrik/darkfactory-data",
    trigger: "schedule",
    sourceRef: "main",
    planAll: false,
    writeLedger: false
  });

  const askOwnerCreate2 = calls2.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/agent-darkfactory/issues");
  assert.equal(askOwnerCreate2, undefined, "should not create a duplicate ask-owner issue");

  const askOwnerUpdate = calls2.find((call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/agent-darkfactory/issues/100");
  assert.ok(askOwnerUpdate, "should update the existing ask-owner issue");
  assert.equal(askOwnerUpdate?.body?.state, "open");
});

test("bot-closed + PRD-incomplete → reopened as today", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { reconcileRepository } = await import("../.github/scripts/df-plan.mjs?unit=df-plan-bot-closed-test");

  const { gh, calls } = createMockGh({ closer: { login: "mp-agents[bot]" }, controlIssues: [] });

  const result = await reconcileRepository({
    gh,
    targetRepo: { owner: "marius-patrik", repo: "example" },
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
    dataRepo: "marius-patrik/darkfactory-data",
    trigger: "schedule",
    sourceRef: "main",
    planAll: false,
    writeLedger: false
  });

  const reopenPatch = calls.find((call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/example/issues/1");
  assert.ok(reopenPatch, "should reopen a bot-closed issue");
  assert.equal(reopenPatch?.body?.state, "open");

  const escalation = calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/agent-darkfactory/issues");
  assert.equal(escalation, undefined, "should not escalate a bot-closed issue");

  const reopenAction = result.ledger.actions.find((action: any) => action.action === "reopen-prd-issue");
  assert.ok(reopenAction, "ledger records the reopen action");
});

test("human-closed + PRD-completed [x] → keep-closed as today", async () => {
  // @ts-ignore Script helpers are native ESM workflow files, not built TypeScript modules.
  const { reconcileRepository } = await import("../.github/scripts/df-plan.mjs?unit=df-plan-human-completed-test");

  const { gh, calls } = createMockGh({ closer: { login: "marius-patrik" }, controlIssues: [] });

  // Override PRD content to be completed for this test.
  const originalRequest = gh.request.bind(gh);
  gh.request = async (method: string, path: string, body?: unknown) => {
    if (method === "GET" && path === "/repos/marius-patrik/example/contents/PRD.md?ref=main") {
      return {
        type: "file",
        encoding: "base64",
        content: Buffer.from(COMPLETED_PRD_CONTENT, "utf8").toString("base64")
      };
    }
    return originalRequest(method, path, body);
  };

  const result = await reconcileRepository({
    gh,
    targetRepo: { owner: "marius-patrik", repo: "example" },
    controlRepo: { owner: "marius-patrik", repo: "agent-darkfactory" },
    dataRepo: "marius-patrik/darkfactory-data",
    trigger: "schedule",
    sourceRef: "main",
    planAll: false,
    writeLedger: false
  });

  const reopenPatch = calls.find((call) => call.method === "PATCH" && call.path === "/repos/marius-patrik/example/issues/1");
  assert.equal(reopenPatch, undefined, "should not reopen a completed PRD item");

  const escalation = calls.find((call) => call.method === "POST" && call.path === "/repos/marius-patrik/agent-darkfactory/issues");
  assert.equal(escalation, undefined, "should not escalate a completed PRD item");

  const keepClosedAction = result.ledger.actions.find((action: any) => action.action === "keep-closed");
  assert.ok(keepClosedAction, "ledger records the keep-closed action");
});
