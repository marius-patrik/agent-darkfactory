import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCreatePlan,
  checkPathSharing,
  configuredProfiles,
  containerEnv,
  containerMounts,
  defaultContainerName,
  dockerCreateArgs,
  isPortAvailable,
  preflightProfile,
  preflightProfiles,
  resolveImageRef,
  resetDockerRunner,
  toPosixPath,
} from "../src/os-lifecycle";
import { readDataRepos, upsertDataRepo } from "../src/data-repos";
import { ensureSharedState, sharedState, systemDataPath } from "../src/state";
import { writeSecret } from "../src/secrets";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("ANDROMEDA_")) delete copy[key];
  }
  return copy;
}

async function fakeDocker(root: string): Promise<{ dir: string; log: string; env: Record<string, string | undefined> }> {
  const dir = path.join(root, "bin");
  const log = path.join(root, "docker-calls.log");
  await mkdir(dir, { recursive: true });
  const script = path.join(dir, process.platform === "win32" ? "docker.ps1" : "docker");
  if (process.platform === "win32") {
    await Bun.write(script, `Add-Content -LiteralPath '${log.replaceAll("'", "''")}' -Value ($args -join ' ')\n`);
  } else {
    await Bun.write(script, `#!/bin/sh\necho "$*" >> "${log}"\n`);
    await Bun.$`chmod +x ${script}`;
  }
  return {
    dir,
    log,
    env: {
      PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}`,
      ANDROMEDA_DOCKER_BIN: script,
    },
  };
}

async function runAgents(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: { ...cleanEnv(), ANDROMEDA_HOME: path.join(cwd, ".andromeda"), ANDROMEDA_ROOT: cwd, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("os lifecycle pure helpers", () => {
  test("toPosixPath normalizes Windows paths", () => {
    expect(toPosixPath("C:\\Users\\foo\\bar")).toBe("/c/Users/foo/bar");
    expect(toPosixPath("D:/data/andromeda")).toBe("/d/data/andromeda");
    expect(toPosixPath("/agents/state")).toBe("/agents/state");
    expect(toPosixPath("\\\\server\\share")).toBe("//server/share");
  });

  test("containerEnv exports required variables", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-env-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const env = containerEnv(await readDataRepos(state));
      expect(env.ANDROMEDA_ROOT).toBe("/opt/andromeda-os");
      expect(env.ANDROMEDA_HOME).toBe("/agents/state");
      expect(env.ANDROMEDA_DATA).toBeUndefined();
      expect(env.ANDROMEDA_WORKSPACE).toBe("/workspace/agents");
      expect(env.ANDROMEDA_SYSTEM_DATA_ROOT).toBe("/agents/state");
      expect(env.ANDROMEDA_CREDITS).toBe("/agents/state/credits.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("containerMounts include state, data, workspace and registered repos", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-mounts-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await upsertDataRepo(state, {
        id: "project-data",
        repo: "marius-patrik/project-data",
        path: path.join(root, "data", "project"),
        branch: "main",
        env: "PROJECT_DATA_ROOT",
      });
      const dataRepos = await readDataRepos(state);
      const mounts = await containerMounts(state, dataRepos);
      expect(mounts.find((m) => m.container === "/agents/state")?.host).toBe(toPosixPath(state.stateDir));
      expect(mounts.find((m) => m.container === "/agents/state")?.mode).toBe("ro");
      expect(mounts.filter((m) => m.container === "/agents/state")).toHaveLength(1);
      expect(containerEnv(dataRepos).ANDROMEDA_SYSTEM_DATA_ROOT).toBe("/agents/state");
      expect(mounts.find((m) => m.container === "/workspace/agents")?.host).toBe(toPosixPath(state.workspaceDir));
      expect(mounts.find((m) => m.container === "/agents/data/project-data")?.host).toBe(
        toPosixPath(path.join(root, "data", "project")),
      );
      const secretsMount = mounts.find((m) => m.container === "/agents/state/secrets");
      expect(secretsMount).toBeDefined();
      expect(secretsMount?.host).not.toBe(toPosixPath(state.secretsDir));
      expect(secretsMount?.mode).toBe("ro");
      expect(mounts.some((m) => m.container === "/agents/state/credits.json" && m.mode === "rw")).toBe(true);
      expect(mounts.some((m) => m.container === "/agents/state/packages.json" && m.mode === "rw")).toBe(true);

      const withSecrets = await containerMounts(state, dataRepos, { includeSecrets: true });
      expect(withSecrets.find((m) => m.container === "/agents/state")?.mode).toBe("ro");
      expect(withSecrets.find((m) => m.container === "/agents/state/secrets")?.host).toBe(toPosixPath(state.secretsDir));

      const trustedMounts = await containerMounts(state, dataRepos, { trusted: true });
      expect(trustedMounts.find((m) => m.container === "/agents/state")?.mode).toBe("rw");
      expect(trustedMounts.find((m) => m.container === "/agents/state/secrets")?.host).toBe(toPosixPath(state.secretsDir));
      expect(trustedMounts.find((m) => m.container === "/agents/state/secrets")?.mode).toBe("rw");
      expect(trustedMounts.some((m) => m.container === "/agents/state/credits.json")).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("dockerCreateArgs includes labels, env, mounts and ports", () => {
    const args = dockerCreateArgs({
      name: "andromeda-os-dev",
      image: "andromeda-os:dev",
      environment: "dev",
      channel: "dev",
      hostRoot: "/home/user/Projects/agents-manager",
      mounts: [
        { host: "/home/user/.andromeda", container: "/agents/state", mode: "rw" },
      ],
      env: { ANDROMEDA_HOME: "/agents/state" },
      ports: [{ name: "http", container: 8080, host: 8080 }],
      network: "andromeda-os",
      restart: "no",
    });
    expect(args).toContain("--name");
    expect(args).toContain("andromeda-os-dev");
    expect(args).toContain("andromeda-os:dev");
    expect(args).toContain("io.andromeda.os.managed=true");
    expect(args).toContain("io.andromeda.os.environment=dev");
    expect(args).toContain("-e");
    expect(args).toContain("ANDROMEDA_HOME=/agents/state");
    expect(args).toContain("-v");
    expect(args).toContain("/home/user/.andromeda:/agents/state:rw");
    expect(args).toContain("-p");
    expect(args).toContain("8080:8080");
    expect(args).toContain("--network");
    expect(args).toContain("andromeda-os");
  });

  test("buildCreatePlan produces a reproducible docker create plan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-plan-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const plan = await buildCreatePlan(state, {
        name: "andromeda-os-dev",
        image: "andromeda-os:dev",
        environment: "dev",
      });
      expect(plan.command).toBe("docker");
      expect(plan.description).toContain("andromeda-os-dev");
      expect(plan.args).toContain("container");
      expect(plan.args).toContain("create");
      expect(plan.args.some((a) => a.includes("/agents/state"))).toBe(true);
      expect(plan.args.some((a) => a.includes("ANDROMEDA_ROOT=/opt/andromeda-os"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("defaultContainerName uses environment", () => {
    expect(defaultContainerName("andromeda-os")).toBe("andromeda-os-andromeda-os");
    expect(defaultContainerName("dev")).toBe("andromeda-os-dev");
  });

  test("resolveImageRef appends channel only when reference is untagged", () => {
    expect(resolveImageRef("andromeda-os", "dev")).toBe("andromeda-os:dev");
    expect(resolveImageRef("andromeda-os", "latest")).toBe("andromeda-os:latest");
    expect(resolveImageRef("ubuntu:22.04", "dev")).toBe("ubuntu:22.04");
    expect(resolveImageRef("repo/image@sha256:abc123", "dev")).toBe("repo/image@sha256:abc123");
    expect(resolveImageRef("my.registry.io/andromeda-os", "stable")).toBe("my.registry.io/andromeda-os:stable");
    expect(resolveImageRef("localhost:5000/andromeda-os", "dev")).toBe("localhost:5000/andromeda-os:dev");
  });
});

describe("andromeda os CLI", () => {
  test("doctor passes when docker and prerequisites are present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-doctor-ok-"));
    try {
      const { env } = await fakeDocker(root);
      const dockerfile = path.join(root, "os", "andromeda-os", "Dockerfile");
      await mkdir(path.dirname(dockerfile), { recursive: true });
      await Bun.write(dockerfile, "FROM scratch\n");
      await mkdir(path.join(root, "data", "agent-os"), { recursive: true });
      const build = await runAgents(root, ["os", "image", "build", "--image", "andromeda-os"], env);
      if (build.code !== 0) throw new Error(build.stderr);
      expect(build.code).toBe(0);
      const doctor = await runAgents(root, ["os", "doctor"], env);
      expect(doctor.code).toBe(0);
      expect(doctor.stdout).toContain("ok docker");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor warns on missing prerequisites", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-doctor-warn-"));
    try {
      const { env } = await fakeDocker(root);
      const doctor = await runAgents(root, ["os", "doctor"], env);
      expect(doctor.code).toBe(1);
      expect(doctor.stderr).toContain("no OS images configured");
      expect(doctor.stderr).toContain("no OS images configured");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("image build --dry-run prints plan without recording image", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-image-build-dry-"));
    try {
      const result = await runAgents(root, ["os", "image", "build", "--image", "andromeda-os", "--channel", "dev", "--dry-run"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker image build");
      expect(result.stdout).toContain("andromeda-os:dev");
      const list = await runAgents(root, ["os", "image", "list", "--json"]);
      expect(list.code).toBe(0);
      const images = JSON.parse(list.stdout) as Array<{ id: string; image: string; tags: string[] }>;
      expect(images).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("image build records image after successful docker build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-image-build-"));
    try {
      const { env } = await fakeDocker(root);
      const dockerfile = path.join(root, "os", "andromeda-os", "Dockerfile");
      await mkdir(path.dirname(dockerfile), { recursive: true });
      await Bun.write(dockerfile, "FROM scratch\n");
      const result = await runAgents(root, ["os", "image", "build", "--image", "andromeda-os", "--channel", "dev"], env);
      expect(result.code).toBe(0);
      const list = await runAgents(root, ["os", "image", "list", "--json"]);
      expect(list.code).toBe(0);
      const images = JSON.parse(list.stdout) as Array<{ id: string; image: string; tags: string[] }>;
      expect(images).toHaveLength(1);
      expect(images[0].id).toBe("andromeda-os");
      expect(images[0].tags).toContain("dev");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("image build preserves explicit tag and does not append channel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-image-build-tagged-"));
    try {
      const result = await runAgents(root, ["os", "image", "build", "--image", "ubuntu:22.04", "--channel", "dev", "--dry-run"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("ubuntu:22.04");
      expect(result.stdout).not.toContain("ubuntu:dev");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("create --dry-run prints plan with normalized paths", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-create-"));
    try {
      const result = await runAgents(root, [
        "os",
        "create",
        "--name",
        "andromeda-os-dev",
        "--image",
        "andromeda-os",
        "--env",
        "dev",
        "--dry-run",
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker container create");
      expect(result.stdout).toContain("andromeda-os-dev");
      expect(result.stdout).toContain(toPosixPath(path.join(root, ".andromeda")));
      expect(result.stdout).toContain("ANDROMEDA_ROOT=/opt/andromeda-os");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("create masks secrets by default and mounts them with --with-secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-create-secrets-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const defaultRun = await runAgents(root, [
        "os",
        "create",
        "--name",
        "andromeda-os-dev",
        "--image",
        "andromeda-os",
        "--env",
        "dev",
        "--dry-run",
      ]);
      expect(defaultRun.code).toBe(0);
      expect(defaultRun.stdout).toContain(`${toPosixPath(state.stateDir)}:/agents/state:ro`);
      expect(defaultRun.stdout).toContain("/agents/state/secrets:ro");
      expect(defaultRun.stdout).not.toContain(`${toPosixPath(state.secretsDir)}:/agents/state/secrets`);

      const withSecretsRun = await runAgents(root, [
        "os",
        "create",
        "--name",
        "andromeda-os-dev",
        "--image",
        "andromeda-os",
        "--env",
        "dev",
        "--with-secrets",
        "--dry-run",
      ]);
      expect(withSecretsRun.code).toBe(0);
      expect(withSecretsRun.stdout).toContain(`${toPosixPath(state.stateDir)}:/agents/state:ro`);
      expect(withSecretsRun.stdout).toContain(`${toPosixPath(state.secretsDir)}:/agents/state/secrets:ro`);

      const trustedRun = await runAgents(root, [
        "os",
        "create",
        "--name",
        "andromeda-os-dev",
        "--image",
        "andromeda-os",
        "--env",
        "dev",
        "--trusted",
        "--dry-run",
      ]);
      expect(trustedRun.code).toBe(0);
      expect(trustedRun.stdout).toContain(`${toPosixPath(state.stateDir)}:/agents/state:rw`);
      expect(trustedRun.stdout).toContain(`${toPosixPath(state.secretsDir)}:/agents/state/secrets:rw`);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("create records container after successful docker create", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-create-record-"));
    try {
      const { env } = await fakeDocker(root);
      const create = await runAgents(root, ["os", "create", "--name", "andromeda-os-dev", "--image", "andromeda-os", "--env", "dev"], env);
      expect(create.code).toBe(0);
      const status = await runAgents(root, ["os", "status", "andromeda-os-dev", "--json"]);
      expect(status.code).toBe(0);
      const container = JSON.parse(status.stdout) as { name: string; status: string };
      expect(container.name).toBe("andromeda-os-dev");
      expect(container.status).toBe("created");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remove deletes container record after successful docker rm", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-remove-record-"));
    try {
      const { env } = await fakeDocker(root);
      await runAgents(root, ["os", "create", "--name", "andromeda-os-dev", "--image", "andromeda-os", "--env", "dev"], env);
      const remove = await runAgents(root, ["os", "remove", "andromeda-os-dev"], env);
      expect(remove.code).toBe(0);
      const status = await runAgents(root, ["os", "status", "andromeda-os-dev", "--json"]);
      expect(status.code).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failed docker create does not record container", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-create-fail-"));
    try {
      const { dir, env } = await fakeDocker(root);
      const failing = path.join(dir, process.platform === "win32" ? "docker.ps1" : "docker");
      if (process.platform === "win32") {
        await Bun.write(
          failing,
          `Add-Content -LiteralPath '${path.join(root, "docker-calls.log").replaceAll("'", "''")}' -Value ($args -join ' ')\nif (($args -join ' ') -like '*container create*') { exit 1 }\n`,
        );
      } else {
        await Bun.write(
          failing,
          `#!/bin/sh\necho "$*" >> "${path.join(root, "docker-calls.log")}"\nif echo "$*" | grep -q "container create"; then exit 1; fi\n`,
        );
        await Bun.$`chmod +x ${failing}`;
      }
      const create = await runAgents(root, ["os", "create", "--name", "andromeda-os-dev", "--image", "andromeda-os"], env);
      expect(create.code).toBe(1);
      const status = await runAgents(root, ["os", "status", "andromeda-os-dev", "--json"]);
      expect(status.code).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("logs --dry-run prints plan without invoking docker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-logs-dry-"));
    try {
      const result = await runAgents(root, ["os", "logs", "andromeda-os-dev", "--dry-run"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker container logs andromeda-os-dev");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remove --dry-run excludes data prune by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-remove-"));
    try {
      await runAgents(root, ["os", "create", "--name", "andromeda-os-dev", "--image", "andromeda-os", "--dry-run"]);
      const result = await runAgents(root, ["os", "remove", "andromeda-os-dev", "--dry-run"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker container rm andromeda-os-dev");
      expect(result.stdout).not.toContain("rm -rf");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remove --prune-data --dry-run includes prune steps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-remove-prune-"));
    try {
      await runAgents(root, ["os", "create", "--name", "andromeda-os-dev", "--image", "andromeda-os", "--dry-run"]);
      const result = await runAgents(root, ["os", "remove", "andromeda-os-dev", "--prune-data", "--dry-run"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker container rm andromeda-os-dev");
      expect(result.stdout).toContain("rm -rf");
      expect(result.stdout).toContain("/agents/state/containers/andromeda-os-dev");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deploy --dry-run prints create and start with profile ports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-deploy-"));
    try {
      const result = await runAgents(root, ["os", "deploy", "agent-os-gateway", "--dry-run"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker container create");
      expect(result.stdout).toContain("docker container start");
      expect(result.stdout).toContain("-p");
      expect(result.stdout).toContain("8787:8787");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deploy unknown profile errors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-deploy-unknown-"));
    try {
      const result = await runAgents(root, ["os", "deploy", "unknown-profile", "--dry-run"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("unknown profile");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deploy records running container after successful docker create/start", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-deploy-record-"));
    try {
      const { env } = await fakeDocker(root);
      const deploy = await runAgents(root, ["os", "deploy", "agent-os-gateway", "--name", "andromeda-os-deploy", "--env", "dev"], env);
      expect(deploy.code).toBe(0);
      const status = await runAgents(root, ["os", "status", "andromeda-os-deploy", "--json"]);
      expect(status.code).toBe(0);
      const container = JSON.parse(status.stdout) as { name: string; status: string; profiles: string[] };
      expect(container.name).toBe("andromeda-os-deploy");
      expect(container.status).toBe("running");
      expect(container.profiles).toContain("agent-os-gateway");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failed deploy does not overwrite existing container record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-deploy-fail-"));
    try {
      const { env, dir } = await fakeDocker(root);
      await runAgents(root, ["os", "create", "--name", "andromeda-os-deploy", "--image", "andromeda-os", "--env", "dev"], env);
      await runAgents(root, ["os", "start", "andromeda-os-deploy"], env);
      const before = await runAgents(root, ["os", "status", "andromeda-os-deploy", "--json"]);
      expect(before.code).toBe(0);

      const failing = path.join(dir, process.platform === "win32" ? "docker.ps1" : "docker");
      if (process.platform === "win32") {
        await Bun.write(
          failing,
          `Add-Content -LiteralPath '${path.join(root, "docker-calls.log").replaceAll("'", "''")}' -Value ($args -join ' ')\nif (($args -join ' ') -like '*container create*') { exit 1 }\n`,
        );
      } else {
        await Bun.write(
          failing,
          `#!/bin/sh\necho "$*" >> "${path.join(root, "docker-calls.log")}"\nif echo "$*" | grep -q "container create"; then exit 1; fi\n`,
        );
        await Bun.$`chmod +x ${failing}`;
      }

      const deploy = await runAgents(root, ["os", "deploy", "agent-os-gateway", "--name", "andromeda-os-deploy", "--env", "dev"], env);
      expect(deploy.code).toBe(1);
      const after = await runAgents(root, ["os", "status", "andromeda-os-deploy", "--json"]);
      expect(after.code).toBe(0);
      const container = JSON.parse(after.stdout) as { status: string };
      expect(container.status).toBe("running");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid container names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-name-"));
    try {
      const status = await runAgents(root, ["os", "status", "../../etc"]);
      expect(status.code).toBe(1);
      expect(status.stderr).toContain("invalid container name");

      const create = await runAgents(root, ["os", "create", "--name", "bad name", "--image", "andromeda-os", "--dry-run"]);
      expect(create.code).toBe(1);
      expect(create.stderr).toContain("invalid container name");

      const deploy = await runAgents(root, ["os", "deploy", "agent-os-gateway", "--name", "../../etc", "--dry-run"]);
      expect(deploy.code).toBe(1);
      expect(deploy.stderr).toContain("invalid container name");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exec parses command after --", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-exec-"));
    try {
      const { env, log } = await fakeDocker(root);
      const result = await runAgents(root, ["os", "exec", "mycontainer", "--", "echo", "hi"], env);
      expect(result.code).toBe(0);
      const calls = (await Bun.file(log).text()).trim().split(/\r?\n/);
      expect(calls[calls.length - 1]).toContain("container exec mycontainer echo hi");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("os doctor acceptance additions", () => {
  test("checkPathSharing validates each configured host path through docker using the configured OS image", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-path-share-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await mkdir(state.workspaceDir, { recursive: true });
      await mkdir(systemDataPath(state), { recursive: true });

      const passingRunner = async () => ({ code: 0, stdout: "", stderr: "" });
      const passing = await checkPathSharing(state, { runner: passingRunner, image: "test-image" });
      expect(passing.ok).toBe(true);
      expect(passing.details.length).toBeGreaterThan(0);
      expect(passing.details.every((d) => d.ok)).toBe(true);

      const failingRunner = async () => ({ code: 1, stdout: "", stderr: "" });
      const failing = await checkPathSharing(state, { runner: failingRunner, image: "test-image" });
      expect(failing.ok).toBe(false);
      expect(failing.details.every((d) => !d.ok)).toBe(true);
      expect(failing.issues[0]).toContain("Docker cannot access host path");
    } finally {
      resetDockerRunner();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("configuredProfiles reads profiles from container records", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-profiles-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      expect(await configuredProfiles(state)).toEqual([]);

      const { ensureContainerRecord } = await import("../src/os-lifecycle");
      await ensureContainerRecord(state, {
        id: "andromeda-os-dev",
        name: "andromeda-os-dev",
        environment: "dev",
        image: "andromeda-os:dev",
        channel: "dev",
        status: "created",
        profiles: ["agent-os-inference", "agent-os-gateway"],
      });
      expect(await configuredProfiles(state)).toEqual(["agent-os-inference", "agent-os-gateway"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preflightProfile checks required data repos, secrets and ports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-preflight-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);

      const harness = await preflightProfile(state, "harness", { checkPorts: false });
      expect(harness.ok).toBe(true);
      expect(harness.issues).toEqual([]);

      const unknown = await preflightProfile(state, "unknown-profile", { checkPorts: false });
      expect(unknown.ok).toBe(false);
      expect(unknown.issues).toContain("unknown profile: unknown-profile");

      const darkfactory = await preflightProfile(state, "darkfactory", { checkPorts: false });
      expect(darkfactory.ok).toBe(false);
      expect(darkfactory.issues).toContain("profile darkfactory requires secret: github");

      await writeSecret(state, "OPENAI", "sk-test");
      const gateway = await preflightProfile(state, "agent-os-gateway", { checkPorts: false });
      expect(gateway.ok).toBe(false);
      expect(gateway.issues).toContain("profile agent-os-gateway requires secret: github");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("preflightProfiles aggregates issues across profiles", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-preflight-multi-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const result = await preflightProfiles(state, ["unknown-a", "unknown-b"], { checkPorts: false });
      expect(result.ok).toBe(false);
      expect(result.issues).toContain("unknown profile: unknown-a");
      expect(result.issues).toContain("unknown profile: unknown-b");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("isPortAvailable reflects port occupancy", async () => {
    const server = await import("node:net").then((m) =>
      m.createServer().listen(0, "127.0.0.1"),
    );
    const port = (server.address() as import("node:net").AddressInfo).port;
    try {
      expect(await isPortAvailable(port)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    // Port should be free after close.
    expect(await isPortAvailable(port)).toBe(true);
  });

  test("preflightProfile respects expected ports from running containers", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-expected-ports-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const occupiedPorts = new Set([8080]);
      const portChecker = async (port: number) => !occupiedPorts.has(port);

      // Without expected port, an occupied port is reported.
      const withoutExpected = await preflightProfile(state, "agent-os-inference", {
        checkPorts: true,
        expectedPorts: new Set(),
        portChecker,
      });
      expect(withoutExpected.issues).toContain("profile agent-os-inference host port 8080 is in use");

      // With the port marked as expected from a running container, no port issue is reported.
      const withExpected = await preflightProfile(state, "agent-os-inference", {
        checkPorts: true,
        expectedPorts: new Set([8080]),
        portChecker,
      });
      expect(withExpected.issues).not.toContain("profile agent-os-inference host port 8080 is in use");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor warns on profile preflight failures", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "andromeda-os-doctor-profiles-"));
    try {
      const { env } = await fakeDocker(root);
      const { ensureContainerRecord } = await import("../src/os-lifecycle");
      const state = sharedState(root);
      await ensureSharedState(state);
      await ensureContainerRecord(state, {
        id: "andromeda-os-dev",
        name: "andromeda-os-dev",
        environment: "dev",
        image: "andromeda-os:dev",
        channel: "dev",
        status: "created",
        profiles: ["agent-os-gateway"],
      });
      const result = await runAgents(root, ["os", "doctor"], env);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("profile agent-os-gateway requires secret: openai");
      expect(result.stderr).toContain("profile agent-os-gateway requires secret: github");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
