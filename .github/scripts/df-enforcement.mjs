import { getOptionalFileContent, repoName, normalizedRepoName } from "./df-lib.mjs";

export const ENFORCEMENT_RULES_PATH = ".darkfactory/enforcement-rules.json";

/**
 * Default enforcement rules bundled with DarkFactory. These are used when a
 * target repository does not yet define its own `.darkfactory/enforcement-rules.json`
 * and as the base set that repository-specific rules extend or override.
 */
export const DEFAULT_ENFORCEMENT_RULES = {
  schemaVersion: 1,
  description:
    "DarkFactory configurable enforcement rules. Evaluated by df-work and df-follow-through as merge/action gates. Rules are declarative and extensible: new gates can be added by declaring a supported gate type with parameters, and new gate types can be registered in the rule engine without changing the schema.",
  rules: [
    {
      id: "never-merge-red",
      enabled: true,
      scope: ["merge"],
      gate: "required_checks_pass",
      message: "All required checks must be success before merging."
    },
    {
      id: "no-force-push",
      enabled: true,
      scope: ["dispatch", "merge"],
      gate: "policy_assertion",
      message: "DarkFactory workers never force-push."
    },
    {
      id: "no-admin-bypass",
      enabled: true,
      scope: ["merge"],
      gate: "policy_assertion",
      message: "DarkFactory never bypasses branch protection or admin gates."
    },
    {
      id: "secrets-never-logged",
      enabled: true,
      scope: ["dispatch", "merge"],
      gate: "policy_assertion",
      message: "DarkFactory redacts secrets from logs and comments."
    },
    {
      id: "parked-repos-untouched",
      enabled: true,
      scope: ["dispatch", "merge"],
      gate: "repo_not_in_set",
      params: {
        set: [
          "marius-patrik/fabrica",
          "marius-patrik/skyblock-agent",
          "marius-patrik/singularity",
          "marius-patrik/life-support"
        ]
      },
      message: "DarkFactory must not act on parked repositories."
    },
    {
      id: "work-PRs-target-dev",
      enabled: true,
      scope: ["dispatch"],
      gate: "base_branch_is",
      params: { branch: "dev", fallback_to_default: true },
      message: "DarkFactory work PRs must target the dev branch where it exists."
    }
  ]
};

/**
 * Load enforcement rules for a repository. Repository-specific rules in
 * `.darkfactory/enforcement-rules.json` take precedence; if missing or invalid,
 * the bundled defaults are returned so every evaluation has a deterministic rule
 * set.
 */
export async function loadEnforcementRules(gh, repository, options = {}) {
  const defaults = options.defaults ?? DEFAULT_ENFORCEMENT_RULES;
  const content = await getOptionalFileContent(gh, repository, ENFORCEMENT_RULES_PATH, options.ref);

  if (!content) {
    return { ...defaults, source: "default" };
  }

  try {
    const parsed = JSON.parse(content);
    const rules = normalizeRules(parsed, defaults);
    return { ...rules, source: ENFORCEMENT_RULES_PATH };
  } catch (error) {
    return {
      ...defaults,
      source: "default",
      parseError: error.message || String(error)
    };
  }
}

function normalizeRules(parsed, defaults) {
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.rules)) {
    return defaults;
  }

  const rules = parsed.rules
    .filter((rule) => rule && typeof rule === "object" && rule.enabled !== false)
    .map((rule) => ({
      id: String(rule.id || ""),
      enabled: rule.enabled !== false,
      scope: Array.isArray(rule.scope) ? rule.scope.map(String) : ["dispatch", "merge"],
      gate: String(rule.gate || ""),
      params: rule.params && typeof rule.params === "object" ? rule.params : {},
      message: String(rule.message || "")
    }))
    .filter((rule) => rule.id && rule.gate);

  return {
    schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : defaults.schemaVersion,
    description: typeof parsed.description === "string" ? parsed.description : defaults.description,
    rules
  };
}

/**
 * Evaluate enforcement rules for a given scope against runtime context.
 * Returns an object with overall pass/fail and per-rule results.
 */
