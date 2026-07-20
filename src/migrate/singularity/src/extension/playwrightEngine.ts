import { type LaunchedChrome, Launcher, killAll, launch } from "chrome-launcher";
import { type Browser, type BrowserContext, type Page, chromium } from "playwright-core";
import * as vscode from "vscode";
import { type MessageEnvelope, MessageType } from "../shared/protocol.js";
import type { EngineTransport } from "./engineTransport.js";

const MAX_PAGE_CRASH_RETRIES = 3;

export interface PlaywrightEngineOptions {
  outputChannel: vscode.OutputChannel;
}

interface PageHandle {
  projectId: string;
  page: Page;
  origin: string;
  transport: PlaywrightEngineTransport;
}

class PlaywrightEngineTransport implements EngineTransport {
  private _onDidReceiveMessage = new vscode.EventEmitter<MessageEnvelope>();
  public readonly onDidReceiveMessage = this._onDidReceiveMessage.event;

  private _onDidDispose = new vscode.EventEmitter<void>();
  public readonly onDidDispose = this._onDidDispose.event;

  private disposed = false;

  constructor(
    private page: Page,
    private projectId: string,
  ) {}

  setPage(page: Page): void {
    if (this.disposed) return;
    this.page = page;
  }

  postMessage(message: MessageEnvelope): void {
    if (this.disposed) return;
    void this.page
      .evaluate((envelope) => {
        const receive = (window as unknown as Record<string, unknown>)
          .vsdawReceiveMessage as unknown as ((msg: MessageEnvelope) => void) | undefined;
        if (typeof receive === "function") {
          receive(envelope);
        }
      }, message)
      .catch((error) => {
        console.warn(`[playwright] failed to deliver message to ${this.projectId}:`, error);
      });
  }

  receiveMessage(message: MessageEnvelope): void {
    if (this.disposed) return;
    this._onDidReceiveMessage.fire(message);
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this._onDidReceiveMessage.dispose();
    this._onDidDispose.fire();
    this._onDidDispose.dispose();
  }
}

function detectChromeInstallation(): string | undefined {
  try {
    const installations = Launcher.getInstallations();
    return installations[0];
  } catch {
    return undefined;
  }
}

export class PlaywrightEngineManager implements vscode.Disposable {
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private chrome: LaunchedChrome | undefined;
  private pages = new Map<string, PageHandle>();
  private crashRetries = new Map<string, number>();
  private _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;
  private starting = false;
  private stopping = false;
  private disposed = false;

  constructor(private options: PlaywrightEngineOptions) {}

  get isRunning(): boolean {
    return this.browser !== undefined && this.context !== undefined;
  }

  get projectCount(): number {
    return this.pages.size;
  }

