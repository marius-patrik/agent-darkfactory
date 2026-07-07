import path from "node:path";
import fs from "node:fs";
import { mkdir } from "node:fs/promises";
import type {
  ProviderAdapter,
  SessionDescriptor,
  SessionTranscript,
  TurnRequest,
  TurnResult,
} from "../harness/session";
import { FakeProviderAdapter, renderTranscriptForCli } from "../harness/session-adapters";

export interface CliAdapterOptions {
  id: string;
  displayName: string;
  binary: string;
  buildArgs: (request: TurnRequest, transcript: SessionTranscript) => string[];
  supportsStreaming?: boolean;
  env?: Record<string, string>;
  cwd?: string;
  parseResult?: (stdout: string, stderr: string, code: number) => TurnResult;
}

function defaultParseResult(stdout: string, stderr: string, code: number): TurnResult {
  if (code !== 0) {
    return {
      content: "",
      role: "assistant",
      error: stderr.trim() || `provider exited with code ${code}`,
    };
  }
  return {
    content: stdout.trim(),
    role: "assistant",
    finishReason: "stop",
  };
}

export class CliProviderAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly supportsStreaming: boolean;
  private options: CliAdapterOptions;

  constructor(options: CliAdapterOptions) {
    this.id = options.id;
    this.displayName = options.displayName;
    this.supportsStreaming = options.supportsStreaming ?? false;
    this.options = options;
  }

  async startSession(descriptor: SessionDescriptor): Promise<void> {
    await mkdir(path.join(descriptor.stateDir, descriptor.sessionId), { recursive: true });
  }

  async continueSession(): Promise<void> {}

  async runTurn(
    descriptor: SessionDescriptor,
    transcript: SessionTranscript,
    request: TurnRequest,
  ): Promise<TurnResult> {
    const args = this.options.buildArgs(request, transcript);
    const cwd = this.options.cwd ?? descriptor.workdir;
    const env = { ...process.env, ...this.options.env };
    const proc = Bun.spawn([this.options.binary, ...args], {
      cwd,
      env,
      stdin: "inherit",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return (this.options.parseResult ?? defaultParseResult)(stdout, stderr, code);
  }
}

function findBinary(names: string[]): string | null {
  const pathValue =
    process.platform === "win32"
      ? [process.env.PATH, process.env.Path].filter((value): value is string => Boolean(value)).join(path.delimiter)
      : (process.env.PATH ?? "");
  const pathDirs = pathValue.split(path.delimiter).filter(Boolean);
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const name of names) {
    for (const dir of pathDirs) {
      for (const extension of extensions) {
        const candidate = path.join(
          dir,
          process.platform === "win32" && !path.extname(name) ? `${name}${extension.toLowerCase()}` : name,
        );
        if (fs.existsSync(candidate)) return candidate;
        const upperCandidate = path.join(
          dir,
          process.platform === "win32" && !path.extname(name) ? `${name}${extension.toUpperCase()}` : name,
        );
        if (fs.existsSync(upperCandidate)) return upperCandidate;
      }
    }
  }
  return null;
}

function transcriptAsPrompt(request: TurnRequest, transcript: SessionTranscript): string {
  const lines = renderTranscriptForCli(transcript);
  if (lines) return `${lines}\n\nUser: ${request.prompt}\nAssistant:`;
  return request.prompt;
}

export function kimiSessionAdapter(binaryOverride?: string): ProviderAdapter {
  const binary = binaryOverride ?? findBinary(["kimi", "kimi-code"]);
  if (!binary) throw new Error("kimi binary not found on PATH");
  return new CliProviderAdapter({
    id: "kimi",
    displayName: "Kimi",
    binary,
    buildArgs: (request, transcript) => ["ask", transcriptAsPrompt(request, transcript)],
  });
}

export function claudeSessionAdapter(binaryOverride?: string): ProviderAdapter {
  const binary = binaryOverride ?? findBinary(["claude"]);
  if (!binary) throw new Error("claude binary not found on PATH");
  return new CliProviderAdapter({
    id: "claude",
    displayName: "Claude",
    binary,
    buildArgs: (request, transcript) => ["-p", transcriptAsPrompt(request, transcript)],
  });
}

export function codexSessionAdapter(binaryOverride?: string): ProviderAdapter {
  const binary = binaryOverride ?? findBinary(["codex"]);
  if (!binary) throw new Error("codex binary not found on PATH");
  return new CliProviderAdapter({
    id: "codex",
    displayName: "Codex",
    binary,
    buildArgs: (request, transcript) => ["-q", transcriptAsPrompt(request, transcript)],
  });
}

export function agySessionAdapter(binaryOverride?: string): ProviderAdapter {
  const binary = binaryOverride ?? findBinary(["agy", "gemini"]);
  if (!binary) throw new Error("agy binary not found on PATH");
  return new CliProviderAdapter({
    id: "agy",
    displayName: "Agy",
    binary,
    buildArgs: (request, transcript) => [transcriptAsPrompt(request, transcript)],
  });
}

export function providerSessionAdapter(provider: string, binaryOverride?: string): ProviderAdapter {
  switch (provider) {
    case "kimi":
      return kimiSessionAdapter(binaryOverride);
    case "claude":
      return claudeSessionAdapter(binaryOverride);
    case "codex":
      return codexSessionAdapter(binaryOverride);
    case "agy":
      return agySessionAdapter(binaryOverride);
    case "fake":
      return new FakeProviderAdapter();
    default:
      throw new Error(`unknown session provider: ${provider}`);
  }
}
