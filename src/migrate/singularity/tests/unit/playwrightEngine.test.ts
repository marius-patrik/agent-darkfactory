import { Launcher, killAll, launch } from "chrome-launcher";
import { chromium } from "playwright-core";
import type { Page } from "playwright-core";
import * as vscode from "vscode";
import { PlaywrightEngineManager } from "../../src/extension/playwrightEngine";
import { MessageType } from "../../src/shared/protocol";

jest.mock("chrome-launcher", () => ({
  Launcher: { getInstallations: jest.fn() },
  launch: jest.fn(),
  killAll: jest.fn(),
}));

jest.mock("playwright-core", () => ({
  chromium: { connectOverCDP: jest.fn() },
}));

interface MockPage {
  on: jest.Mock<void, [string, (...args: unknown[]) => void]>;
  evaluate: jest.Mock<Promise<unknown>, [unknown, unknown?]>;
  exposeFunction: jest.Mock<Promise<void>, [string, (...args: unknown[]) => unknown]>;
  goto: jest.Mock<Promise<unknown>, [string, object?]>;
  close: jest.Mock<Promise<void>, []>;
  _handlers: Record<string, Array<(...args: unknown[]) => void>>;
}

const mockedLauncher = Launcher as unknown as { getInstallations: jest.Mock };
const mockedLaunch = launch as jest.Mock;
const mockedKillAll = killAll as jest.Mock;
const mockedChromium = chromium as unknown as { connectOverCDP: jest.Mock };

function createMockOutputChannel(): vscode.OutputChannel {
  return vscode.window.createOutputChannel("test") as unknown as vscode.OutputChannel;
}

function createMockPage(): MockPage {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  return {
    on: jest.fn((_event: string, handler: (...args: unknown[]) => void) => {
      handlers[_event] ??= [];
      handlers[_event].push(handler);
    }) as MockPage["on"],
    evaluate: jest.fn().mockResolvedValue(undefined),
    exposeFunction: jest.fn().mockResolvedValue(undefined),
    goto: jest.fn().mockResolvedValue(undefined),
    close: jest.fn().mockResolvedValue(undefined),
    _handlers: handlers,
  };
}

