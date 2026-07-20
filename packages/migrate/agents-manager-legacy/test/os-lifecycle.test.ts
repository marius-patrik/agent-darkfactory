import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCreatePlan,
  containerEnv,
  containerMounts,
  defaultContainerName,
  dockerCreateArgs,
  resolveImageRef,
  toPosixPath,
} from "../src/os-lifecycle";
import { upsertDataRepo } from "../src/data-repos";
import { ensureSharedState, sharedState } from "../src/state";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliPath = path.join(repoRoot, "src", "cli.ts");

function cleanEnv(): Record<string, string | undefined> {
  const copy = { ...process.env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("AGENTS_")) delete copy[key];
  }
  return copy;
}

async function fakeDocker(root: string): Promise<{ dir: string; log: string; env: Record<string, string | undefined> }> {
  const dir = path.join(root, "bin");
  const log = path.join(root, "docker-calls.log");
  await mkdir(dir, { recursive: true });
  const script = path.join(dir, process.platform === "win32" ? "docker.cmd" : "docker");
  if (process.platform === "win32") {
    await Bun.write(script, `@echo off\r\necho %* >> "${log}"\r\n`);
  } else {
    await Bun.write(script, `#!/bin/sh\necho "$*" >> "${log}"\n`);
    await Bun.$`chmod +x ${script}`;
  }
  return { dir, log, env: { PATH: `${dir}${path.delimiter}${process.env.PATH ?? ""}` } };
}

