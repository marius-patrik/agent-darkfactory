export const HUMAN_CLI_SCHEMA_VERSION = 1 as const;

export type CommandOption = Readonly<{
  name: string;
  value?: string;
  description: string;
}>;

export type CommandSpec = Readonly<{
  id: string;
  path: readonly string[];
  usage: string;
  purpose: string;
  defaults: string;
  model: string;
  permissions: string;
  mutations: string;
  trust: string;
  examples: readonly string[];
  failures: string;
  options: readonly CommandOption[];
  minimumArguments: number;
  maximumArguments: number;
  engine: string;
}>;

const JSON_OPTION = Object.freeze({ name: "--json", description: "Emit the stable schema-versioned JSON envelope." });
const WATCH_OPTION = Object.freeze({ name: "--watch", description: "Wait for the exact dispatched run or plan to reach a terminal state." });
const VERSION_OPTION = Object.freeze({ name: "--version", value: "VERSION", description: "Require the exact observed issue SHA-256 or pull-request BASE_SHA:HEAD_SHA before any model turn or mutation." });

function command(spec: CommandSpec): CommandSpec {
  return Object.freeze({ ...spec, path: Object.freeze([...spec.path]), options: Object.freeze([...spec.options]), examples: Object.freeze([...spec.examples]) });
}

function compactOptions(...options: Array<CommandOption | null>): CommandOption[] {
  return options.filter((option): option is CommandOption => option !== null);
}