  async start(): Promise<void> {
    if (this.disposed) {
      throw new Error("Playwright engine manager has been disposed");
    }
    if (this.isRunning || this.starting) return;
    this.starting = true;
    try {
      const chromePath = detectChromeInstallation();
      if (!chromePath) {
        const message =
          "VSDAW could not find a Chromium-based browser (Google Chrome, Microsoft Edge, or Chromium). The audio engine requires one to run.";
        const selected = await vscode.window.showErrorMessage(
          message,
          "Install Google Chrome",
          "Install Microsoft Edge",
          "Install Chromium",
        );
        const url =
          selected === "Install Google Chrome"
            ? "https://www.google.com/chrome/"
            : selected === "Install Microsoft Edge"
              ? "https://www.microsoft.com/edge"
              : selected === "Install Chromium"
                ? "https://www.chromium.org/getting-involved/download-chromium/"
                : undefined;
        if (url) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
        throw new Error(message);
      }

      this.options.outputChannel.appendLine(`[playwright] launching Chrome from ${chromePath}`);

      const chrome = await launch({
        startingUrl: "about:blank",
        chromeFlags: [
          "--headless=new",
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-gpu",
          "--disable-dev-shm-usage",
          "--disable-background-timer-throttling",
          "--disable-renderer-backgrounding",
          "--autoplay-policy=no-user-gesture-required",
          "--window-size=1280,720",
        ],
      });

      this.chrome = chrome;
      this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${chrome.port}`);
      this.context = this.browser.contexts()[0] ?? (await this.browser.newContext());
      this.options.outputChannel.appendLine(
        `[playwright] connected to Chrome on port ${chrome.port}`,
      );
      this._onDidChange.fire();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.outputChannel.appendLine(`[playwright] failed to start: ${message}`);
      throw error;
    } finally {
      this.starting = false;
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    try {
      for (const handle of this.pages.values()) {
        handle.transport.dispose();
        await handle.page.close().catch(() => {
          // ignore
        });
      }
      this.pages.clear();
      this.crashRetries.clear();

      if (this.context) {
        await this.context.close().catch(() => {
          // ignore
        });
        this.context = undefined;
      }

      if (this.browser) {
        await this.browser.close().catch(() => {
          // ignore
        });
        this.browser = undefined;
      }

      if (this.chrome) {
        try {
          this.chrome.kill();
        } catch {
          // ignore
        }
        this.chrome = undefined;
      }

      try {
        killAll();
      } catch {
        // ignore
      }

      this.options.outputChannel.appendLine("[playwright] stopped");
      this._onDidChange.fire();
    } finally {
      this.stopping = false;
    }
  }

  async createEngine(projectId: string, origin: string): Promise<EngineTransport> {
    if (this.disposed) {
      throw new Error("Playwright engine manager has been disposed");
    }
    if (!this.context) {
      await this.start();
    }
    if (!this.context) {
      throw new Error("Playwright engine context is not available");
    }

    const existing = this.pages.get(projectId);
    if (existing && !existing.transport.isDisposed()) {
      return existing.transport;
    }

    const page = await this.context.newPage();
    const transport = new PlaywrightEngineTransport(page, projectId);

    await this.bindPage(page, projectId, origin, transport);

    const handle: PageHandle = { projectId, page, origin, transport };
    this.pages.set(projectId, handle);

    page.on("close", () => {
      if (this.pages.get(projectId)?.page !== page) return;
      this.pages.delete(projectId);
      this.crashRetries.delete(projectId);
      transport.dispose();
      this._onDidChange.fire();
    });

    this._onDidChange.fire();
    return transport;
  }

  async healthCheck(projectId: string, origin: string): Promise<{ ok: true; elapsedMs: number }> {
    if (this.disposed) {
      throw new Error("Playwright engine manager has been disposed");
    }

    const transport = await this.createEngine(projectId, origin);
    const start = Date.now();

    console.log("healthCheck starting");
    return new Promise<{ ok: true; elapsedMs: number }>((resolve, reject) => {
      const timeout = setTimeout(() => {
        console.log("healthCheck timeout");
        subscription.dispose();
        reject(new Error("Engine health check timed out"));
      }, 5000);

      const subscription = transport.onDidReceiveMessage((message) => {
        console.log("manager received", message.type, MessageType.Pong);
        if (message.type === MessageType.Pong) {
          clearTimeout(timeout);
          subscription.dispose();
          resolve({ ok: true, elapsedMs: Date.now() - start });
        }
      });

      transport.postMessage({
        projectId,
        direction: "host-to-engine",
        type: MessageType.Ping,
        payload: {},
      });
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.stop();
    this._onDidChange.dispose();
  }

  private async bindPage(
    page: Page,
    projectId: string,
    origin: string,
    transport: PlaywrightEngineTransport,
  ): Promise<void> {
    await page.exposeFunction("vsdawSend", (raw: unknown) => {
      if (raw && typeof raw === "object") {
        transport.receiveMessage(raw as unknown as MessageEnvelope);
      }
    });

    page.on("crash", () => {
      if (this.pages.get(projectId)?.page !== page) return;
      this.options.outputChannel.appendLine(`[playwright] page crashed for ${projectId}`);
      void this.recreatePage(projectId, page);
    });

    page.on("pageerror", (error: Error) => {
      if (this.pages.get(projectId)?.page !== page) return;
      this.options.outputChannel.appendLine(
        `[playwright] page error for ${projectId}: ${error.message}`,
      );
    });

    await page.goto(`${origin}/engine?projectId=${encodeURIComponent(projectId)}`, {
      waitUntil: "load",
    });
  }

  private async recreatePage(projectId: string, crashedPage: Page): Promise<void> {
    const handle = this.pages.get(projectId);
    if (!handle || handle.page !== crashedPage) return;

    const retries = this.crashRetries.get(projectId) ?? 0;
    if (retries >= MAX_PAGE_CRASH_RETRIES) {
      this.options.outputChannel.appendLine(
        `[playwright] page for ${projectId} crashed too many times; giving up`,
      );
      handle.transport.dispose();
      this.pages.delete(projectId);
      this.crashRetries.delete(projectId);
      this._onDidChange.fire();
      return;
    }

    this.crashRetries.set(projectId, retries + 1);
    this.options.outputChannel.appendLine(
      `[playwright] recreating page for ${projectId} (attempt ${retries + 1}/${MAX_PAGE_CRASH_RETRIES})`,
    );

    try {
      await crashedPage.close().catch(() => {
        // ignore
      });
      if (!this.context) {
        throw new Error("Playwright engine context is not available");
      }
      const newPage = await this.context.newPage();
      await this.bindPage(newPage, projectId, handle.origin, handle.transport);
      handle.page = newPage;
      handle.transport.setPage(newPage);
      this.crashRetries.delete(projectId);
      this.options.outputChannel.appendLine(`[playwright] page recreated for ${projectId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.outputChannel.appendLine(
        `[playwright] failed to recreate page for ${projectId}: ${message}`,
      );
      handle.transport.dispose();
      this.pages.delete(projectId);
      this.crashRetries.delete(projectId);
      this._onDidChange.fire();
    }
  }
}
