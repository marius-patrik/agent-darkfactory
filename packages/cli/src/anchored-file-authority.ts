import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import type { Pointer } from "bun:ffi";

/**
 * The manager's one mutation boundary for receipt and provider-requested file
 * writes. It is deliberately not a general filesystem helper.
 *
 * Invariants:
 * - callers supply canonical physical target and publication roots plus a
 *   component-only relative target path;
 * - every ancestor is opened without following links and held through mutation;
 * - a second root-anchored traversal must reproduce every held identity before
 *   the first target mutation or temporary publication-file side effect;
 * - replace/publish/verify operations require one regular, singly-linked target;
 * - Windows handles deny delete sharing through final admission; publication
 *   releases only file handles for the single atomic move while every admitted
 *   ancestor remains held;
 * - receipt files are durably staged outside provider-writable authority, then
 *   atomically moved into the target root; final publication additionally
 *   binds the pending identities and prior content and adopts the staged file;
 * - platforms without one of the audited implementations fail closed.
 */

const MAX_AUTHORITY_CONTENT_BYTES = 16 * 1024 * 1024;
const WINDOWS_RESERVED_COMPONENT = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i;

export type AnchoredFileOperation = "create" | "replace" | "publish" | "verify";

export interface AnchoredFileIdentity {
  volume: string;
  file: string;
}

export interface AnchoredFileProof {
  root: AnchoredFileIdentity;
  file: AnchoredFileIdentity;
  contentSha256: string;
}

export interface AnchoredFileAuthorityLifecycle {
  /** Deterministic regression seam; production callers never provide it. */
  beforeFinalTraversal?: () => Promise<void>;
  /** Deterministic regression seam after the temporary file is durable. */
  beforePublication?: () => Promise<void>;
}

export interface AnchoredFileAuthorityRequest {
  operation: AnchoredFileOperation;
  root: string;
  /** Required for create/publish and physically disjoint from `root`. */
  publicationRoot?: string;
  components: readonly string[];
  content?: Uint8Array;
  expected?: AnchoredFileProof;
  lifecycle?: AnchoredFileAuthorityLifecycle;
}