export const HUMAN_COMMANDS: readonly CommandSpec[] = Object.freeze([
  command({ id: "serve", path: ["serve"], usage: "df serve", purpose: "Run the DarkFactory GitHub App webhook service.", defaults: "Configured host port; long-running foreground process.", model: "No model is selected by the service command; dispatched model turns use their own authorized profiles.", permissions: "GitHub App credentials and webhook secret from Agent OS-managed secrets.", mutations: "The service may perform only event-specific admitted actions after signature verification.", trust: "Webhook signatures, configured control repository, and scoped installation tokens are mandatory.", examples: ["df serve"], failures: "Missing credentials, invalid configuration, bind failure, or webhook setup error exits non-zero.", options: [], minimumArguments: 0, maximumArguments: 0, engine: "serve" }),
  command({ id: "install-url", path: ["install-url"], usage: "df install-url", purpose: "Print the GitHub App installation URL.", defaults: "Read-only local credential lookup.", model: "Deterministic; zero model tokens.", permissions: "GitHub App authentication only.", mutations: "None.", trust: "The configured App identity is authoritative; secret values are never printed.", examples: ["df install-url"], failures: "Missing or invalid App credentials exits non-zero.", options: [], minimumArguments: 0, maximumArguments: 0, engine: "install-url" }),
  command({ id: "status", path: ["status"], usage: "df status [--json]", purpose: "Show DarkFactory orchestration and backlog status.", defaults: "Control repository; read-only.", model: "Deterministic; zero model tokens.", permissions: "Repository, issues, pull requests, checks, and Actions read.", mutations: "None.", trust: "Only live GitHub state is reported.", examples: ["df status --json"], failures: "Unobservable required state exits non-zero.", options: [JSON_OPTION], minimumArguments: 0, maximumArguments: 0, engine: "status" }),
  command({ id: "doctor", path: ["doctor"], usage: "df doctor [owner/repo | --all] [--json] [--local PATH] [--agents-home PATH] [--write-issues]", purpose: "Diagnose repository, workflow, branch, issue, and local-state drift.", defaults: "Control repository, deterministic read-only diagnosis.", model: "Deterministic; zero model tokens.", permissions: "Read-only target evidence; issue and ledger write only with --write-issues.", mutations: "None by default. --write-issues reconciles stable finding issues after durable admission; it never repairs.", trust: "Live GitHub evidence and explicit local paths are authoritative; missing permissions are not inferred.", examples: ["df doctor", "df doctor marius-patrik/Andromeda --json", "df doctor --all --write-issues"], failures: "Ambiguous target, missing evidence, report admission failure, or partial completion exits non-zero.", options: [JSON_OPTION, { name: "--all", description: "Inspect every active managed repository." }, { name: "--local", value: "PATH", description: "Include one exact local checkout." }, { name: "--agents-home", value: "PATH", description: "Inspect one exact canonical Agent OS root." }, { name: "--write-issues", description: "Reconcile stable doctor finding issues and ledger evidence." }], minimumArguments: 0, maximumArguments: 1, engine: "doctor" }),
  command({ id: "setup", path: ["setup"], usage: "df setup [owner/repo | --all] [--watch] [--json] [--local PATH] [--agents-home PATH]", purpose: "Converge one repository or the managed fleet through the evidence-backed setup engine.", defaults: "Control repository; one bounded observation pass.", model: "Deterministic; zero model tokens.", permissions: "Repository setup PR/workflow and darkfactory-data ledger authority.", mutations: "Executes only the first currently proven dependency stage, then re-observes before further action.", trust: "Doctor evidence, active lifecycle, canonical source, and durable admission are mandatory.", examples: ["df setup marius-patrik/DarkFactory --watch", "df setup marius-patrik/Andromeda --local C:\\work\\Andromeda --agents-home C:\\Users\\patrik\\.agents"], failures: "Stable evidence without progress, unsupported residue, source contradiction, or missing permission stops closed.", options: [WATCH_OPTION, JSON_OPTION, { name: "--all", description: "Converge all active managed repositories." }, { name: "--local", value: "PATH", description: "Include one exact local checkout in setup evidence." }, { name: "--agents-home", value: "PATH", description: "Use one exact canonical Agent OS root for setup evidence." }], minimumArguments: 0, maximumArguments: 1, engine: "setup" }),
  ...(["plan", "apply", "verify"] as const).map((verb) => command({ id: `clean-${verb}`, path: ["clean", verb], usage: `df clean ${verb === "plan" ? "[owner/repo]" : verb === "apply" ? "<plan-id>" : "[owner/repo]"} [--local PATH]${verb === "apply" ? " [--watch]" : ""} [--json]`, purpose: `${verb === "plan" ? "Create" : verb === "apply" ? "Apply" : "Verify"} an evidence-bound repository hygiene plan without discarding work.`, defaults: "Bare df clean resolves to clean plan and makes no mutations.", model: "Deterministic; zero model tokens.", permissions: verb === "apply" ? "Exact local/ref and GitHub branch deletion authority plus ledger write." : "Repository, worktree, refs, PR, issue, and ledger read.", mutations: verb === "apply" ? "Removes only exact clean, merged, preserved candidates from an admitted plan after immediate revalidation." : "None except durable plan or verification receipt.", trust: "Dirty, unique, detached, unmerged, active, ambiguous, or drifted work is preserved and blocks deletion.", examples: [`df clean ${verb}${verb === "apply" ? " plan-id" : " marius-patrik/DarkFactory"}`], failures: "Missing plan, evidence drift, review residue, dirty worktree, or any force/prune request blocks closed.", options: compactOptions({ name: "--local", value: "PATH", description: "Exact local checkout evidence." }, verb === "apply" ? WATCH_OPTION : null, JSON_OPTION), minimumArguments: verb === "apply" ? 1 : 0, maximumArguments: 1, engine: `clean-${verb}` })),
  command({
    id: "repo-init", path: ["repo", "init"], usage: "df repo init <owner/repo> [--json]", purpose: "Run the full evidence-backed setup convergence engine for one exact repository.",
    defaults: "Exact target required; equivalent to df setup <owner/repo> for the same target and JSON mode.", model: "Deterministic; zero model tokens. --tier and --effort are rejected.", permissions: "Repository setup PR/workflow and darkfactory-data ledger authority.",
    mutations: "Executes the same ordered setup stages as df setup, re-observing before every later stage.", trust: "Doctor evidence, active lifecycle, canonical source, and durable admission are mandatory; archived or parked repositories block closed.",
    examples: ["df repo init marius-patrik/example", "df repo init marius-patrik/example --json"], failures: "Ambiguous target, inactive lifecycle, missing App authority, source contradiction, or partial setup evidence exits non-zero.",
    options: [JSON_OPTION], minimumArguments: 1, maximumArguments: 1, engine: "setup"
  }),
  command({
    id: "repo-doctor", path: ["repo", "doctor"], usage: "df repo doctor <owner/repo> [--local PATH] [--json]", purpose: "Run deterministic repository diagnosis without repairs.",
    defaults: "Read-only diagnosis.", model: "Deterministic; zero model tokens.", permissions: "Administration, Actions, checks, contents, issues, pull requests, secrets, and statuses read.",
    mutations: "None.", trust: "Live GitHub evidence and explicitly supplied local checkout evidence are authoritative.", examples: ["df repo doctor marius-patrik/Andromeda --json"],
    failures: "Missing evidence or permission is a finding or a non-zero failure; protection is never inferred.", options: [JSON_OPTION, { name: "--local", value: "PATH", description: "Include one exact local checkout as evidence." }], minimumArguments: 1, maximumArguments: 1, engine: "doctor"
  }),
  command({
    id: "repo-sync", path: ["repo", "sync"], usage: "df repo sync <owner/repo> [--json]", purpose: "Reconcile one repository with the reviewed managed baseline.", defaults: "Exact target required.",
    model: "Deterministic; zero model tokens.", permissions: "Contents and pull requests write for the target repository.", mutations: "May open or update one reviewed managed setup pull request.",
    trust: "Canonical managed source wins; repository-owned paths are never silently overwritten.", examples: ["df repo sync marius-patrik/DarkFactory"], failures: "Duplicate ownership, stale source, missing permissions, or inactive lifecycle blocks before a write.",
    options: [JSON_OPTION], minimumArguments: 1, maximumArguments: 1, engine: "baseline-sync"
  }),
  command({
    id: "repo-status", path: ["repo", "status"], usage: "df repo status <owner/repo> [--json]", purpose: "Show live repository lane, gates, baseline, and active work state.", defaults: "Read-only.",
    model: "Deterministic; zero model tokens.", permissions: "Repository, branch, issue, pull-request, check, and Actions read.", mutations: "None.", trust: "Only current GitHub state and verified receipts are reported.",
    examples: ["df repo status marius-patrik/DarkFactory --json"], failures: "Unobservable required state exits non-zero instead of reporting healthy.", options: [JSON_OPTION], minimumArguments: 1, maximumArguments: 1, engine: "repo-status"
  }),
  command({
    id: "issue-draft", path: ["issue", "draft"], usage: "df issue draft [owner/repo] [--effort low|medium|high] [--input FILE] [--draft FILE] [--approve SHA256] [--json]", purpose: "Gather intent interactively, compose a high-tier local issue draft, run issue Autoreview/autofix, show the final diff, and publish only after exact human approval.",
    defaults: "Control repository; high model tier; policy effort; local reviewed draft only until the exact reviewed digest is approved.", model: "Tier high is fixed by policy; --effort independently selects the supported effort setting.", permissions: "Repository contents read; issue write only after reviewed-digest approval; darkfactory-data ledger write.",
    mutations: "Before approval only the local draft and durable model receipts change. Approval may create exactly one issue bound to the reviewed draft digest.", trust: "Canonical Agent OS launcher, exact control revision, live repository inventory, versioned prompt library, and durable receipts are required. Untrusted intent never grants authority.",
    examples: ["df issue draft marius-patrik/DarkFactory", "df issue draft marius-patrik/DarkFactory --input intent.json --draft draft.json --json", "df issue draft --draft draft.json --approve 8f1c..."],
    failures: "Unavailable Agent OS, malformed output, unresolved owner decisions, stale draft, failed review, receipt failure, or approval mismatch leaves the issue unpublished.",
    options: [JSON_OPTION, { name: "--effort", value: "LEVEL", description: "Select reasoning effort independently of the fixed high model tier." }, { name: "--input", value: "FILE", description: "Read structured owner answers instead of prompting." }, { name: "--draft", value: "FILE", description: "Create or resume one exact local draft-state file." }, { name: "--approve", value: "SHA256", description: "Approve publication of exactly this reviewed draft digest." }],
    minimumArguments: 0, maximumArguments: 1, engine: "issue-draft"
  }),
  ...(["review", "fix"] as const).map((verb) => command({
    id: `issue-${verb}`, path: ["issue", verb], usage: `df issue ${verb} <owner/repo#number> --version SHA256 [--json]`, purpose: `${verb === "review" ? "Run" : "Resume"} the shared bounded issue Autoreview/autofix protocol for one exact issue version.`,
    defaults: "Medium review-to-clean followed by independent high confirmation; policy effort for each tier.", model: "Medium and high tiers are selected by the Autoreview policy; user tier overrides are forbidden.",
    permissions: "Issue read/write and darkfactory-data ledger write for the exact managed target.", mutations: "Bounded autofix may update only the selected issue after immediate version revalidation and preserves owner history.",
    trust: "The same base-trusted Autoreview engine used by Actions runs through canonical Agent OS.", examples: [`df issue ${verb} marius-patrik/DarkFactory#39 --version 0123... --json`],
    failures: "Stale version, route failure, malformed verdict, exhausted rounds, missing receipt, or concurrent edit blocks closed without an overwrite.", options: [VERSION_OPTION, JSON_OPTION], minimumArguments: 1, maximumArguments: 1, engine: "issue-autoreview"
  })),
  command({
    id: "issue-ready", path: ["issue", "ready"], usage: "df issue ready <owner/repo#number> --version SHA256 [--json]", purpose: "Evaluate whether an issue is machine-ready and report the exact predicates and findings.",
    defaults: "Read-only evaluation; never writes df:ready.", model: "Deterministic; zero model tokens.", permissions: "Issue, comments, referenced issues, and repository policy read.", mutations: "None; the evaluator that owns df:ready acts separately.",
    trust: "The selected issue version, clean Autoreview evidence, dependency state, and owner-decision predicates must all agree.", examples: ["df issue ready marius-patrik/DarkFactory#39 --version 0123..."],
    failures: "Stale version or unobservable evidence exits non-zero; a not-ready verdict is returned as evidence, never relabeled.", options: [VERSION_OPTION, JSON_OPTION], minimumArguments: 1, maximumArguments: 1, engine: "issue-ready"
  }),
  command({
    id: "issue-ask", path: ["issue", "ask"], usage: "df issue ask <owner/repo#number> --version SHA256 --message TEXT [--json]", purpose: "Record one exact owner question against the current issue version.",
    defaults: "No inferred target or question.", model: "Deterministic; zero model tokens.", permissions: "Issue comment write and darkfactory-data ledger write.", mutations: "Posts one deduplicated, version-bound owner-question comment; it never guesses or resolves the answer.",
    trust: "Current issue version and exact target are re-fetched before publication.", examples: ["df issue ask marius-patrik/DarkFactory#39 --version 0123... --message \"Choose public or private rollout\""],
    failures: "Missing message, stale version, duplicate ambiguity, or missing permission blocks before a comment.", options: [VERSION_OPTION, { name: "--message", value: "TEXT", description: "Exact owner decision to request." }, JSON_OPTION], minimumArguments: 1, maximumArguments: 1, engine: "issue-ask"
  }),
  ...(["plan", "streams", "dashboard", "work", "resume", "verify"] as const).map((verb) => command({
    id: verb, path: [verb], usage: `df ${verb} <owner/repo${["work", "resume", "verify"].includes(verb) ? "#number" : ""}>${["work", "resume"].includes(verb) ? " --version SHA256" : ""}${["plan", "work", "resume"].includes(verb) ? " [--watch]" : ""} [--json]`,
    purpose: `${verb === "plan" ? "Create or refresh the deterministic execution plan" : verb === "streams" ? "Show dependency-safe work streams" : verb === "dashboard" ? "Show fleet and lane evidence" : `${verb[0].toUpperCase()}${verb.slice(1)} one exact work item through its shared workflow engine`}.`,
    defaults: "Observation is read-only; action verbs require an exact target.", model: verb === "plan" ? "Planning requests high tier with independent policy effort." : "Deterministic orchestration mechanics use zero model tokens; worker turns use their authorized profile.",
    permissions: "Read for observation; exact workflow dispatch and ledger authority for action.", mutations: ["work", "resume", "verify", "plan"].includes(verb) ? "May dispatch the exact shared workflow after current-state admission." : "None.",
    trust: "GitHub state and durable receipts are authoritative; workflows remain least privilege and base trusted.", examples: [`df ${verb} marius-patrik/DarkFactory${["work", "resume", "verify"].includes(verb) ? "#39" : ""} --json`],
    failures: "Ambiguous target, stale receipt, unavailable engine, inactive lifecycle, or failed gate exits non-zero.", options: compactOptions(["work", "resume"].includes(verb) ? VERSION_OPTION : null, ["plan", "work", "resume"].includes(verb) ? WATCH_OPTION : null, JSON_OPTION), minimumArguments: 1, maximumArguments: 1, engine: verb
  })),
  ...(["review", "fix", "status", "merge"] as const).map((verb) => command({
    id: `pr-${verb}`, path: ["pr", verb], usage: `df pr ${verb} <owner/repo#number>${verb === "status" ? "" : " --version BASE_SHA:HEAD_SHA"} [--json]`,
    purpose: `${verb === "review" ? "Run the shared PR Autoreview protocol" : verb === "fix" ? "Resume bounded Autoreview autofix" : verb === "status" ? "Show exact PR gates, findings, and receipts" : "Request normal protected merge only after every current gate is green"}.`,
    defaults: verb === "status" ? "Read-only." : "Exact target; no target guessing or force operation.", model: ["review", "fix"].includes(verb) ? "Medium review-to-clean plus independent high confirmation." : "Deterministic; zero model tokens.",
    permissions: verb === "status" ? "Pull request, checks, reviews, and receipts read." : "Least-privilege PR/workflow authority for the exact target.", mutations: verb === "status" ? "None." : "May dispatch review/fix or arm normal auto-merge; never force-pushes, changes base, or bypasses gates.",
    trust: "Same-repository head, exact base/head version, App-bound checks, and current protected-branch policy are revalidated.", examples: [`df pr ${verb} marius-patrik/DarkFactory#270${verb === "status" ? "" : " --version base-sha:head-sha"}`],
    failures: "Stale target, wrong-App check, red/missing gate, protected head, provider failure, or permission gap blocks closed.", options: compactOptions(verb === "status" ? null : VERSION_OPTION, JSON_OPTION), minimumArguments: 1, maximumArguments: 1, engine: `pr-${verb}`
  })),
  ...(["status", "plan", "reconcile", "run", "verify"] as const).map((verb) => command({
    id: `release-${verb}`, path: ["release", verb], usage: `df release ${verb} [owner/repo] [--watch] [--json]`,
    purpose: `${verb === "status" ? "Observe" : verb === "plan" ? "Plan" : verb === "reconcile" ? "Reconcile" : verb === "run" ? "Run" : "Verify"} protected dev/main release convergence through the #41 engine.`,
    defaults: "Control repository; bare df release resolves to status and never starts or resumes a release.", model: "Deterministic mechanics use zero model tokens; semantic conflicts escalate instead of guessing.",
    permissions: ["status", "plan"].includes(verb) ? "Repository, refs, checks, PRs, releases, and receipts read." : "Exact release workflow/ref/PR write authority after admission.", mutations: ["status", "plan", "verify"].includes(verb) ? "None except verify may append a verification receipt." : "May create reviewed release/reconcile branches and PRs; never writes protected branches directly.",
    trust: "The single #41 engine owns state classification, exact plan IDs, green gates, and completion receipts.", examples: [`df release ${verb} marius-patrik/DarkFactory --json`],
    failures: "Divergence ambiguity, stale plan, red/missing gate, wrong App, or incomplete publication blocks closed.", options: compactOptions(verb === "run" ? WATCH_OPTION : null, JSON_OPTION), minimumArguments: 0, maximumArguments: 1, engine: `release-${verb}`
  })),
  ...(["status", "update", "verify"] as const).map((verb) => command({
    id: `submodules-${verb}`, path: ["submodules", verb], usage: `df submodules ${verb} [owner/repo] [--watch] [--json]`, purpose: `${verb === "status" ? "Observe" : verb === "update" ? "Apply" : "Verify"} released child-pointer convergence through the #43 engine.`,
    defaults: "Control root; status and verify are read-only.", model: "Deterministic; zero model tokens unless an explicit semantic conflict is escalated.", permissions: verb === "update" ? "Exact pointer branch/PR and ledger authority." : "Repositories, releases, trees, PRs, and receipts read.",
    mutations: verb === "update" ? "May open reviewed pointer-update PRs for released child SHAs only." : "None except a verification receipt.", trust: "Verified child release receipts and exact gitlink SHAs are authoritative; nested target code never executes.",
    examples: [`df submodules ${verb} marius-patrik/Andromeda --json`], failures: "Unreleased child, stale parent, recursive cycle, parked scope, or incomplete receipt blocks closed.", options: [WATCH_OPTION, JSON_OPTION], minimumArguments: 0, maximumArguments: 1, engine: `submodules-${verb}`
  })),
  ...(["status", "sync", "verify"] as const).map((verb) => command({
    id: `baseline-${verb}`, path: ["baseline", verb], usage: `df baseline ${verb} [owner/repo] [--json]`, purpose: `${verb === "status" ? "Show" : verb === "sync" ? "Reconcile" : "Verify"} managed-baseline drift only.`, defaults: "Control repository for status/verify; sync requires an exact repository.",
    model: "Deterministic; zero model tokens.", permissions: verb === "sync" ? "Contents and pull requests write for one target." : "Managed files, repository tree, and policy read.", mutations: verb === "sync" ? "May open or update one managed setup PR." : "None.",
    trust: "Canonical managed source and path-level ownership are authoritative; duplicate ownership fails closed.", examples: [`df baseline ${verb} marius-patrik/DarkFactory`], failures: "Missing source, duplicate payload, stale target, or inactive lifecycle blocks closed.", options: [JSON_OPTION], minimumArguments: verb === "sync" ? 1 : 0, maximumArguments: 1, engine: `baseline-${verb}`
  })),
  command({ id: "explain", path: ["explain"], usage: "df explain <repo|issue|pr|run|release> <exact-target> [--json]", purpose: "Show the exact predicates, gates, receipts, and findings preventing progress.", defaults: "Read-only; df why is an alias.", model: "Deterministic; zero model tokens.", permissions: "Target state and receipt read.", mutations: "None.", trust: "Only current evidence is explained; no speculative cause is presented as fact.", examples: ["df explain issue marius-patrik/DarkFactory#39", "df why release marius-patrik/DarkFactory"], failures: "Unknown kind, ambiguous target, or unobservable predicate exits non-zero.", options: [JSON_OPTION], minimumArguments: 2, maximumArguments: 2, engine: "explain" }),
  ...(["list", "show", "watch", "retry"] as const).map((verb) => command({ id: `runs-${verb}`, path: ["runs", verb], usage: `df runs ${verb} <owner/repo${verb === "list" ? "" : "#run-id"}>${verb === "retry" ? " --approve RUN_ID" : ""} [--json]`, purpose: `${verb === "list" ? "List" : verb === "show" ? "Show" : verb === "watch" ? "Watch" : "Retry"} exact GitHub workflow runs and linked receipts.`, defaults: "Read-only except retry; no latest-run guessing for mutations.", model: "Deterministic; zero model tokens.", permissions: verb === "retry" ? "Actions write for one failed run." : "Actions and receipts read.", mutations: verb === "retry" ? "May rerun one exact failed run after head/control revalidation." : "None.", trust: "Run ID, workflow, head SHA, event, and current target must agree.", examples: [`df runs ${verb} marius-patrik/DarkFactory${verb === "list" ? "" : "#29426342655"}`], failures: "Ambiguous run, stale head, successful/in-progress retry target, or missing permission blocks closed.", options: compactOptions(verb === "retry" ? { name: "--approve", value: "RUN_ID", description: "Authorize retry of exactly this current run." } : null, JSON_OPTION), minimumArguments: 1, maximumArguments: 1, engine: `runs-${verb}` })),
  ...(["list", "show", "verify"] as const).map((verb) => command({ id: `receipts-${verb}`, path: ["receipts", verb], usage: `df receipts ${verb} <owner/repo${verb === "list" ? "" : "#receipt"}> [--json]`, purpose: `${verb === "list" ? "List" : verb === "show" ? "Show" : "Verify"} durable DarkFactory action receipts.`, defaults: "Read-only.", model: "Deterministic; zero model tokens.", permissions: "darkfactory-data contents read.", mutations: "None.", trust: "Receipt schema, immutable target refs, authorizing intent, actor, gates, outcome, and downstream handoff are verified.", examples: [`df receipts ${verb} marius-patrik/DarkFactory${verb === "list" ? "" : "#receipt-id"}`], failures: "Missing, malformed, mismatched, or unverifiable receipt exits non-zero.", options: [JSON_OPTION], minimumArguments: 1, maximumArguments: 1, engine: `receipts-${verb}` })),
  ...(["pause", "resume"] as const).map((verb) => command({ id: `lane-${verb}`, path: ["lane", verb], usage: `df lane ${verb} <owner/repo#number> --version SHA256 --approve SHA256 [--json]`, purpose: `${verb === "pause" ? "Set" : "Release"} the explicit owner brake for one exact issue lane.`, defaults: "No inferred target; resume requests re-evaluation and never writes df:ready directly.", model: "Deterministic; zero model tokens.", permissions: "Issue comment/label and durable ledger write.", mutations: verb === "pause" ? "Records an owner brake and blocks new dispatch for the exact lane." : "Records brake release and requests evaluator re-observation without force-applying readiness.", trust: "Exact issue version, owner authorization, and current lane receipt are revalidated.", examples: [`df lane ${verb} marius-patrik/DarkFactory#39 --version 0123... --approve 0123...`], failures: "Version/approval mismatch, absent brake, active mutation, or missing owner authority blocks closed.", options: [VERSION_OPTION, { name: "--approve", value: "SHA256", description: "Authorize the exact current lane version." }, JSON_OPTION], minimumArguments: 1, maximumArguments: 1, engine: `lane-${verb}` })),
  command({ id: "runners-status", path: ["runners", "status"], usage: "df runners status [owner/repo] [--json]", purpose: "Show canonical runner registration, labels, busy state, and recent health evidence.", defaults: "Control repository; read-only.", model: "Deterministic; zero model tokens.", permissions: "Actions runner and workflow read.", mutations: "None.", trust: "Live GitHub runner state and Agent OS-owned lifecycle receipts are authoritative.", examples: ["df runners status marius-patrik/DarkFactory"], failures: "Unobservable runner authority exits non-zero instead of assuming healthy.", options: [JSON_OPTION], minimumArguments: 0, maximumArguments: 1, engine: "runners-status" }),
  command({ id: "logs", path: ["logs"], usage: "df logs <owner/repo#run-id> [--json]", purpose: "Locate sanitized logs and evidence for one exact run.", defaults: "Read-only; no latest-run guessing.", model: "Deterministic; zero model tokens.", permissions: "Actions and receipt read.", mutations: "None.", trust: "Secrets and machine-local paths are redacted at their source; the CLI never prints tokens.", examples: ["df logs marius-patrik/DarkFactory#29426342655"], failures: "Unknown run, unavailable logs, or provenance mismatch exits non-zero.", options: [JSON_OPTION], minimumArguments: 1, maximumArguments: 1, engine: "logs" })
]);

