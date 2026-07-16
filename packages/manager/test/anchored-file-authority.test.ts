import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runAnchoredFileAuthority } from "../src/anchored-file-authority";

const roots: string[] = [];

async function fixture(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return realpath(root);
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("manager-owned anchored file authority", () => {
  test("primary: create, identity-bound replace, and final proof stay under one physical root", async () => {
    const root = await fixture("agents-anchor-primary-");
    const publicationRoot = await fixture("agents-anchor-primary-state-");
    const parent = path.join(root, "receipts");
    const target = path.join(parent, "model.json");
    await mkdir(parent);

    const created = await runAnchoredFileAuthority({
      operation: "create",
      root,
      publicationRoot,
      components: ["receipts", "model.json"],
      content: Buffer.from("pending", "utf8"),
      lifecycle: {
        beforePublication: async () => {
          expect(await Bun.file(target).exists()).toBe(false);
          const staged = await readdir(publicationRoot);
          expect(staged).toHaveLength(1);
          expect(await readFile(path.join(publicationRoot, staged[0]!), "utf8")).toBe(
            "pending",
          );
        },
      },
    });
    const replaced = await runAnchoredFileAuthority({
      operation: "replace",
      root,
      components: ["receipts", "model.json"],
      content: Buffer.from("complete", "utf8"),
      expected: created,
    });
    await expect(
      runAnchoredFileAuthority({
        operation: "verify",
        root,
        components: ["receipts", "model.json"],
        expected: replaced,
      }),
    ).resolves.toEqual(replaced);
    expect(await readFile(path.join(root, "receipts", "model.json"), "utf8")).toBe("complete");
  });

  test("edge: prior-content drift cannot be overwritten through a still-matching file identity", async () => {
    const root = await fixture("agents-anchor-content-");
    const publicationRoot = await fixture("agents-anchor-content-state-");
    await mkdir(path.join(root, "receipts"));
    const target = path.join(root, "receipts", "model.json");
    const created = await runAnchoredFileAuthority({
      operation: "create",
      root,
      publicationRoot,
      components: ["receipts", "model.json"],
      content: Buffer.from("pending", "utf8"),
    });

    await writeFile(target, "owner-tamper", "utf8");
    await expect(
      runAnchoredFileAuthority({
        operation: "replace",
        root,
        components: ["receipts", "model.json"],
        content: Buffer.from("must-not-land", "utf8"),
        expected: created,
      }),
    ).rejects.toThrow("content_changed");
    expect(await readFile(target, "utf8")).toBe("owner-tamper");
  });

  test("primary: publication exposes a complete pending or final file and adopts the new identity", async () => {
    const root = await fixture("agents-anchor-publish-");
    const publicationRoot = await fixture("agents-anchor-publish-state-");
    const parent = path.join(root, "receipts");
    const target = path.join(parent, "model.json");
    await mkdir(parent);
    const created = await runAnchoredFileAuthority({
      operation: "create",
      root,
      publicationRoot,
      components: ["receipts", "model.json"],
      content: Buffer.from("pending", "utf8"),
    });

    const published = await runAnchoredFileAuthority({
      operation: "publish",
      root,
      publicationRoot,
      components: ["receipts", "model.json"],
      content: Buffer.from("complete", "utf8"),
      expected: created,
      lifecycle: {
        beforePublication: async () => {
          expect(await readFile(target, "utf8")).toBe("pending");
          const staged = await readdir(publicationRoot);
          expect(staged).toHaveLength(1);
          expect(await readFile(path.join(publicationRoot, staged[0]!), "utf8")).toBe(
            "complete",
          );
        },
      },
    });

    expect(published.file).not.toEqual(created.file);
    expect(await readFile(target, "utf8")).toBe("complete");
    expect(await readdir(parent)).toEqual(["model.json"]);
    expect(await readdir(publicationRoot)).toEqual([]);
    await expect(
      runAnchoredFileAuthority({
        operation: "verify",
        root,
        components: ["receipts", "model.json"],
        expected: published,
      }),
    ).resolves.toEqual(published);
  });

  test("denied: aborted publication preserves pending content and removes its temporary file", async () => {
    const root = await fixture("agents-anchor-publish-abort-");
    const publicationRoot = await fixture("agents-anchor-publish-abort-state-");
    const parent = path.join(root, "receipts");
    const target = path.join(parent, "model.json");
    await mkdir(parent);
    const created = await runAnchoredFileAuthority({
      operation: "create",
      root,
      publicationRoot,
      components: ["receipts", "model.json"],
      content: Buffer.from("pending", "utf8"),
    });

    await expect(
      runAnchoredFileAuthority({
        operation: "publish",
        root,
        publicationRoot,
        components: ["receipts", "model.json"],
        content: Buffer.from("must-not-land", "utf8"),
        expected: created,
        lifecycle: {
          beforePublication: async () => {
            throw new Error("stop before publication");
          },
        },
      }),
    ).rejects.toThrow("mutation_failed");

    expect(await readFile(target, "utf8")).toBe("pending");
    expect(await readdir(parent)).toEqual(["model.json"]);
    expect(await readdir(publicationRoot)).toEqual([]);
    await expect(
      runAnchoredFileAuthority({
        operation: "verify",
        root,
        components: ["receipts", "model.json"],
        expected: created,
      }),
    ).resolves.toEqual(created);
  });

  test("denied: a receipt parent swap creates no file through the escaped path", async () => {
    const root = await fixture("agents-anchor-create-race-");
    const publicationRoot = await fixture("agents-anchor-create-race-state-");
    const outside = await fixture("agents-anchor-create-outside-");
    const parent = path.join(root, "receipts");
    const heldParent = path.join(root, "receipts-held");
    await mkdir(parent);

    await expect(
      runAnchoredFileAuthority({
        operation: "create",
        root,
        publicationRoot,
        components: ["receipts", "model.json"],
        content: Buffer.from("must-not-escape", "utf8"),
        lifecycle: {
          beforeFinalTraversal: async () => {
            await rename(parent, heldParent);
            await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
          },
        },
      }),
    ).rejects.toThrow();

    expect(await Bun.file(path.join(outside, "model.json")).exists()).toBe(false);
    expect(await Bun.file(path.join(heldParent, "model.json")).exists()).toBe(false);
    expect(await Bun.file(path.join(parent, "model.json")).exists()).toBe(false);
  });

  test("denied: publication staging cannot overlap provider-writable target authority", async () => {
    const root = await fixture("agents-anchor-overlap-");
    const parent = path.join(root, "receipts");
    await mkdir(parent);

    await expect(
      runAnchoredFileAuthority({
        operation: "create",
        root,
        publicationRoot: root,
        components: ["receipts", "model.json"],
        content: Buffer.from("must-not-land", "utf8"),
      }),
    ).rejects.toThrow("invalid_request");
    expect(await Bun.file(path.join(parent, "model.json")).exists()).toBe(false);
  });

  test("denied: an admitted write parent swap changes neither owner file", async () => {
    const root = await fixture("agents-anchor-write-race-");
    const outside = await fixture("agents-anchor-write-outside-");
    const parent = path.join(root, "workspace");
    const heldParent = path.join(root, "workspace-held");
    await mkdir(parent);
    await writeFile(path.join(parent, "owner.txt"), "inside-owner", "utf8");
    await writeFile(path.join(outside, "owner.txt"), "outside-owner", "utf8");

    await expect(
      runAnchoredFileAuthority({
        operation: "replace",
        root,
        components: ["workspace", "owner.txt"],
        content: Buffer.from("must-not-land", "utf8"),
        lifecycle: {
          beforeFinalTraversal: async () => {
            await rename(parent, heldParent);
            await symlink(outside, parent, process.platform === "win32" ? "junction" : "dir");
          },
        },
      }),
    ).rejects.toThrow();

    expect(await readFile(path.join(outside, "owner.txt"), "utf8")).toBe("outside-owner");
    const admittedOwner = await Bun.file(path.join(heldParent, "owner.txt")).exists()
      ? path.join(heldParent, "owner.txt")
      : path.join(parent, "owner.txt");
    expect(await readFile(admittedOwner, "utf8")).toBe("inside-owner");
  });
});