export function evaluateEnforcementRules(rules, scope, context) {
  const ruleSet = Array.isArray(rules?.rules) ? rules.rules : [];
  const results = [];
  let passed = true;

  for (const rule of ruleSet) {
    if (!rule.enabled) continue;
    if (!rule.scope.includes(scope)) continue;

    const evaluator = GATE_EVALUATORS[rule.gate];
    const result = evaluator
      ? evaluator(rule, context)
      : { status: "fail", reason: `Unknown gate type: ${rule.gate}` };

    const normalized = {
      id: rule.id,
      gate: rule.gate,
      message: rule.message || rule.id,
      status: result.status,
      reason: result.reason || ""
    };

    results.push(normalized);
    if (normalized.status === "fail") {
      passed = false;
    }
  }

  return {
    scope,
    passed,
    results,
    source: rules?.source || "unknown"
  };
}

/**
 * Format an enforcement result as a human-readable blocker comment. Returns
 * null when the result passed so callers can skip posting.
 */
export function formatEnforcementResult(result) {
  if (result.passed) return null;

  const failures = result.results.filter((r) => r.status === "fail");
  const lines = [
    "DarkFactory enforcement gate failed.",
    "",
    `Scope: \`${result.scope}\``,
    `Rules source: \`${result.source}\``,
    "",
    "Failed rules:",
    "",
    ...failures.map((failure) => `- **${failure.id}**: ${failure.message}${failure.reason ? ` (${failure.reason})` : ""}`),
    "",
    "Resolve the failure before DarkFactory can proceed."
  ];

  return lines.join("\n");
}

const GATE_EVALUATORS = {
  required_checks_pass(rule, context) {
    const rollup = context.statusCheckRollup;
    const requiredContexts = context.requiredContexts || [];

    if (!Array.isArray(rollup) || rollup.length === 0) {
      return requiredContexts.length === 0
        ? { status: "pass", reason: "no checks and no required contexts" }
        : { status: "fail", reason: `required contexts missing: ${requiredContexts.join(", ")}` };
    }

    const allGreen = rollup.every((check) => checkIsGreen(check));
    if (!allGreen) {
      return { status: "fail", reason: "one or more checks are not green" };
    }

    const missing = requiredContexts.filter((context) => !rollup.some((check) => checkContextName(check) === context));
    if (missing.length) {
      return { status: "fail", reason: `required contexts missing: ${missing.join(", ")}` };
    }

    return { status: "pass", reason: "all required checks are green" };
  },

  repo_not_in_set(rule, context) {
    const set = new Set((rule.params?.set || []).map((item) => String(item).toLowerCase()));
    const name = normalizedRepoName(context.repository);
    if (set.has(name)) {
      return { status: "fail", reason: `${repoName(context.repository)} is in the excluded set` };
    }
    return { status: "pass", reason: "repository is not in the excluded set" };
  },

  base_branch_is(rule, context) {
    const expected = String(rule.params?.branch || "");
    const fallback = rule.params?.fallback_to_default === true;
    const actual = context.baseBranch || "";
    const defaultBranch = context.defaultBranch || "";

    if (!expected) {
      return { status: "pass", reason: "no expected branch configured" };
    }

    if (actual === expected) {
      return { status: "pass", reason: `base branch is ${expected}` };
    }

    if (fallback && actual === defaultBranch) {
      return { status: "pass", reason: `base branch falls back to default (${defaultBranch})` };
    }

    return {
      status: "fail",
      reason: `expected base branch ${expected}${fallback ? ` or default (${defaultBranch})` : ""}, got ${actual || "unknown"}`
    };
  },

  policy_assertion(rule, context) {
    return { status: "pass", reason: "policy assertion enforced by DarkFactory runtime" };
  }
};

function checkIsGreen(check) {
  if (check.__typename === "CheckRun") {
    return check.status === "COMPLETED" && check.conclusion === "SUCCESS";
  }
  if (check.__typename === "StatusContext") {
    return check.state === "SUCCESS";
  }
  return false;
}

function checkContextName(check) {
  if (check.__typename === "CheckRun") return check.name || "";
  if (check.__typename === "StatusContext") return check.context || "";
  return "";
}