const COMMAND_BY_ID = new Map(HUMAN_COMMANDS.map((entry) => [entry.id, entry]));

export type ParsedHumanCommand = Readonly<{
  spec: CommandSpec;
  arguments: readonly string[];
  options: Readonly<Record<string, string | boolean>>;
  help: boolean;
}>;

function normalizeInvocation(raw: readonly string[]): string[] {
  const args = [...raw];
  if (args[0] === "why") args[0] = "explain";
  if (args[0] === "release" && (args.length === 1 || args[1]?.startsWith("-"))) args.splice(1, 0, "status");
  if (args[0] === "clean" && (args.length === 1 || args[1]?.startsWith("-"))) args.splice(1, 0, "plan");
  if (args[0] === "sync-managed") return ["baseline", "sync", ...args.slice(1)];
  return args;
}

function findSpec(args: readonly string[]): CommandSpec | null {
  return [...HUMAN_COMMANDS]
    .sort((left, right) => right.path.length - left.path.length)
    .find((entry) => entry.path.every((part, index) => args[index] === part)) ?? null;
}

export function humanCommandId(raw: readonly string[]): string | null {
  return findSpec(normalizeInvocation(raw))?.id ?? null;
}

export function parseHumanCliArgs(raw: readonly string[]): ParsedHumanCommand | null {
  const args = normalizeInvocation(raw);
  const spec = findSpec(args);
  if (!spec) return null;
  const tail = args.slice(spec.path.length);
  const positional: string[] = [];
  const options: Record<string, string | boolean> = {};
  const allowed = new Map(spec.options.map((option) => [option.name, option]));
  allowed.set("--help", { name: "--help", description: "Show this command help." });
  allowed.set("-h", { name: "-h", description: "Show this command help." });

  for (let index = 0; index < tail.length; index += 1) {
    const value = tail[index];
    if (!value.startsWith("-")) {
      positional.push(value);
      continue;
    }
    if (value === "--tier") throw new Error(`${spec.path.join(" ")} does not accept --tier; model tier is fixed by policy`);
    const option = allowed.get(value);
    if (!option) throw new Error(`unknown ${spec.path.join(" ")} option: ${value}`);
    if (Object.hasOwn(options, option.name)) throw new Error(`duplicate ${spec.path.join(" ")} option: ${option.name}`);
    if (option.value) {
      const next = tail[index + 1];
      if (!next || next.startsWith("-")) throw new Error(`${option.name} requires ${option.value}`);
      options[option.name] = next;
      index += 1;
    } else {
      options[option.name] = true;
    }
  }

  const help = options["--help"] === true || options["-h"] === true;
  if (!help && (positional.length < spec.minimumArguments || positional.length > spec.maximumArguments)) {
    throw new Error(`usage: ${spec.usage}`);
  }
  if (!help && (spec.id === "issue-review" || spec.id === "issue-fix" || spec.id === "issue-ready") && typeof options["--version"] !== "string") {
    throw new Error(`${spec.path.join(" ")} requires --version for stale-target admission`);
  }
  if (!help && (spec.id === "work" || spec.id === "resume") && typeof options["--version"] !== "string") {
    throw new Error(`${spec.path.join(" ")} requires --version for stale-target admission`);
  }
  if (!help && ["pr-review", "pr-fix", "pr-merge"].includes(spec.id) && typeof options["--version"] !== "string") {
    throw new Error(`${spec.path.join(" ")} requires --version for stale-target admission`);
  }
  if (!help && spec.id === "issue-ask") {
    if (typeof options["--version"] !== "string" || typeof options["--message"] !== "string") throw new Error("issue ask requires --version and --message");
  }
  if (!help && spec.id.startsWith("lane-") && (typeof options["--version"] !== "string" || options["--approve"] !== options["--version"])) {
    throw new Error(`${spec.path.join(" ")} requires matching --version and --approve values`);
  }
  if (!help && spec.id === "runs-retry" && typeof options["--approve"] !== "string") {
    throw new Error(`${spec.path.join(" ")} requires an exact --approve value`);
  }
  return Object.freeze({ spec, arguments: Object.freeze(positional), options: Object.freeze(options), help });
}