function createMockContext(pages: MockPage[] = []) {
  let pageIndex = 0;
  return {
    newPage: jest.fn().mockImplementation(() => {
      const next = (pages[pageIndex++] ?? createMockPage()) as unknown as Page;
      return Promise.resolve(next);
    }),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockBrowser(context?: ReturnType<typeof createMockContext>) {
  return {
    contexts: jest.fn().mockReturnValue(context ? [context] : []),
    newContext: jest.fn().mockResolvedValue(context ?? createMockContext()),
    close: jest.fn().mockResolvedValue(undefined),
  };
}

function createMockChrome() {
  return {
    pid: 123,
    port: 9222,
    process: { kill: jest.fn() },
    remoteDebuggingPipes: null,
    kill: jest.fn(),
  };
}

describe("PlaywrightEngineManager", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedLauncher.getInstallations.mockReturnValue([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]);
  });

  test("throws a clear error when Chrome is not installed and shows install prompt", async () => {
    mockedLauncher.getInstallations.mockReturnValue([]);
    const manager = new PlaywrightEngineManager({
      outputChannel: createMockOutputChannel(),
    });

    await expect(manager.start()).rejects.toThrow(/could not find a Chromium-based browser/i);

    expect(vscode.window.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining("Chromium-based browser"),
      "Install Google Chrome",
      "Install Microsoft Edge",
      "Install Chromium",
    );
  });

  test("opens the selected browser install link", async () => {
    mockedLauncher.getInstallations.mockReturnValue([]);
    (vscode.window.showErrorMessage as jest.Mock).mockResolvedValue("Install Microsoft Edge");
    const manager = new PlaywrightEngineManager({
      outputChannel: createMockOutputChannel(),
    });

    await expect(manager.start()).rejects.toThrow();

    expect(vscode.env.openExternal).toHaveBeenCalledWith(
      expect.objectContaining({ path: "https://www.microsoft.com/edge" }),
    );
  });

  test("starts Chrome, connects over CDP, and stops cleanly", async () => {
    const chrome = createMockChrome();
    const context = createMockContext();
    const browser = createMockBrowser(context);
    mockedLaunch.mockResolvedValue(chrome);
    mockedChromium.connectOverCDP.mockResolvedValue(browser);

    const manager = new PlaywrightEngineManager({
      outputChannel: createMockOutputChannel(),
    });
    await manager.start();

    expect(mockedLaunch).toHaveBeenCalled();
    expect(mockedChromium.connectOverCDP).toHaveBeenCalledWith("http://127.0.0.1:9222");

    await manager.stop();

    expect(browser.close).toHaveBeenCalled();
    expect(chrome.kill).toHaveBeenCalled();
    expect(mockedKillAll).toHaveBeenCalled();
  });

  test("dispose guards against double-dispose", async () => {
    const chrome = createMockChrome();
    const context = createMockContext();
    const browser = createMockBrowser(context);
    mockedLaunch.mockResolvedValue(chrome);
    mockedChromium.connectOverCDP.mockResolvedValue(browser);

    const manager = new PlaywrightEngineManager({
      outputChannel: createMockOutputChannel(),
    });
    await manager.start();

    manager.dispose();
    await new Promise((resolve) => setImmediate(resolve));
    manager.dispose();
    manager.dispose();

    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(chrome.kill).toHaveBeenCalledTimes(1);
  });

  test("recreates a crashed page up to the retry limit", async () => {
    const chrome = createMockChrome();
    const pages: MockPage[] = [];
    for (let i = 0; i < 5; i++) pages.push(createMockPage());
    const context = createMockContext(pages);
    const browser = createMockBrowser(context);
    mockedLaunch.mockResolvedValue(chrome);
    mockedChromium.connectOverCDP.mockResolvedValue(browser);

    const outputChannel = createMockOutputChannel();
    const manager = new PlaywrightEngineManager({ outputChannel });
    await manager.start();

    const transport = await manager.createEngine("project-1", "http://127.0.0.1:8080");
    expect(transport).toBeDefined();
    expect(manager.projectCount).toBe(1);

    const firstPage = pages[0];
    expect(firstPage._handlers.crash).toHaveLength(1);

    // Fire four crash events in rapid succession before any recreation finishes.
    const crashHandler = firstPage._handlers.crash[0] as () => void;
    crashHandler();
    crashHandler();
    crashHandler();
    crashHandler();

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(manager.projectCount).toBe(0);

    const appendLine = (outputChannel as unknown as { appendLine: jest.Mock }).appendLine;
    expect(appendLine).toHaveBeenCalledWith(expect.stringContaining("crashed too many times"));

    await manager.stop();
  });

  test("logs page errors to the output channel", async () => {
    const chrome = createMockChrome();
    const page = createMockPage();
    const context = createMockContext([page]);
    const browser = createMockBrowser(context);
    mockedLaunch.mockResolvedValue(chrome);
    mockedChromium.connectOverCDP.mockResolvedValue(browser);

    const outputChannel = createMockOutputChannel();
    const manager = new PlaywrightEngineManager({ outputChannel });
    await manager.start();
    await manager.createEngine("project-1", "http://127.0.0.1:8080");

    const appendLine = (outputChannel as unknown as { appendLine: jest.Mock }).appendLine;
    (page._handlers.pageerror[0] as (error: Error) => void)(new Error("boom"));

    expect(appendLine).toHaveBeenCalledWith(
      expect.stringContaining("page error for project-1: boom"),
    );

    await manager.stop();
  });

  test("healthCheck sends ping and reports elapsed time on pong", async () => {
    const chrome = createMockChrome();
    const page = createMockPage();
    const context = createMockContext([page]);
    const browser = createMockBrowser(context);
    mockedLaunch.mockResolvedValue(chrome);
    mockedChromium.connectOverCDP.mockResolvedValue(browser);

    const manager = new PlaywrightEngineManager({
      outputChannel: createMockOutputChannel(),
    });
    await manager.start();
    const transport = await manager.createEngine("project-1", "http://127.0.0.1:8080");

    const healthPromise = manager.healthCheck("project-1", "http://127.0.0.1:8080");

    const receive = (page.exposeFunction as jest.Mock).mock.calls.find(
      ([name]: [string]) => name === "vsdawSend",
    )?.[1] as (msg: unknown) => void;

    const manualMessages: unknown[] = [];
    transport.onDidReceiveMessage((m) => manualMessages.push(m));

    // Give healthCheck a tick to subscribe before simulating the pong response.
    await new Promise((resolve) => setTimeout(resolve, 0));

    receive({
      projectId: "project-1",
      direction: "engine-to-host",
      type: MessageType.Pong,
      payload: { time: Date.now() },
    });

    console.log("manualMessages", manualMessages);
    console.log("MessageType.Pong", MessageType.Pong);

    await expect(healthPromise).resolves.toEqual({
      ok: true,
      elapsedMs: expect.any(Number),
    });

    const evaluateCalls = (page.evaluate as jest.Mock).mock.calls;
    const pingCall = evaluateCalls.find(
      ([, envelope]: [unknown, { type: string }]) => envelope?.type === MessageType.Ping,
    );
    expect(pingCall).toBeDefined();
  });
});
