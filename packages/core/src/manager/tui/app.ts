import readline from "node:readline";
import type { SharedState } from "../state";
import type { SessionDescriptor, SessionMode, SessionTranscript, TranscriptMessage } from "../../harness/session";
import { loadTranscript, switchSessionProvider } from "../../harness/session";
import { createTuiTools, runSessionTurnWithTools, type AgentToolContext, type ProviderListing } from "../../harness/tools";
import { providerSessionAdapter } from "../session-adapters";
import { doctorAdapter, type CliId } from "../adapters";
import { createStatusBarState, currentModel, currentProvider, statusBarLabel, statusBarReducer } from "./reducer";
import type { KeyAction } from "./input";
import { ANSI, moveCursor, padOrTruncate, restoreScreen, saveScreen, visibleLength, wrapText } from "./ansi";
import { updateSessionConfig } from "../state";
import type { OrchestratorHeartbeatController } from "../orchestrator";

export interface TuiAppOptions {
  state: SharedState;
  descriptor: SessionDescriptor;
  providers?: string[];
  modelsByProvider?: Record<string, string[]>;
  systemPrompt?: string;
  orchestrator?: OrchestratorHeartbeatController | null;
}

interface Dimensions {
  width: number;
  height: number;
}

export class TuiApp {
  private state: SharedState;
  private descriptor: SessionDescriptor;
  private statusState: ReturnType<typeof createStatusBarState>;
  private messages: TranscriptMessage[] = [];
  private input = "";
  private cursor = 0;
  private scrollOffset = 0;
  private dims: Dimensions = { width: 80, height: 24 };
  private running = false;
  private turnInFlight = false;
  private stdout: NodeJS.WriteStream;
  private stderr: NodeJS.WriteStream;
  private onResize: () => void;
  private onKeypress: (str: string, key: readline.Key) => void;
  private onSigint: () => void;
  private onSigterm: () => void;
  private resolveExit?: () => void;
  private tools = createTuiTools();
  private systemPrompt?: string;
  private orchestrator?: OrchestratorHeartbeatController | null;

  constructor(options: TuiAppOptions) {
    this.state = options.state;
    this.descriptor = options.descriptor;
    this.systemPrompt = options.systemPrompt;
    this.orchestrator = options.orchestrator;
    this.stdout = process.stdout;
    this.stderr = process.stderr;

    const providers = options.providers ?? [this.descriptor.provider];
    const modelsByProvider = options.modelsByProvider ?? {
      [this.descriptor.provider]: [this.descriptor.model],
    };

    this.statusState = createStatusBarState({
      providers,
      modelsByProvider,
      provider: this.descriptor.provider,
      model: this.descriptor.model,
      mode: this.descriptor.mode,
    });

    this.onResize = () => this.handleResize();
    this.onKeypress = (str, key) => this.handleKeypress(str, key);
    this.onSigint = () => this.stop();
    this.onSigterm = () => this.stop();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const transcript = await loadTranscript(this.state, this.descriptor.sessionId);
    if (transcript) {
      this.messages = transcript.messages;
    }

    this.updateDimensions();
    this.setupInput();
    this.render();

    return new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.teardownInput();
    this.stdout.write(restoreScreen() + ANSI.showCursor);
    if (this.resolveExit) {
      this.resolveExit();
      this.resolveExit = undefined;
    }
  }