export function commandSpec(id: string): CommandSpec {
  const spec = COMMAND_BY_ID.get(id);
  if (!spec) throw new Error(`unknown command specification: ${id}`);
  return spec;
}

export function formatCommandHelp(spec: CommandSpec): string {
  const options = spec.options.length === 0
    ? "  (none)"
    : spec.options.map((option) => `  ${option.name}${option.value ? ` ${option.value}` : ""}\n      ${option.description}`).join("\n");
  return [
    spec.purpose,
    "",
    "Usage:",
    `  ${spec.usage}`,
    "",
    "Defaults:",
    `  ${spec.defaults}`,
    "",
    "Model tier vs effort:",
    `  ${spec.model}`,
    "",
    "Permissions:",
    `  ${spec.permissions}`,
    "",
    "Mutations:",
    `  ${spec.mutations}`,
    "",
    "Trust boundaries:",
    `  ${spec.trust}`,
    "",
    "Options:",
    options,
    "",
    "Examples:",
    ...spec.examples.map((example) => `  ${example}`),
    "",
    "Failure and exit semantics:",
    `  ${spec.failures}`,
    "  Exit 0 means the requested observation or admitted action completed. Any blocked, stale, malformed, unavailable, or partial result exits non-zero."
  ].join("\n");
}

export function formatRootHelp(): string {
  const families = [
    ["Repository", "repo init|doctor|sync|status; baseline status|sync|verify; doctor; setup; clean"],
    ["Issues", "issue draft|review|fix|ready|ask; lane pause|resume"],
    ["Planning", "plan; streams; dashboard; explain (why)"],
    ["Work", "work; resume; verify; pr review|fix|status|merge"],
    ["Release", "release status|plan|reconcile|run|verify; submodules status|update|verify"],
    ["Evidence", "runs list|show|watch|retry; receipts list|show|verify; runners status; logs"]
  ];
  return [
    "df - DarkFactory human development surface",
    "",
    "Usage:",
    "  df <command> [arguments] [options]",
    "  df help <command> [subcommand]",
    "",
    "Command families:",
    ...families.map(([name, value]) => `  ${name.padEnd(12)} ${value}`),
    "",
    "Safe defaults:",
    "  df doctor is read-only unless --write-issues is explicit.",
    "  df clean means clean plan; only clean apply <plan-id> mutates.",
    "  df release means release status and never starts or resumes a release.",
    "  Deterministic commands reject --tier and --effort; model-backed commands expose only authorized effort selection.",
    "  There is no --force, generic prune, target-guessing review, or bypass command.",
    "",
    "Run df help <command> for purpose, arguments, defaults, model/effort, permissions, mutations, trust boundaries, examples, and exit semantics."
  ].join("\n");
}

export type HumanJsonResult = Readonly<{
  schemaVersion: 1;
  command: string;
  status: "ok" | "blocked" | "error";
  data: unknown;
  error: Readonly<{ code: string; message: string }> | null;
}>;

export function humanJsonResult(
  commandId: string,
  status: HumanJsonResult["status"],
  data: unknown,
  error: HumanJsonResult["error"] = null
): HumanJsonResult {
  if (commandId !== "unknown") commandSpec(commandId);
  return Object.freeze({ schemaVersion: HUMAN_CLI_SCHEMA_VERSION, command: commandId, status, data, error });
}