async function runAgents(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, cliPath, ...args], {
    cwd,
    env: { ...cleanEnv(), AGENTS_HOME: path.join(cwd, ".agents"), AGENTS_ROOT: cwd, ...env },
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
    expect(toPosixPath("D:/data/agentos")).toBe("/d/data/agentos");
    expect(toPosixPath("/agents/state")).toBe("/agents/state");
    expect(toPosixPath("\\\\server\\share")).toBe("//server/share");
  });

  test("containerEnv exports required variables", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-env-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const env = containerEnv([]);
      expect(env.AGENTS_ROOT).toBe("/opt/agents-os");
      expect(env.AGENTS_HOME).toBe("/agents/state");
      expect(env.AGENTS_DATA).toBe("/agents/data");
      expect(env.AGENTS_WORKSPACE).toBe("/workspace/agents");
      expect(env.AGENTOS_DATA_ROOT).toBe("/agents/data/agentos-data");
      expect(env.AGENTS_CREDITS).toBe("/agents/state/credits.json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("containerMounts include state, data, workspace and registered repos", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-mounts-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      await upsertDataRepo(state, {
        id: "darkfactory-data",
        repo: "marius-patrik/agentos-data",
        path: path.join(root, "data", "darkfactory-data"),
        branch: "main",
        env: "DARKFACTORY_DATA_ROOT",
      });
      const dataRepos = await import("../src/data-repos").then((m) => m.readDataRepos(state));
      const mounts = await containerMounts(state, dataRepos);
      expect(mounts.find((m) => m.container === "/agents/state")?.host).toBe(toPosixPath(state.stateDir));
      expect(mounts.find((m) => m.container === "/agents/state")?.mode).toBe("ro");
      expect(mounts.find((m) => m.container === "/agents/data")?.host).toBe(toPosixPath(state.dataDir));
      expect(mounts.find((m) => m.container === "/workspace/agents")?.host).toBe(toPosixPath(state.workspaceDir));
      expect(mounts.find((m) => m.container === "/agents/data/darkfactory-data")?.host).toBe(
        toPosixPath(path.join(root, "data", "darkfactory-data")),
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
      name: "agents-os-dev",
      image: "agents-os:dev",
      environment: "dev",
      channel: "dev",
      hostRoot: "/home/user/agents-mono",
      mounts: [
        { host: "/home/user/.agents", container: "/agents/state", mode: "rw" },
      ],
      env: { AGENTS_HOME: "/agents/state" },
      ports: [{ name: "http", container: 8080, host: 8080 }],
      network: "agents-os",
      restart: "no",
    });
    expect(args).toContain("--name");
    expect(args).toContain("agents-os-dev");
    expect(args).toContain("agents-os:dev");
    expect(args).toContain("io.agents.os.managed=true");
    expect(args).toContain("io.agents.os.environment=dev");
    expect(args).toContain("-e");
    expect(args).toContain("AGENTS_HOME=/agents/state");
    expect(args).toContain("-v");
    expect(args).toContain("/home/user/.agents:/agents/state:rw");
    expect(args).toContain("-p");
    expect(args).toContain("8080:8080");
    expect(args).toContain("--network");
    expect(args).toContain("agents-os");
  });

  test("buildCreatePlan produces a reproducible docker create plan", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-plan-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const plan = await buildCreatePlan(state, {
        name: "agents-os-dev",
        image: "agents-os:dev",
        environment: "dev",
      });
      expect(plan.command).toBe("docker");
      expect(plan.description).toContain("agents-os-dev");
      expect(plan.args).toContain("container");
      expect(plan.args).toContain("create");
      expect(plan.args.some((a) => a.includes("/agents/state"))).toBe(true);
      expect(plan.args.some((a) => a.includes("AGENTS_ROOT=/opt/agents-os"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("defaultContainerName uses environment", () => {
    expect(defaultContainerName("agents-os")).toBe("agents-os-agents-os");
    expect(defaultContainerName("dev")).toBe("agents-os-dev");
  });

  test("resolveImageRef appends channel only when reference is untagged", () => {
    expect(resolveImageRef("agents-os", "dev")).toBe("agents-os:dev");
    expect(resolveImageRef("agents-os", "latest")).toBe("agents-os:latest");
    expect(resolveImageRef("ubuntu:22.04", "dev")).toBe("ubuntu:22.04");
    expect(resolveImageRef("repo/image@sha256:abc123", "dev")).toBe("repo/image@sha256:abc123");
    expect(resolveImageRef("my.registry.io/agents-os", "stable")).toBe("my.registry.io/agents-os:stable");
    expect(resolveImageRef("localhost:5000/agents-os", "dev")).toBe("localhost:5000/agents-os:dev");
  });
});

describe("agents os CLI", () => {
  test("doctor passes when docker and prerequisites are present", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-doctor-ok-"));
    try {
      const { env } = await fakeDocker(root);
      const dockerfile = path.join(root, "os", "agents-os", "Dockerfile");
      await mkdir(path.dirname(dockerfile), { recursive: true });
      await Bun.write(dockerfile, "FROM scratch\n");
      const data = await runAgents(root, ["data", "repo", "set", "darkfactory-data", "marius-patrik/agentos-data", "--env", "DARKFACTORY_DATA_ROOT"]);
      expect(data.code).toBe(0);
      const build = await runAgents(root, ["os", "image", "build", "--image", "agents-os"], env);
      expect(build.code).toBe(0);
      const doctor = await runAgents(root, ["os", "doctor"], env);
      expect(doctor.code).toBe(0);
      expect(doctor.stdout).toContain("ok docker");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("doctor warns on missing prerequisites", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-doctor-warn-"));
    try {
      const { env } = await fakeDocker(root);
      const doctor = await runAgents(root, ["os", "doctor"], env);
      expect(doctor.code).toBe(1);
      expect(doctor.stderr).toContain("darkfactory-data");
      expect(doctor.stderr).toContain("no OS images configured");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("image build --dry-run prints plan without recording image", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-image-build-dry-"));
    try {
      const result = await runAgents(root, ["os", "image", "build", "--image", "agents-os", "--channel", "dev", "--dry-run"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker image build");
      expect(result.stdout).toContain("agents-os:dev");
      const list = await runAgents(root, ["os", "image", "list", "--json"]);
      expect(list.code).toBe(0);
      const images = JSON.parse(list.stdout) as Array<{ id: string; image: string; tags: string[] }>;
      expect(images).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("image build records image after successful docker build", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-image-build-"));
    try {
      const { env } = await fakeDocker(root);
      const dockerfile = path.join(root, "os", "agents-os", "Dockerfile");
      await mkdir(path.dirname(dockerfile), { recursive: true });
      await Bun.write(dockerfile, "FROM scratch\n");
      const result = await runAgents(root, ["os", "image", "build", "--image", "agents-os", "--channel", "dev"], env);
      expect(result.code).toBe(0);
      const list = await runAgents(root, ["os", "image", "list", "--json"]);
      expect(list.code).toBe(0);
      const images = JSON.parse(list.stdout) as Array<{ id: string; image: string; tags: string[] }>;
      expect(images).toHaveLength(1);
      expect(images[0].id).toBe("agents-os");
      expect(images[0].tags).toContain("dev");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("image build preserves explicit tag and does not append channel", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-image-build-tagged-"));
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
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-create-"));
    try {
      const result = await runAgents(root, [
        "os",
        "create",
        "--name",
        "agents-os-dev",
        "--image",
        "agents-os",
        "--env",
        "dev",
        "--dry-run",
      ]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker container create");
      expect(result.stdout).toContain("agents-os-dev");
      expect(result.stdout).toContain(toPosixPath(path.join(root, ".agents")));
      expect(result.stdout).toContain("AGENTS_ROOT=/opt/agents-os");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("create masks secrets by default and mounts them with --with-secrets", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-create-secrets-"));
    try {
      const state = sharedState(root);
      await ensureSharedState(state);
      const defaultRun = await runAgents(root, [
        "os",
        "create",
        "--name",
        "agents-os-dev",
        "--image",
        "agents-os",
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
        "agents-os-dev",
        "--image",
        "agents-os",
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
        "agents-os-dev",
        "--image",
        "agents-os",
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
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-create-record-"));
    try {
      const { env } = await fakeDocker(root);
      const create = await runAgents(root, ["os", "create", "--name", "agents-os-dev", "--image", "agents-os", "--env", "dev"], env);
      expect(create.code).toBe(0);
      const status = await runAgents(root, ["os", "status", "agents-os-dev", "--json"]);
      expect(status.code).toBe(0);
      const container = JSON.parse(status.stdout) as { name: string; status: string };
      expect(container.name).toBe("agents-os-dev");
      expect(container.status).toBe("created");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remove deletes container record after successful docker rm", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-remove-record-"));
    try {
      const { env } = await fakeDocker(root);
      await runAgents(root, ["os", "create", "--name", "agents-os-dev", "--image", "agents-os", "--env", "dev"], env);
      const remove = await runAgents(root, ["os", "remove", "agents-os-dev"], env);
      expect(remove.code).toBe(0);
      const status = await runAgents(root, ["os", "status", "agents-os-dev", "--json"]);
      expect(status.code).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failed docker create does not record container", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-create-fail-"));
    try {
      const { dir, env } = await fakeDocker(root);
      const failing = path.join(dir, process.platform === "win32" ? "docker.cmd" : "docker");
      if (process.platform === "win32") {
        await Bun.write(failing, `@echo off\r\necho %* >> "${path.join(root, "docker-calls.log")}"\r\necho %* | findstr /C:"container create" >nul && exit /b 1\r\n`);
      } else {
        await Bun.write(
          failing,
          `#!/bin/sh\necho "$*" >> "${path.join(root, "docker-calls.log")}"\nif echo "$*" | grep -q "container create"; then exit 1; fi\n`,
        );
        await Bun.$`chmod +x ${failing}`;
      }
      const create = await runAgents(root, ["os", "create", "--name", "agents-os-dev", "--image", "agents-os"], env);
      expect(create.code).toBe(1);
      const status = await runAgents(root, ["os", "status", "agents-os-dev", "--json"]);
      expect(status.code).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("logs --dry-run prints plan without invoking docker", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-logs-dry-"));
    try {
      const result = await runAgents(root, ["os", "logs", "agents-os-dev", "--dry-run"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker container logs agents-os-dev");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remove --dry-run excludes data prune by default", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-remove-"));
    try {
      await runAgents(root, ["os", "create", "--name", "agents-os-dev", "--image", "agents-os", "--dry-run"]);
      const result = await runAgents(root, ["os", "remove", "agents-os-dev", "--dry-run"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker container rm agents-os-dev");
      expect(result.stdout).not.toContain("rm -rf");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("remove --prune-data --dry-run includes prune steps", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-remove-prune-"));
    try {
      await runAgents(root, ["os", "create", "--name", "agents-os-dev", "--image", "agents-os", "--dry-run"]);
      const result = await runAgents(root, ["os", "remove", "agents-os-dev", "--prune-data", "--dry-run"]);
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("docker container rm agents-os-dev");
      expect(result.stdout).toContain("rm -rf");
      expect(result.stdout).toContain("/agents/state/containers/agents-os-dev");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deploy --dry-run prints create and start with profile ports", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-deploy-"));
    try {
      const result = await runAgents(root, ["os", "deploy", "llm-gateway", "--dry-run"]);
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
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-deploy-unknown-"));
    try {
      const result = await runAgents(root, ["os", "deploy", "unknown-profile", "--dry-run"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("unknown profile");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("deploy records running container after successful docker create/start", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-deploy-record-"));
    try {
      const { env } = await fakeDocker(root);
      const deploy = await runAgents(root, ["os", "deploy", "llm-gateway", "--name", "agents-os-deploy", "--env", "dev"], env);
      expect(deploy.code).toBe(0);
      const status = await runAgents(root, ["os", "status", "agents-os-deploy", "--json"]);
      expect(status.code).toBe(0);
      const container = JSON.parse(status.stdout) as { name: string; status: string; profiles: string[] };
      expect(container.name).toBe("agents-os-deploy");
      expect(container.status).toBe("running");
      expect(container.profiles).toContain("llm-gateway");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("failed deploy does not overwrite existing container record", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-deploy-fail-"));
    try {
      const { env, dir } = await fakeDocker(root);
      await runAgents(root, ["os", "create", "--name", "agents-os-deploy", "--image", "agents-os", "--env", "dev"], env);
      await runAgents(root, ["os", "start", "agents-os-deploy"], env);
      const before = await runAgents(root, ["os", "status", "agents-os-deploy", "--json"]);
      expect(before.code).toBe(0);

      const failing = path.join(dir, process.platform === "win32" ? "docker.cmd" : "docker");
      if (process.platform === "win32") {
        await Bun.write(
          failing,
          `@echo off\r\necho %* >> "${path.join(root, "docker-calls.log")}"\r\necho %* | findstr /C:"container create" >nul && exit /b 1\r\n`,
        );
      } else {
        await Bun.write(
          failing,
          `#!/bin/sh\necho "$*" >> "${path.join(root, "docker-calls.log")}"\nif echo "$*" | grep -q "container create"; then exit 1; fi\n`,
        );
        await Bun.$`chmod +x ${failing}`;
      }

      const deploy = await runAgents(root, ["os", "deploy", "llm-gateway", "--name", "agents-os-deploy", "--env", "dev"], env);
      expect(deploy.code).toBe(1);
      const after = await runAgents(root, ["os", "status", "agents-os-deploy", "--json"]);
      expect(after.code).toBe(0);
      const container = JSON.parse(after.stdout) as { status: string };
      expect(container.status).toBe("running");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects invalid container names", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-name-"));
    try {
      const status = await runAgents(root, ["os", "status", "../../etc"]);
      expect(status.code).toBe(1);
      expect(status.stderr).toContain("invalid container name");

      const create = await runAgents(root, ["os", "create", "--name", "bad name", "--image", "agents-os", "--dry-run"]);
      expect(create.code).toBe(1);
      expect(create.stderr).toContain("invalid container name");

      const deploy = await runAgents(root, ["os", "deploy", "llm-gateway", "--name", "../../etc", "--dry-run"]);
      expect(deploy.code).toBe(1);
      expect(deploy.stderr).toContain("invalid container name");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("exec parses command after --", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "agents-os-exec-"));
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