export class AnchoredFileAuthorityError extends Error {
  constructor(
    readonly reason:
      | "unsupported_platform"
      | "invalid_request"
      | "containment_changed"
      | "target_unavailable"
      | "identity_changed"
      | "content_changed"
      | "mutation_failed",
  ) {
    super(`anchored file authority denied: ${reason}`);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function containsPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function sameIdentity(left: AnchoredFileIdentity, right: AnchoredFileIdentity): boolean {
  return left.volume === right.volume && left.file === right.file;
}

function sameProof(left: AnchoredFileProof, right: AnchoredFileProof): boolean {
  return (
    sameIdentity(left.root, right.root) &&
    sameIdentity(left.file, right.file) &&
    left.contentSha256 === right.contentSha256
  );
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function validateComponents(components: readonly string[]): void {
  if (components.length === 0) throw new AnchoredFileAuthorityError("invalid_request");
  for (const component of components) {
    if (
      !component ||
      component === "." ||
      component === ".." ||
      component.includes("\0") ||
      component.includes(path.sep)
    ) {
      throw new AnchoredFileAuthorityError("invalid_request");
    }
    if (
      process.platform === "win32" &&
      (/[<>:"/\\|?*]/.test(component) ||
        component.endsWith(".") ||
        component.endsWith(" ") ||
        WINDOWS_RESERVED_COMPONENT.test(component))
    ) {
      throw new AnchoredFileAuthorityError("invalid_request");
    }
  }
}

function normalizedContent(request: AnchoredFileAuthorityRequest): Buffer {
  if (request.operation === "verify") {
    if (request.content !== undefined) throw new AnchoredFileAuthorityError("invalid_request");
    return Buffer.alloc(0);
  }
  if (!request.content) throw new AnchoredFileAuthorityError("invalid_request");
  const content = Buffer.from(request.content);
  if (content.length > MAX_AUTHORITY_CONTENT_BYTES) {
    throw new AnchoredFileAuthorityError("invalid_request");
  }
  return content;
}

function validateRequest(request: AnchoredFileAuthorityRequest): Buffer {
  if (!path.isAbsolute(request.root) || request.root.includes("\0")) {
    throw new AnchoredFileAuthorityError("invalid_request");
  }
  validateComponents(request.components);
  if (request.operation === "create" && request.expected) {
    throw new AnchoredFileAuthorityError("invalid_request");
  }
  if (request.operation === "verify" && !request.expected) {
    throw new AnchoredFileAuthorityError("invalid_request");
  }
  if (request.operation === "publish" && !request.expected) {
    throw new AnchoredFileAuthorityError("invalid_request");
  }
  const requiresPublicationRoot =
    request.operation === "create" || request.operation === "publish";
  if (
    requiresPublicationRoot !== (request.publicationRoot !== undefined) ||
    (request.publicationRoot !== undefined &&
      (!path.isAbsolute(request.publicationRoot) || request.publicationRoot.includes("\0")))
  ) {
    throw new AnchoredFileAuthorityError("invalid_request");
  }
  return normalizedContent(request);
}

function publicationTemporaryComponent(): string {
  return `.agents-${randomBytes(16).toString("hex")}.tmp`;
}

function posixIdentity(info: ReturnType<typeof fstatSync>): AnchoredFileIdentity {
  return { volume: String(info.dev), file: String(info.ino) };
}

function closeFileDescriptors(descriptors: readonly number[]): void {
  for (const descriptor of [...descriptors].reverse()) {
    try {
      closeSync(descriptor);
    } catch {
      // The primary authority result must not be replaced by cleanup noise.
    }
  }
}

async function loadPosixRuntime() {
  try {
    const ffi = await import("bun:ffi");
    const library = process.platform === "linux"
      ? "libc.so.6"
      : process.platform === "darwin"
        ? "/usr/lib/libSystem.B.dylib"
        : null;
    if (!library) throw new AnchoredFileAuthorityError("unsupported_platform");
    const native = ffi.dlopen(library, {
      openat: {
        args: ["i32", "ptr", "i32", "u32"],
        returns: "i32",
      },
      renameat: {
        args: ["i32", "ptr", "i32", "ptr"],
        returns: "i32",
      },
      linkat: {
        args: ["i32", "ptr", "i32", "ptr", "i32"],
        returns: "i32",
      },
      unlinkat: {
        args: ["i32", "ptr", "i32"],
        returns: "i32",
      },
    } as const);
    return {
      openat: native.symbols.openat,
      renameat: native.symbols.renameat,
      linkat: native.symbols.linkat,
      unlinkat: native.symbols.unlinkat,
      ptr: ffi.ptr,
    };
  } catch (error) {
    if (error instanceof AnchoredFileAuthorityError) throw error;
    throw new AnchoredFileAuthorityError("unsupported_platform");
  }
}

let posixRuntimePromise: ReturnType<typeof loadPosixRuntime> | null = null;

function posixRuntime(): ReturnType<typeof loadPosixRuntime> {
  posixRuntimePromise ??= loadPosixRuntime();
  return posixRuntimePromise;
}

type PosixRuntime = Awaited<ReturnType<typeof loadPosixRuntime>>;

interface PosixChain {
  descriptors: number[];
  identities: AnchoredFileIdentity[];
}

function openAt(
  runtime: PosixRuntime,
  parent: number,
  component: string,
  flags: number,
  mode = 0,
): number {
  const name = Buffer.from(`${component}\0`, "utf8");
  const descriptor = runtime.openat(parent, runtime.ptr(name), flags, mode);
  if (!Number.isSafeInteger(descriptor) || descriptor < 0) {
    throw new AnchoredFileAuthorityError("target_unavailable");
  }
  return descriptor;
}

function renameAt(
  runtime: PosixRuntime,
  sourceParent: number,
  source: string,
  destinationParent: number,
  destination: string,
): void {
  const encodedSource = Buffer.from(`${source}\0`, "utf8");
  const encodedDestination = Buffer.from(`${destination}\0`, "utf8");
  if (
    runtime.renameat(
      sourceParent,
      runtime.ptr(encodedSource),
      destinationParent,
      runtime.ptr(encodedDestination),
    ) !== 0
  ) {
    throw new AnchoredFileAuthorityError("mutation_failed");
  }
}

function linkAt(
  runtime: PosixRuntime,
  sourceParent: number,
  source: string,
  destinationParent: number,
  destination: string,
): void {
  const encodedSource = Buffer.from(`${source}\0`, "utf8");
  const encodedDestination = Buffer.from(`${destination}\0`, "utf8");
  if (
    runtime.linkat(
      sourceParent,
      runtime.ptr(encodedSource),
      destinationParent,
      runtime.ptr(encodedDestination),
      0,
    ) !== 0
  ) {
    throw new AnchoredFileAuthorityError("mutation_failed");
  }
}

function unlinkAt(runtime: PosixRuntime, parent: number, component: string): void {
  const encoded = Buffer.from(`${component}\0`, "utf8");
  if (runtime.unlinkat(parent, runtime.ptr(encoded), 0) !== 0) {
    throw new AnchoredFileAuthorityError("mutation_failed");
  }
}

function posixDirectoryFlags(): number {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const directory = fsConstants.O_DIRECTORY ?? 0;
  const closeOnExec = (fsConstants as Record<string, number>).O_CLOEXEC ?? 0;
  if (!noFollow || !directory) throw new AnchoredFileAuthorityError("unsupported_platform");
  return fsConstants.O_RDONLY | noFollow | directory | closeOnExec;
}

function openPosixChain(
  runtime: PosixRuntime,
  root: string,
  directories: readonly string[],
): PosixChain {
  const descriptors: number[] = [];
  const identities: AnchoredFileIdentity[] = [];
  try {
    const rootDescriptor = openSync(root, posixDirectoryFlags());
    descriptors.push(rootDescriptor);
    const rootInfo = fstatSync(rootDescriptor, { bigint: true });
    if (!rootInfo.isDirectory()) throw new AnchoredFileAuthorityError("containment_changed");
    identities.push(posixIdentity(rootInfo));
    for (const component of directories) {
      const descriptor = openAt(runtime, descriptors.at(-1)!, component, posixDirectoryFlags());
      descriptors.push(descriptor);
      const info = fstatSync(descriptor, { bigint: true });
      if (!info.isDirectory()) throw new AnchoredFileAuthorityError("containment_changed");
      identities.push(posixIdentity(info));
    }
    return { descriptors, identities };
  } catch (error) {
    closeFileDescriptors(descriptors);
    if (error instanceof AnchoredFileAuthorityError) throw error;
    throw new AnchoredFileAuthorityError("containment_changed");
  }
}

function sameChain(left: PosixChain, right: PosixChain): boolean {
  return (
    left.identities.length === right.identities.length &&
    left.identities.every((identity, index) => sameIdentity(identity, right.identities[index]!))
  );
}

function posixTargetFlags(write: boolean): number {
  const noFollow = fsConstants.O_NOFOLLOW ?? 0;
  const closeOnExec = (fsConstants as Record<string, number>).O_CLOEXEC ?? 0;
  if (!noFollow) throw new AnchoredFileAuthorityError("unsupported_platform");
  return (write ? fsConstants.O_RDWR : fsConstants.O_RDONLY) | noFollow | closeOnExec;
}

function checkedPosixTarget(descriptor: number): {
  identity: AnchoredFileIdentity;
  contentSize: bigint;
} {
  const info = fstatSync(descriptor, { bigint: true });
  if (!info.isFile() || info.nlink !== 1n) {
    throw new AnchoredFileAuthorityError("containment_changed");
  }
  return { identity: posixIdentity(info), contentSize: info.size };
}

function writePosixContent(descriptor: number, content: Buffer): void {
  ftruncateSync(descriptor, 0);
  let offset = 0;
  while (offset < content.length) {
    const written = writeSync(descriptor, content, offset, content.length - offset, offset);
    if (!Number.isSafeInteger(written) || written <= 0) {
      throw new AnchoredFileAuthorityError("mutation_failed");
    }
    offset += written;
  }
  fsyncSync(descriptor);
}

function readPosixContent(descriptor: number, size: bigint): Buffer {
  if (size > BigInt(MAX_AUTHORITY_CONTENT_BYTES)) {
    throw new AnchoredFileAuthorityError("content_changed");
  }
  const content = Buffer.alloc(Number(size));
  let offset = 0;
  while (offset < content.length) {
    const read = readSync(descriptor, content, offset, content.length - offset, offset);
    if (!Number.isSafeInteger(read) || read <= 0) {
      throw new AnchoredFileAuthorityError("content_changed");
    }
    offset += read;
  }
  return content;
}

async function runPosixAuthority(
  request: AnchoredFileAuthorityRequest,
  canonicalRoot: string,
  canonicalPublicationRoot: string | null,
  content: Buffer,
): Promise<AnchoredFileProof> {
  const runtime = await posixRuntime();
  const directories = request.components.slice(0, -1);
  const targetName = request.components.at(-1)!;
  const heldDescriptors: number[] = [];
  let publicationParentDescriptor: number | null = null;
  let publicationTemporaryName: string | null = null;
  let publicationTemporaryIdentity: AnchoredFileIdentity | null = null;
  let publicationTemporaryExists = false;
  try {
    const first = openPosixChain(runtime, canonicalRoot, directories);
    heldDescriptors.push(...first.descriptors);
    const firstPublication = canonicalPublicationRoot
      ? openPosixChain(runtime, canonicalPublicationRoot, [])
      : null;
    if (firstPublication) {
      heldDescriptors.push(...firstPublication.descriptors);
      if (firstPublication.identities[0]!.volume !== first.identities[0]!.volume) {
        throw new AnchoredFileAuthorityError("mutation_failed");
      }
    }
    let firstTargetDescriptor: number | null = null;
    let firstTargetIdentity: AnchoredFileIdentity | null = null;
    if (request.operation !== "create") {
      firstTargetDescriptor = openAt(
        runtime,
        first.descriptors.at(-1)!,
        targetName,
        posixTargetFlags(false),
      );
      heldDescriptors.push(firstTargetDescriptor);
      firstTargetIdentity = checkedPosixTarget(firstTargetDescriptor).identity;
      if (request.expected) {
        if (
          !sameIdentity(first.identities[0]!, request.expected.root) ||
          !sameIdentity(firstTargetIdentity, request.expected.file)
        ) {
          throw new AnchoredFileAuthorityError("identity_changed");
        }
      }
    }

    await request.lifecycle?.beforeFinalTraversal?.();

    const finalChain = openPosixChain(runtime, canonicalRoot, directories);
    heldDescriptors.push(...finalChain.descriptors);
    if (!sameChain(first, finalChain)) {
      throw new AnchoredFileAuthorityError("containment_changed");
    }
    const finalPublication = canonicalPublicationRoot
      ? openPosixChain(runtime, canonicalPublicationRoot, [])
      : null;
    if (finalPublication) {
      heldDescriptors.push(...finalPublication.descriptors);
      if (
        !firstPublication ||
        !sameChain(firstPublication, finalPublication) ||
        finalPublication.identities[0]!.volume !== finalChain.identities[0]!.volume
      ) {
        throw new AnchoredFileAuthorityError("containment_changed");
      }
    }

    const createFlags =
      posixTargetFlags(true) | fsConstants.O_CREAT | fsConstants.O_EXCL;
    let finalTargetDescriptor: number | null = null;
    let finalTarget: ReturnType<typeof checkedPosixTarget> | null = null;
    if (request.operation !== "create") {
      finalTargetDescriptor = openAt(
        runtime,
        finalChain.descriptors.at(-1)!,
        targetName,
        posixTargetFlags(request.operation === "replace"),
      );
      heldDescriptors.push(finalTargetDescriptor);
      finalTarget = checkedPosixTarget(finalTargetDescriptor);
      if (firstTargetIdentity && !sameIdentity(firstTargetIdentity, finalTarget.identity)) {
        throw new AnchoredFileAuthorityError("identity_changed");
      }
      if (
        request.expected &&
        (!sameIdentity(finalChain.identities[0]!, request.expected.root) ||
          !sameIdentity(finalTarget.identity, request.expected.file))
      ) {
        throw new AnchoredFileAuthorityError("identity_changed");
      }
    }

    let resultFileIdentity: AnchoredFileIdentity;
    let contentSha256: string;
    if (request.operation === "verify") {
      const existing = readPosixContent(finalTargetDescriptor!, finalTarget!.contentSize);
      contentSha256 = digest(existing);
      if (!sameProof(
        {
          root: finalChain.identities[0]!,
          file: finalTarget!.identity,
          contentSha256,
        },
        request.expected!,
      )) {
        throw new AnchoredFileAuthorityError("content_changed");
      }
      resultFileIdentity = finalTarget!.identity;
    } else if (request.operation === "create" || request.operation === "publish") {
      publicationParentDescriptor = finalPublication!.descriptors.at(-1)!;
      publicationTemporaryName = publicationTemporaryComponent();
      const temporaryDescriptor = openAt(
        runtime,
        publicationParentDescriptor,
        publicationTemporaryName,
        createFlags,
        0o600,
      );
      heldDescriptors.push(temporaryDescriptor);
      publicationTemporaryExists = true;
      const temporaryTarget = checkedPosixTarget(temporaryDescriptor);
      publicationTemporaryIdentity = temporaryTarget.identity;
      writePosixContent(temporaryDescriptor, content);

      await request.lifecycle?.beforePublication?.();

      if (request.operation === "publish") {
        const pendingTarget = checkedPosixTarget(finalTargetDescriptor!);
        if (
          !sameIdentity(pendingTarget.identity, request.expected!.file) ||
          digest(readPosixContent(finalTargetDescriptor!, pendingTarget.contentSize)) !==
            request.expected!.contentSha256
        ) {
          throw new AnchoredFileAuthorityError("content_changed");
        }
      }
      const durableTemporary = checkedPosixTarget(temporaryDescriptor);
      if (
        !sameIdentity(durableTemporary.identity, temporaryTarget.identity) ||
        digest(readPosixContent(temporaryDescriptor, durableTemporary.contentSize)) !==
          digest(content)
      ) {
        throw new AnchoredFileAuthorityError("content_changed");
      }

      const targetParentDescriptor = finalChain.descriptors.at(-1)!;
      if (request.operation === "create") {
        linkAt(
          runtime,
          publicationParentDescriptor,
          publicationTemporaryName,
          targetParentDescriptor,
          targetName,
        );
        unlinkAt(runtime, publicationParentDescriptor, publicationTemporaryName);
      } else {
        renameAt(
          runtime,
          publicationParentDescriptor,
          publicationTemporaryName,
          targetParentDescriptor,
          targetName,
        );
      }
      publicationTemporaryExists = false;
      fsyncSync(publicationParentDescriptor);
      fsyncSync(targetParentDescriptor);

      const publishedDescriptor = openAt(
        runtime,
        targetParentDescriptor,
        targetName,
        posixTargetFlags(false),
      );
      heldDescriptors.push(publishedDescriptor);
      const publishedTarget = checkedPosixTarget(publishedDescriptor);
      if (!sameIdentity(publishedTarget.identity, temporaryTarget.identity)) {
        throw new AnchoredFileAuthorityError("identity_changed");
      }
      if (
        digest(readPosixContent(publishedDescriptor, publishedTarget.contentSize)) !==
        digest(content)
      ) {
        throw new AnchoredFileAuthorityError("content_changed");
      }
      resultFileIdentity = publishedTarget.identity;
      contentSha256 = digest(content);
    } else {
      if (request.expected) {
        const existing = readPosixContent(finalTargetDescriptor!, finalTarget!.contentSize);
        if (digest(existing) !== request.expected.contentSha256) {
          throw new AnchoredFileAuthorityError("content_changed");
        }
      }
      writePosixContent(finalTargetDescriptor!, content);
      const after = checkedPosixTarget(finalTargetDescriptor!);
      if (!sameIdentity(after.identity, finalTarget!.identity)) {
        throw new AnchoredFileAuthorityError("identity_changed");
      }
      resultFileIdentity = finalTarget!.identity;
      contentSha256 = digest(content);
    }

    return {
      root: finalChain.identities[0]!,
      file: resultFileIdentity,
      contentSha256,
    };
  } catch (error) {
    if (error instanceof AnchoredFileAuthorityError) throw error;
    throw new AnchoredFileAuthorityError("mutation_failed");
  } finally {
    if (
      publicationTemporaryExists &&
      publicationParentDescriptor !== null &&
      publicationTemporaryName
    ) {
      try {
        const cleanupDescriptor = openAt(
          runtime,
          publicationParentDescriptor,
          publicationTemporaryName,
          posixTargetFlags(false),
        );
        heldDescriptors.push(cleanupDescriptor);
        const cleanupTarget = checkedPosixTarget(cleanupDescriptor);
        if (
          !publicationTemporaryIdentity ||
          !sameIdentity(cleanupTarget.identity, publicationTemporaryIdentity)
        ) {
          throw new AnchoredFileAuthorityError("identity_changed");
        }
        unlinkAt(runtime, publicationParentDescriptor, publicationTemporaryName);
      } catch {
        // Preserve the primary authority result; the random file remains under
        // the still-held manager-state root if the filesystem rejects cleanup.
      }
    }
    closeFileDescriptors(heldDescriptors);
  }
}

async function loadWindowsRuntime() {
  try {
    const ffi = await import("bun:ffi");
    const native = ffi.dlopen("kernel32.dll", {
      CreateFileW: {
        args: ["ptr", "u32", "u32", "ptr", "u32", "u32", "ptr"],
        returns: "ptr",
      },
      GetFileInformationByHandle: {
        args: ["ptr", "ptr"],
        returns: "i32",
      },
      SetFilePointerEx: {
        args: ["ptr", "i64", "ptr", "u32"],
        returns: "i32",
      },
      SetEndOfFile: {
        args: ["ptr"],
        returns: "i32",
      },
      ReadFile: {
        args: ["ptr", "ptr", "u32", "ptr", "ptr"],
        returns: "i32",
      },
      WriteFile: {
        args: ["ptr", "ptr", "u32", "ptr", "ptr"],
        returns: "i32",
      },
      FlushFileBuffers: {
        args: ["ptr"],
        returns: "i32",
      },
      MoveFileExW: {
        args: ["ptr", "ptr", "u32"],
        returns: "i32",
      },
      SetFileInformationByHandle: {
        args: ["ptr", "i32", "ptr", "u32"],
        returns: "i32",
      },
      CloseHandle: {
        args: ["ptr"],
        returns: "i32",
      },
    } as const);
    return { symbols: native.symbols, ptr: ffi.ptr };
  } catch (error) {
    if (error instanceof AnchoredFileAuthorityError) throw error;
    throw new AnchoredFileAuthorityError("unsupported_platform");
  }
}

let windowsRuntimePromise: ReturnType<typeof loadWindowsRuntime> | null = null;

function windowsRuntime(): ReturnType<typeof loadWindowsRuntime> {
  windowsRuntimePromise ??= loadWindowsRuntime();
  return windowsRuntimePromise;
}

type WindowsRuntime = Awaited<ReturnType<typeof loadWindowsRuntime>>;
type WindowsHandle = Pointer;

const GENERIC_READ = 0x8000_0000;
const GENERIC_WRITE = 0x4000_0000;
const DELETE_ACCESS = 0x0001_0000;
const FILE_READ_ATTRIBUTES = 0x0000_0080;
const FILE_SHARE_READ = 0x0000_0001;
const FILE_SHARE_WRITE = 0x0000_0002;
const FILE_SHARE_DELETE = 0x0000_0004;
const CREATE_NEW = 1;
const OPEN_EXISTING = 3;
const MOVEFILE_REPLACE_EXISTING = 0x0000_0001;
const MOVEFILE_WRITE_THROUGH = 0x0000_0008;
const FILE_DISPOSITION_INFO_CLASS = 4;
const FILE_ATTRIBUTE_DIRECTORY = 0x0000_0010;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x0000_0400;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x0020_0000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x0200_0000;

interface WindowsFileInfo {
  identity: AnchoredFileIdentity;
  attributes: number;
  links: number;
  size: bigint;
}

interface WindowsChain {
  handles: WindowsHandle[];
  identities: AnchoredFileIdentity[];
}

function widePath(value: string): Buffer {
  return Buffer.from(`${path.toNamespacedPath(value)}\0`, "utf16le");
}

function validWindowsHandle(handle: Pointer | null): handle is Pointer {
  return typeof handle === "number" && Number.isSafeInteger(handle) && handle > 0;
}

function closeWindowsHandles(runtime: WindowsRuntime, handles: readonly WindowsHandle[]): void {
  for (const handle of [...handles].reverse()) {
    try {
      runtime.symbols.CloseHandle(handle);
    } catch {
      // The primary authority result must not be replaced by cleanup noise.
    }
  }
}

function releaseWindowsHandle(
  runtime: WindowsRuntime,
  handles: WindowsHandle[],
  handle: WindowsHandle,
): void {
  const index = handles.lastIndexOf(handle);
  if (index < 0 || !runtime.symbols.CloseHandle(handle)) {
    throw new AnchoredFileAuthorityError("mutation_failed");
  }
  handles.splice(index, 1);
}

function moveWindowsFile(
  runtime: WindowsRuntime,
  source: string,
  destination: string,
  replace: boolean,
): void {
  const encodedSource = widePath(source);
  const encodedDestination = widePath(destination);
  if (
    !runtime.symbols.MoveFileExW(
      runtime.ptr(encodedSource),
      runtime.ptr(encodedDestination),
      (replace ? MOVEFILE_REPLACE_EXISTING : 0) | MOVEFILE_WRITE_THROUGH,
    )
  ) {
    throw new AnchoredFileAuthorityError("mutation_failed");
  }
}

function markWindowsFileForDeletion(
  runtime: WindowsRuntime,
  handle: WindowsHandle,
): void {
  const disposition = Buffer.alloc(4);
  disposition.writeUInt32LE(1, 0);
  if (
    !runtime.symbols.SetFileInformationByHandle(
      handle,
      FILE_DISPOSITION_INFO_CLASS,
      runtime.ptr(disposition),
      disposition.length,
    )
  ) {
    throw new AnchoredFileAuthorityError("mutation_failed");
  }
}

function openWindowsHandle(
  runtime: WindowsRuntime,
  target: string,
  access: number,
  share: number,
  disposition: number,
  flags: number,
): WindowsHandle {
  const encoded = widePath(target);
  const handle = runtime.symbols.CreateFileW(
    runtime.ptr(encoded),
    access,
    share,
    null,
    disposition,
    flags,
    null,
  );
  if (!validWindowsHandle(handle)) {
    throw new AnchoredFileAuthorityError("target_unavailable");
  }
  return handle;
}

function windowsInfo(runtime: WindowsRuntime, handle: WindowsHandle): WindowsFileInfo {
  const buffer = Buffer.alloc(64);
  if (!runtime.symbols.GetFileInformationByHandle(handle, runtime.ptr(buffer))) {
    throw new AnchoredFileAuthorityError("containment_changed");
  }
  const attributes = buffer.readUInt32LE(0);
  const volume = buffer.readUInt32LE(28);
  const size = (BigInt(buffer.readUInt32LE(32)) << 32n) | BigInt(buffer.readUInt32LE(36));
  const links = buffer.readUInt32LE(40);
  const file = (BigInt(buffer.readUInt32LE(44)) << 32n) | BigInt(buffer.readUInt32LE(48));
  return {
    identity: { volume: String(volume), file: String(file) },
    attributes,
    links,
    size,
  };
}

function openWindowsChain(
  runtime: WindowsRuntime,
  root: string,
  directories: readonly string[],
): WindowsChain {
  const handles: WindowsHandle[] = [];
  const identities: AnchoredFileIdentity[] = [];
  try {
    let cursor = root;
    for (let index = 0; index <= directories.length; index += 1) {
      if (index > 0) cursor = path.join(cursor, directories[index - 1]!);
      const handle = openWindowsHandle(
        runtime,
        cursor,
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      );
      handles.push(handle);
      const info = windowsInfo(runtime, handle);
      if (
        !(info.attributes & FILE_ATTRIBUTE_DIRECTORY) ||
        info.attributes & FILE_ATTRIBUTE_REPARSE_POINT
      ) {
        throw new AnchoredFileAuthorityError("containment_changed");
      }
      identities.push(info.identity);
    }
    return { handles, identities };
  } catch (error) {
    closeWindowsHandles(runtime, handles);
    if (error instanceof AnchoredFileAuthorityError) throw error;
    throw new AnchoredFileAuthorityError("containment_changed");
  }
}

function sameWindowsChain(left: WindowsChain, right: WindowsChain): boolean {
  return (
    left.identities.length === right.identities.length &&
    left.identities.every((identity, index) => sameIdentity(identity, right.identities[index]!))
  );
}

function checkedWindowsTarget(runtime: WindowsRuntime, handle: WindowsHandle): WindowsFileInfo {
  const info = windowsInfo(runtime, handle);
  if (
    info.attributes & FILE_ATTRIBUTE_DIRECTORY ||
    info.attributes & FILE_ATTRIBUTE_REPARSE_POINT ||
    info.links !== 1
  ) {
    throw new AnchoredFileAuthorityError("containment_changed");
  }
  return info;
}

function setWindowsOffsetZero(runtime: WindowsRuntime, handle: WindowsHandle): void {
  if (!runtime.symbols.SetFilePointerEx(handle, 0n, null, 0)) {
    throw new AnchoredFileAuthorityError("mutation_failed");
  }
}

function readWindowsContent(
  runtime: WindowsRuntime,
  handle: WindowsHandle,
  size: bigint,
): Buffer {
  if (size > BigInt(MAX_AUTHORITY_CONTENT_BYTES)) {
    throw new AnchoredFileAuthorityError("content_changed");
  }
  setWindowsOffsetZero(runtime, handle);
  const content = Buffer.alloc(Number(size));
  if (content.length === 0) return content;
  const read = Buffer.alloc(4);
  if (!runtime.symbols.ReadFile(handle, runtime.ptr(content), content.length, runtime.ptr(read), null)) {
    throw new AnchoredFileAuthorityError("mutation_failed");
  }
  if (read.readUInt32LE(0) !== content.length) {
    throw new AnchoredFileAuthorityError("content_changed");
  }
  return content;
}

function writeWindowsContent(
  runtime: WindowsRuntime,
  handle: WindowsHandle,
  content: Buffer,
): void {
  setWindowsOffsetZero(runtime, handle);
  if (!runtime.symbols.SetEndOfFile(handle)) {
    throw new AnchoredFileAuthorityError("mutation_failed");
  }
  if (content.length > 0) {
    const written = Buffer.alloc(4);
    if (!runtime.symbols.WriteFile(handle, runtime.ptr(content), content.length, runtime.ptr(written), null)) {
      throw new AnchoredFileAuthorityError("mutation_failed");
    }
    if (written.readUInt32LE(0) !== content.length) {
      throw new AnchoredFileAuthorityError("mutation_failed");
    }
  }
  if (!runtime.symbols.FlushFileBuffers(handle)) {
    throw new AnchoredFileAuthorityError("mutation_failed");
  }
}

async function runWindowsAuthority(
  request: AnchoredFileAuthorityRequest,
  canonicalRoot: string,
  canonicalPublicationRoot: string | null,
  content: Buffer,
): Promise<AnchoredFileProof> {
  const runtime = await windowsRuntime();
  const directories = request.components.slice(0, -1);
  const target = path.join(canonicalRoot, ...request.components);
  const heldHandles: WindowsHandle[] = [];
  let publicationTemporaryPath: string | null = null;
  let publicationTemporaryHandle: WindowsHandle | null = null;
  let publicationTemporaryIdentity: AnchoredFileIdentity | null = null;
  let publicationTemporaryExists = false;
  try {
    const first = openWindowsChain(runtime, canonicalRoot, directories);
    heldHandles.push(...first.handles);
    const firstPublication = canonicalPublicationRoot
      ? openWindowsChain(runtime, canonicalPublicationRoot, [])
      : null;
    if (firstPublication) {
      heldHandles.push(...firstPublication.handles);
      if (firstPublication.identities[0]!.volume !== first.identities[0]!.volume) {
        throw new AnchoredFileAuthorityError("mutation_failed");
      }
    }
    let firstTargetHandle: WindowsHandle | null = null;
    let firstTarget: WindowsFileInfo | null = null;
    if (request.operation !== "create") {
      firstTargetHandle = openWindowsHandle(
        runtime,
        target,
        (GENERIC_READ | FILE_READ_ATTRIBUTES) >>> 0,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
      );
      heldHandles.push(firstTargetHandle);
      firstTarget = checkedWindowsTarget(runtime, firstTargetHandle);
      if (
        request.expected &&
        (!sameIdentity(first.identities[0]!, request.expected.root) ||
          !sameIdentity(firstTarget.identity, request.expected.file))
      ) {
        throw new AnchoredFileAuthorityError("identity_changed");
      }
    }

    await request.lifecycle?.beforeFinalTraversal?.();

    const finalChain = openWindowsChain(runtime, canonicalRoot, directories);
    heldHandles.push(...finalChain.handles);
    if (!sameWindowsChain(first, finalChain)) {
      throw new AnchoredFileAuthorityError("containment_changed");
    }
    const finalPublication = canonicalPublicationRoot
      ? openWindowsChain(runtime, canonicalPublicationRoot, [])
      : null;
    if (finalPublication) {
      heldHandles.push(...finalPublication.handles);
      if (
        !firstPublication ||
        !sameWindowsChain(firstPublication, finalPublication) ||
        finalPublication.identities[0]!.volume !== finalChain.identities[0]!.volume
      ) {
        throw new AnchoredFileAuthorityError("containment_changed");
      }
    }

    let finalTargetHandle: WindowsHandle | null = null;
    let finalTarget: WindowsFileInfo | null = null;
    if (request.operation !== "create") {
      finalTargetHandle = openWindowsHandle(
        runtime,
        target,
        request.operation === "replace"
          ? (GENERIC_READ | GENERIC_WRITE | FILE_READ_ATTRIBUTES) >>> 0
          : (GENERIC_READ | FILE_READ_ATTRIBUTES) >>> 0,
        FILE_SHARE_READ,
        OPEN_EXISTING,
        FILE_FLAG_OPEN_REPARSE_POINT,
      );
      heldHandles.push(finalTargetHandle);
      finalTarget = checkedWindowsTarget(runtime, finalTargetHandle);
      if (firstTarget && !sameIdentity(firstTarget.identity, finalTarget.identity)) {
        throw new AnchoredFileAuthorityError("identity_changed");
      }
      if (
        request.expected &&
        (!sameIdentity(finalChain.identities[0]!, request.expected.root) ||
          !sameIdentity(finalTarget.identity, request.expected.file))
      ) {
        throw new AnchoredFileAuthorityError("identity_changed");
      }
    }

    let resultFileIdentity: AnchoredFileIdentity;
    let contentSha256: string;
    if (request.operation === "verify") {
      contentSha256 = digest(
        readWindowsContent(runtime, finalTargetHandle!, finalTarget!.size),
      );
      if (!sameProof(
        {
          root: finalChain.identities[0]!,
          file: finalTarget!.identity,
          contentSha256,
        },
        request.expected!,
      )) {
        throw new AnchoredFileAuthorityError("content_changed");
      }
      resultFileIdentity = finalTarget!.identity;
    } else if (request.operation === "create" || request.operation === "publish") {
        publicationTemporaryPath = path.join(
          canonicalPublicationRoot!,
          publicationTemporaryComponent(),
        );
        publicationTemporaryHandle = openWindowsHandle(
          runtime,
          publicationTemporaryPath,
          (GENERIC_READ | GENERIC_WRITE | DELETE_ACCESS | FILE_READ_ATTRIBUTES) >>> 0,
          FILE_SHARE_READ,
          CREATE_NEW,
          FILE_FLAG_OPEN_REPARSE_POINT,
        );
        heldHandles.push(publicationTemporaryHandle);
        publicationTemporaryExists = true;
        const temporaryTarget = checkedWindowsTarget(runtime, publicationTemporaryHandle);
        publicationTemporaryIdentity = temporaryTarget.identity;
        writeWindowsContent(runtime, publicationTemporaryHandle, content);

        await request.lifecycle?.beforePublication?.();

        if (request.operation === "publish") {
          const pendingTarget = checkedWindowsTarget(runtime, finalTargetHandle!);
          if (
            !sameIdentity(pendingTarget.identity, request.expected!.file) ||
            digest(readWindowsContent(runtime, finalTargetHandle!, pendingTarget.size)) !==
              request.expected!.contentSha256
          ) {
            throw new AnchoredFileAuthorityError("content_changed");
          }
        }
        const durableTemporary = checkedWindowsTarget(runtime, publicationTemporaryHandle);
        if (
          !sameIdentity(durableTemporary.identity, temporaryTarget.identity) ||
          digest(
            readWindowsContent(runtime, publicationTemporaryHandle, durableTemporary.size),
          ) !== digest(content)
        ) {
          throw new AnchoredFileAuthorityError("content_changed");
        }

        releaseWindowsHandle(runtime, heldHandles, publicationTemporaryHandle);
        publicationTemporaryHandle = null;
        if (request.operation === "publish") {
          releaseWindowsHandle(runtime, heldHandles, finalTargetHandle!);
          finalTargetHandle = null;
          if (firstTargetHandle) {
            releaseWindowsHandle(runtime, heldHandles, firstTargetHandle);
            firstTargetHandle = null;
          }
        }
        moveWindowsFile(
          runtime,
          publicationTemporaryPath,
          target,
          request.operation === "publish",
        );
        publicationTemporaryExists = false;

        const publishedHandle = openWindowsHandle(
          runtime,
          target,
          (GENERIC_READ | FILE_READ_ATTRIBUTES) >>> 0,
          FILE_SHARE_READ,
          OPEN_EXISTING,
          FILE_FLAG_OPEN_REPARSE_POINT,
        );
        heldHandles.push(publishedHandle);
        const publishedTarget = checkedWindowsTarget(runtime, publishedHandle);
        if (!sameIdentity(publishedTarget.identity, temporaryTarget.identity)) {
          throw new AnchoredFileAuthorityError("identity_changed");
        }
        if (
          digest(readWindowsContent(runtime, publishedHandle, publishedTarget.size)) !==
          digest(content)
        ) {
          throw new AnchoredFileAuthorityError("content_changed");
        }
        resultFileIdentity = publishedTarget.identity;
        contentSha256 = digest(content);
    } else {
      if (request.expected) {
        const existing = readWindowsContent(runtime, finalTargetHandle!, finalTarget!.size);
        if (digest(existing) !== request.expected.contentSha256) {
          throw new AnchoredFileAuthorityError("content_changed");
        }
      }
      writeWindowsContent(runtime, finalTargetHandle!, content);
      const after = checkedWindowsTarget(runtime, finalTargetHandle!);
      if (!sameIdentity(after.identity, finalTarget!.identity)) {
        throw new AnchoredFileAuthorityError("identity_changed");
      }
      resultFileIdentity = finalTarget!.identity;
      contentSha256 = digest(content);
    }

    return {
      root: finalChain.identities[0]!,
      file: resultFileIdentity,
      contentSha256,
    };
  } catch (error) {
    if (error instanceof AnchoredFileAuthorityError) throw error;
    throw new AnchoredFileAuthorityError("mutation_failed");
  } finally {
    if (publicationTemporaryExists && publicationTemporaryPath) {
      try {
        if (
          !publicationTemporaryHandle ||
          !heldHandles.includes(publicationTemporaryHandle)
        ) {
          publicationTemporaryHandle = openWindowsHandle(
            runtime,
            publicationTemporaryPath,
            DELETE_ACCESS | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT,
          );
          heldHandles.push(publicationTemporaryHandle);
        }
        const cleanupTarget = checkedWindowsTarget(runtime, publicationTemporaryHandle);
        if (
          !publicationTemporaryIdentity ||
          !sameIdentity(cleanupTarget.identity, publicationTemporaryIdentity)
        ) {
          throw new AnchoredFileAuthorityError("identity_changed");
        }
        markWindowsFileForDeletion(runtime, publicationTemporaryHandle);
      } catch {
        // Preserve the primary authority result; the random file remains under
        // the still-held manager-state root if the filesystem rejects cleanup.
      }
    }
    closeWindowsHandles(runtime, heldHandles);
  }
}

/** Execute one root-anchored create, replacement, atomic publication, or verification. */
export async function runAnchoredFileAuthority(
  request: AnchoredFileAuthorityRequest,
): Promise<AnchoredFileProof> {
  const content = validateRequest(request);
  const canonicalRoot = await realpath(request.root).catch(() => null);
  if (!canonicalRoot || !samePath(canonicalRoot, request.root)) {
    throw new AnchoredFileAuthorityError("invalid_request");
  }
  const canonicalPublicationRoot = request.publicationRoot
    ? await realpath(request.publicationRoot).catch(() => null)
    : null;
  if (
    request.publicationRoot &&
    (!canonicalPublicationRoot ||
      !samePath(canonicalPublicationRoot, request.publicationRoot) ||
      containsPath(canonicalRoot, canonicalPublicationRoot) ||
      containsPath(canonicalPublicationRoot, canonicalRoot))
  ) {
    throw new AnchoredFileAuthorityError("invalid_request");
  }
  if (process.platform === "win32") {
    return runWindowsAuthority(request, canonicalRoot, canonicalPublicationRoot, content);
  }
  if (process.platform === "linux" || process.platform === "darwin") {
    return runPosixAuthority(request, canonicalRoot, canonicalPublicationRoot, content);
  }
  throw new AnchoredFileAuthorityError("unsupported_platform");
}
