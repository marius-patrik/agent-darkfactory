import {
  AudioWorklets,
  GlobalSampleLoaderManager,
  GlobalSoundfontLoaderManager,
  OfflineEngineRenderer,
  SampleService,
  SampleStorage,
  SoundfontService,
  SoundfontStorage,
  Workers,
} from "@opendaw/studio-core";
import {
  type EngineErrorPayload,
  type EngineReadyPayload,
  type Message,
  MessageType,
  type ProjectState,
  isEngineMessage,
} from "../shared/protocol.js";
import { handleMessage } from "./messageHandlers.js";
import { ProjectController, createBootEnv } from "./projectAdapter.js";

const projectId = new URLSearchParams(window.location.search).get("projectId") ?? "default";

function log(source: string, message: string) {
  console.log(`[VSDAW engine] ${source}: ${message}`);
}

function setStatus(text: string) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
  log("status", text);
}

declare global {
  interface Window {
    vsdawSend?: (message: Message<unknown>) => void;
    vsdawReceiveMessage?: (message: Message<unknown>) => void;
  }
}

function isPlaywrightBridge(): boolean {
  return typeof window.vsdawSend === "function";
}

function sendToHost<T>(message: Message<T>) {
  if (isPlaywrightBridge()) {
    window.vsdawSend?.(message as Message<unknown>);
  } else {
    window.parent.postMessage(message, "*");
  }
}

function post<T>(type: string, payload: T, requestId?: string) {
  const message: Message<T> = {
    direction: "engine-to-host",
    projectId,
    type,
    payload,
    requestId,
  };
  sendToHost(message);
}

function notifyHost<T>(type: string, payload: T) {
  const message: Message<T> = {
    direction: "engine-to-host",
    projectId,
    type,
    payload,
  };
  sendToHost(message);
}

let controller: ProjectController | null = null;

async function boot() {
  try {
    log("boot", `projectId=${projectId}`);

    if (!window.crossOriginIsolated) {
      throw new Error(
        `crossOriginIsolated is false (${window.crossOriginIsolated}). Ensure COOP/COEP headers are set.`,
      );
    }

    const origin = window.location.origin;
    const workersUrl = new URL("/workers-main.js", origin).href;
    const processorsUrl = new URL("/processors.js", origin).href;
    const offlineEngineUrl = new URL("/offline-engine.js", origin).href;

    setStatus("Installing workers...");
    await Workers.install(workersUrl);

    setStatus("Installing audio worklets...");
    AudioWorklets.install(processorsUrl);
    OfflineEngineRenderer.install(offlineEngineUrl);

    setStatus("Creating AudioContext...");
    let audioContext: AudioContext;
    try {
      audioContext = new AudioContext({ latencyHint: 0 });
    } catch (error: unknown) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to create AudioContext: ${reason}`);
    }

    setStatus("Creating AudioWorklets...");
    const audioWorklets = await AudioWorklets.createFor(audioContext);

    setStatus("Creating project environment...");
    const bootEnv = createBootEnv(audioContext, audioWorklets);

    setStatus("Creating controller...");
    controller = new ProjectController({
      bootEnv,
      projectId,
      onStateChange: (state: ProjectState) => {
        notifyHost(MessageType.StateUpdate, state);
      },
      onTransportPosition: (position: number) => {
        notifyHost(MessageType.TransportPositionChanged, { position });
      },
    });

    // Create a default empty project so the engine is immediately usable.
    controller.newProject();

    setStatus("Resuming AudioContext...");
    try {
      await audioContext.resume();
    } catch (error: unknown) {
      console.warn("Could not resume AudioContext during boot:", error);
    }
    resumeOnUserGesture(audioContext);

    setStatus("Ready.");
    const readyPayload: EngineReadyPayload = {
      crossOriginIsolated: window.crossOriginIsolated,
      audioContextState: audioContext.state,
      sampleRate: audioContext.sampleRate,
    };
    post(MessageType.EngineReady, readyPayload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    log("boot", `failed: ${message}`);
    setStatus(`Error: ${message}`);
    const errorPayload: EngineErrorPayload = { message, stack };
    post(MessageType.EngineError, errorPayload);
  }
}

function resumeOnUserGesture(audioContext: AudioContext) {
  const resume = async () => {
    if (audioContext.state === "suspended") {
      try {
        await audioContext.resume();
        log("audio", `AudioContext resumed, state=${audioContext.state}`);
      } catch (error: unknown) {
        console.warn("Could not resume AudioContext:", error);
      }
    }
  };
  window.addEventListener("click", resume, { once: true });
  window.addEventListener("keydown", resume, { once: true });
}

async function onHostMessage(event: MessageEvent<unknown> | Message<unknown>) {
  const message = (event instanceof MessageEvent ? event.data : event) as Message<unknown>;
  if (!isEngineMessage(message)) return;
  if (message.direction !== "host-to-engine") return;
  if (message.projectId !== projectId) return;

  log(
    "message",
    `received ${message.type}${message.requestId ? ` requestId=${message.requestId}` : ""}`,
  );

  if (message.type === MessageType.Ping) {
    post(MessageType.Pong, { time: Date.now() }, message.requestId);
    return;
  }

  if (!controller) {
    post(
      MessageType.EngineError,
      { message: "Engine controller is not initialized" },
      message.requestId,
    );
    return;
  }

  try {
    const result = await handleMessage(controller, message);
    if (result.type === "error") {
      log("message", `${message.type} failed: ${result.message}`);
      post(MessageType.EngineError, { message: result.message }, message.requestId);
    } else if (message.type !== MessageType.StateGet) {
      // Echo a completion event back to the host for operations that require
      // an explicit ack. StateGet is handled directly by result.
      post(`${message.type}.ack`, result.payload ?? {}, message.requestId);
    } else {
      post(`${message.type}.result`, result.payload ?? {}, message.requestId);
    }
  } catch (error: unknown) {
    const messageText = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    log("message", `unhandled exception for ${message.type}: ${messageText}`);
    post(MessageType.EngineError, { message: messageText, stack }, message.requestId);
  }
}

window.addEventListener("message", (event) => {
  void onHostMessage(event);
});

// Expose a global receive hook for the Playwright/Node bridge.
window.vsdawReceiveMessage = (message) => {
  void onHostMessage(message);
};

boot();