  private setupInput(): void {
    if (this.stdout.isTTY) {
      this.stdout.write(saveScreen() + ANSI.hideCursor);
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on("keypress", this.onKeypress);
    process.stdout.on("resize", this.onResize);
    process.on("SIGINT", this.onSigint);
    process.on("SIGTERM", this.onSigterm);
  }

  private teardownInput(): void {
    process.stdin.removeListener("keypress", this.onKeypress);
    process.stdout.removeListener("resize", this.onResize);
    process.removeListener("SIGINT", this.onSigint);
    process.removeListener("SIGTERM", this.onSigterm);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }

  private updateDimensions(): void {
    this.dims = {
      width: this.stdout.columns || 80,
      height: this.stdout.rows || 24,
    };
  }

  private handleResize(): void {
    this.updateDimensions();
    this.render();
  }

  private handleKeypress(_str: string, key: readline.Key): void {
    const action = tuiKeyToAction(key);
    this.dispatch(action);
  }

  dispatch(action: KeyAction): void {
    switch (action.type) {
      case "quit":
        this.stop();
        return;
      case "cycle-provider":
        this.statusState = statusBarReducer(this.statusState, { type: "cycle-provider" });
        this.persistProviderSwitch();
        this.render();
        return;
      case "cycle-model":
        this.statusState = statusBarReducer(this.statusState, { type: "cycle-model" });
        this.persistProviderSwitch();
        this.render();
        return;
      case "submit":
        this.submitInput();
        return;
      case "backspace":
        if (this.cursor > 0) {
          this.input = this.input.slice(0, this.cursor - 1) + this.input.slice(this.cursor);
          this.cursor -= 1;
        }
        break;
      case "delete":
        if (this.cursor < this.input.length) {
          this.input = this.input.slice(0, this.cursor) + this.input.slice(this.cursor + 1);
        }
        break;
      case "cursor-left":
        if (this.cursor > 0) this.cursor -= 1;
        break;
      case "cursor-right":
        if (this.cursor < this.input.length) this.cursor += 1;
        break;
      case "cursor-home":
        this.cursor = 0;
        break;
      case "cursor-end":
        this.cursor = this.input.length;
        break;
      case "scroll-up":
        if (this.scrollOffset > 0) this.scrollOffset -= 1;
        break;
      case "scroll-down":
        this.scrollOffset += 1;
        break;
      case "insert":
        this.input = this.input.slice(0, this.cursor) + action.char + this.input.slice(this.cursor);
        this.cursor += action.char.length;
        break;
      case "noop":
        return;
    }
    this.render();
  }

  private async persistProviderSwitch(): Promise<void> {
    const provider = currentProvider(this.statusState);
    const model = currentModel(this.statusState);
    if (provider === this.descriptor.provider && model === this.descriptor.model) return;
    try {
      this.descriptor = await switchSessionProvider(this.state, this.descriptor.sessionId, provider, model);
      await this.orchestrator?.update({ provider, model });
      await updateSessionConfig(this.state, (config) => ({ ...config, defaultProvider: provider, defaultModel: model }));
    } catch (error) {
      this.statusState = statusBarReducer(this.statusState, {
        type: "set-status",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async submitInput(): Promise<void> {
    const prompt = this.input.trim();
    if (!prompt || this.turnInFlight) return;

    this.turnInFlight = true;
    this.messages = [...this.messages, { role: "user", content: prompt }];
    this.input = "";
    this.cursor = 0;
    this.statusState = statusBarReducer(this.statusState, { type: "set-status", status: "running" });
    this.scrollToBottom();
    this.render();

    try {
      await this.runToolTurn(prompt);
      this.statusState = statusBarReducer(this.statusState, { type: "set-status", status: "idle" });
    } catch (error) {
      this.messages = [
        ...this.messages,
        { role: "assistant", content: error instanceof Error ? error.message : String(error), metadata: { error: true } },
      ];
      this.statusState = statusBarReducer(this.statusState, {
        type: "set-status",
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this.turnInFlight = false;
      this.scrollToBottom();
      this.render();
    }
  }

  private buildToolContext(): AgentToolContext {
    const ctx: AgentToolContext = {
      state: this.state,
      descriptor: this.descriptor,
      status: (message) => {
        this.statusState = statusBarReducer(this.statusState, { type: "set-status", status: "idle", message });
        this.render();
      },
      listProviders: async () => {
        const listings: ProviderListing[] = [];
        for (const id of this.statusState.providers) {
          const result = await doctorAdapter(this.state, id as CliId);
          listings.push({
            id,
            displayName: result.id,
            available: result.ok,
            models: this.statusState.modelsByProvider[id] ?? [],
            notes: result.notes,
          });
        }
        return listings;
      },
      switchProvider: async (provider, model) => {
        const configuredModel = model ?? this.statusState.modelsByProvider[provider]?.[0];
        if (!configuredModel) throw new Error(`provider ${provider} has no model in canonical config`);
        const desired = { ...ctx.descriptor, provider, model: configuredModel };
        this.descriptor = desired;
        ctx.descriptor = desired;
      },
    };
    return ctx;
  }

  private async runToolTurn(prompt: string): Promise<void> {
    const ctx = this.buildToolContext();
    const { result } = await runSessionTurnWithTools(this.state, this.descriptor, { prompt, systemPrompt: this.systemPrompt }, {
      tools: this.tools,
      ctx,
      resolveAdapter: async (descriptor) => {
        if (descriptor.provider === "fake") return providerSessionAdapter("fake");
        const result = await doctorAdapter(this.state, descriptor.provider as CliId);
        if (!result.binary) {
          throw new Error(
            `provider ${descriptor.provider} is not ready: ${result.notes.join("; ") || "no verified pinned binary"}`,
          );
        }
        return providerSessionAdapter(descriptor.provider, result.binary);
      },
    });
    this.descriptor = ctx.descriptor;
    await this.orchestrator?.update({ provider: this.descriptor.provider, model: this.descriptor.model });
    await updateSessionConfig(this.state, (config) => ({
      ...config,
      defaultProvider: this.descriptor.provider,
      defaultModel: this.descriptor.model,
    }));
    this.statusState = statusBarReducer(this.statusState, { type: "set-provider", provider: this.descriptor.provider });
    this.statusState = statusBarReducer(this.statusState, { type: "set-model", model: this.descriptor.model });
    if (result.usage) {
      this.statusState = statusBarReducer(this.statusState, { type: "update-usage", usage: result.usage });
    }
    if (result.error) {
      this.statusState = statusBarReducer(this.statusState, {
        type: "set-status",
        status: "error",
        message: result.error,
      });
    }
    const transcript = await loadTranscript(this.state, this.descriptor.sessionId);
    if (transcript) this.messages = transcript.messages;
  }

  private scrollToBottom(): void {
    this.scrollOffset = Number.MAX_SAFE_INTEGER;
  }

  private render(): void {
    if (!this.stdout.isTTY) return;

    const { width, height } = this.dims;
    const statusHeight = 1;
    const inputHeight = 1;
    const transcriptHeight = Math.max(1, height - statusHeight - inputHeight);

    const lines: string[] = [];

    // Status bar (top).
    const statusText = statusBarLabel(this.statusState);
    lines.push(ANSI.inverse + padOrTruncate(statusText, width) + ANSI.reset);

    // Transcript pane.
    const transcriptLines = this.buildTranscriptLines(width, transcriptHeight);
    const visibleStart = Math.max(0, Math.min(this.scrollOffset, Math.max(0, transcriptLines.length - transcriptHeight)));
    this.scrollOffset = visibleStart;
    for (let i = 0; i < transcriptHeight; i += 1) {
      const line = transcriptLines[visibleStart + i] ?? "";
      lines.push(padOrTruncate(line, width));
    }

    // Input line.
    const prompt = "> ";
    const inputDisplay = prompt + this.input;
    lines.push(padOrTruncate(inputDisplay, width));

    // Build frame.
    const frame = ANSI.clear + ANSI.home + lines.map((line) => padOrTruncate(line, width)).join("\r\n");
    this.stdout.write(frame);

    // Place cursor on input line after the prompt.
    const cursorX = Math.min(prompt.length + this.cursor, width - 1);
    const cursorY = height - 1;
    this.stdout.write(moveCursor(cursorX, cursorY) + ANSI.showCursor);
  }

  private buildTranscriptLines(width: number, maxHeight: number): string[] {
    const lines: string[] = [];
    for (const message of this.messages) {
      const prefix = message.role === "user" ? "You: " : message.role === "assistant" ? "AI:  " : `${message.role}: `;
      const color = message.role === "user" ? ANSI.fg.cyan : message.role === "assistant" ? ANSI.fg.green : ANSI.fg.gray;
      const text = `${color}${prefix}${ANSI.reset}${message.content}`;
      const wrapped = wrapText(text, width - 2);
      for (const line of wrapped) {
        lines.push(`  ${line}`);
      }
      // Empty line between messages.
      if (lines.length > 0) lines.push("");
    }
    // Trim trailing blank lines.
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  }
}

function tuiKeyToAction(key: readline.Key): KeyAction {
  const name = key.name ?? "";
  if (key.ctrl && name === "c") return { type: "quit" };
  if (name === "escape") return { type: "quit" };
  if (key.ctrl && name === "p") return { type: "cycle-provider" };
  if (key.ctrl && name === "m") return { type: "cycle-model" };
  if (name === "return" || name === "enter") return { type: "submit" };
  if (name === "backspace") return { type: "backspace" };
  if (name === "delete") return { type: "delete" };
  if (name === "left") return { type: "cursor-left" };
  if (name === "right") return { type: "cursor-right" };
  if (name === "home") return { type: "cursor-home" };
  if (name === "end") return { type: "cursor-end" };
  if (name === "up" || name === "pageup") return { type: "scroll-up" };
  if (name === "down" || name === "pagedown") return { type: "scroll-down" };
  if (key.sequence && key.sequence.length === 1 && !key.ctrl && !key.meta) {
    return { type: "insert", char: key.sequence };
  }
  return { type: "noop" };
}
