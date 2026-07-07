import type {
  ProviderAdapter,
  SessionDescriptor,
  SessionTranscript,
  TurnChunk,
  TurnRequest,
  TurnResult,
} from "./session";

export function renderTranscriptForCli(transcript: SessionTranscript): string {
  const out: string[] = [];
  for (const message of transcript.messages) {
    if (message.role === "system") out.push(`System: ${message.content}`);
    else if (message.role === "user") out.push(`User: ${message.content}`);
    else if (message.role === "assistant") out.push(`Assistant: ${message.content}`);
  }
  return out.join("\n\n");
}

export class FakeProviderAdapter implements ProviderAdapter {
  readonly id = "fake";
  readonly displayName = "Fake Provider";
  readonly supportsStreaming = true;

  constructor(private options: { echoPrefix?: string; delayMs?: number } = {}) {}

  async startSession(): Promise<void> {}
  async continueSession(): Promise<void> {}

  async runTurn(_descriptor: SessionDescriptor, transcript: SessionTranscript, request: TurnRequest): Promise<TurnResult> {
    const prompt = request.prompt;
    const history = renderTranscriptForCli(transcript);
    const content = `${this.options.echoPrefix ?? "fake:"} ${prompt}`;
    const usage = { tokensIn: history.length + prompt.length, tokensOut: content.length };
    return {
      content,
      role: "assistant",
      usage,
      finishReason: "stop",
    };
  }

  async *streamTurn(
    _descriptor: SessionDescriptor,
    transcript: SessionTranscript,
    request: TurnRequest,
  ): AsyncGenerator<TurnChunk> {
    const prompt = request.prompt;
    const history = renderTranscriptForCli(transcript);
    const content = `${this.options.echoPrefix ?? "fake:"} ${prompt}`;
    const words = content.split(" ");
    for (let i = 0; i < words.length; i += 1) {
      const delimiter = i < words.length - 1 ? " " : "";
      yield { type: "text", delta: `${words[i]}${delimiter}` };
      if (this.options.delayMs && this.options.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.options.delayMs));
      }
    }
    yield {
      type: "usage",
      usage: { tokensIn: history.length + prompt.length, tokensOut: content.length },
    };
    yield { type: "finish", finishReason: "stop" };
  }
}
