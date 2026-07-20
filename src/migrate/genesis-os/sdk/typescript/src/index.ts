export interface ToolSpec {
  name: string;
  version: string;
  description: string;
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  capabilities: string[];
  kind: "builtin" | "workflow" | "python";
  timeout_seconds: number;
  deterministic: boolean;
  tags: string[];
}

export interface ToolResult {
  call_id: string;
  tool: string;
  ok: boolean;
  output: Record<string, unknown>;
  error?: string | null;
  duration_ms: number;
}

export interface WakeResult {
  session_id: string;
  messages: string[];
  tool_results: ToolResult[];
  yielded: boolean;
  sleep_requested: boolean;
  final_sequence: number;
}

export interface GenesisEvent {
  id: string;
  sequence: number;
  timestamp: string;
  kind: string;
  actor: string;
  payload: Record<string, unknown>;
  session_id: string;
  event_hash: string;
  previous_hash: string;
}

export interface GenesisClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof globalThis.fetch;
}

export class GenesisClient {
  readonly baseUrl: string;
  readonly token: string | undefined;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: GenesisClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("content-type", "application/json");
    if (this.token) headers.set("authorization", `Bearer ${this.token}`);
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { ...init, headers });
    if (!response.ok) {
      throw new Error(`Genesis request failed (${response.status}): ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  health(): Promise<Record<string, unknown>> {
    return this.request("/health");
  }

  async tools(): Promise<ToolSpec[]> {
    const response = await this.request<{ tools: ToolSpec[] }>("/v1/tools");
    return response.tools;
  }

  invokeTool(
    tool: string,
    arguments_: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<ToolResult> {
    return this.request("/v1/tools/invoke", {
      method: "POST",
      body: JSON.stringify({ tool, arguments: arguments_, session_id: sessionId }),
    });
  }

  observe(input: {
    content: string;
    source?: string;
    sessionId?: string;
    structured?: Record<string, unknown>;
  }): Promise<WakeResult> {
    return this.request("/v1/observe", {
      method: "POST",
      body: JSON.stringify({
        content: input.content,
        source: input.source ?? "andromeda",
        session_id: input.sessionId,
        structured: input.structured ?? {},
      }),
    });
  }

  sendAndromedaEvent(input: {
    type: string;
    content: string;
    source?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<WakeResult> {
    return this.request("/v1/andromeda/events", {
      method: "POST",
      body: JSON.stringify({
        type: input.type,
        content: input.content,
        source: input.source ?? "andromeda",
        session_id: input.sessionId,
        metadata: input.metadata ?? {},
      }),
    });
  }

  async events(afterSequence = 0, limit = 200): Promise<GenesisEvent[]> {
    const response = await this.request<{ events: GenesisEvent[] }>(
      `/v1/events?after_sequence=${afterSequence}&limit=${limit}`,
    );
    return response.events;
  }

  sleep(spec?: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request("/v1/sleep", {
      method: "POST",
      body: JSON.stringify({ spec }),
    });
  }

  eventSocket(afterSequence = 0): WebSocket {
    const url = new URL(this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = "/v1/events/ws";
    url.searchParams.set("after_sequence", String(afterSequence));
    if (this.token) url.searchParams.set("token", this.token);
    return new WebSocket(url);
  }
}
