import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TextContent,
  ThinkingContent,
  Tool,
  ToolCall,
} from "@oh-my-pi/pi-ai";
import { z } from "zod";
import { resolveProfile } from "./catalog";
import { parseAccessKey, regionFromProfileArn, runtimeBaseUrl } from "./endpoints";
import { EventStreamDecoder, type EventStreamMessage } from "./eventstream";
import { type FetchLike, httpErrorFrom, KiroHttpError } from "./http";
import { buildKiroRequest } from "./request";

/**
 * `streamSimple` for Kiro: POST the conversation to
 * `runtime.<region>.kiro.dev/generateAssistantResponse` and translate the AWS
 * EventStream response into OMP assistant-message events.
 */

const USER_AGENT = "omp-kiro-provider/0.1.0";
const TRANSIENT_TOOL_FORMAT = /invalid tool use format\.*\s*$/i;
const CONTEXT_OVERFLOW = /CONTENT_LENGTH_EXCEEDS_THRESHOLD|input is too long/i;
/** First-event budget: the reference Kiro client allows up to 180s for Opus-class first tokens. */
const FIRST_EVENT_TIMEOUT_MS = 180_000;
const IDLE_TIMEOUT_MS = 300_000;
/** Largest delay `setTimeout` honours; larger values fire almost immediately. */
const MAX_TIMER_MS = 2_147_483_647;

export interface KiroStreamDeps {
  createStream(): AssistantMessageEventStream;
  toolSchema(tool: Tool): Record<string, unknown>;
  fetch: FetchLike;
  now(): number;
  randomUUID(): string;
}

const AssistantEventSchema = z.looseObject({ content: z.string() });
const ReasoningEventSchema = z.looseObject({ text: z.string().optional(), signature: z.string().optional() });
const ToolUseEventSchema = z.looseObject({
  toolUseId: z.string().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
  stop: z.boolean().optional(),
});
const TokenUsageSchema = z.looseObject({
  uncachedInputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  totalTokens: z.number().optional(),
  cacheReadInputTokens: z.number().optional(),
  cacheWriteInputTokens: z.number().optional(),
});
const MetadataEventSchema = z.looseObject({ tokenUsage: TokenUsageSchema.optional(), stopReason: z.string().optional() });
const ContextUsageEventSchema = z.looseObject({ contextUsagePercentage: z.number() });
const MeteringEventSchema = z.looseObject({ usage: z.number() });
const ExceptionSchema = z.looseObject({ message: z.string().optional(), reason: z.string().optional() });

type OpenBlock =
  | { kind: "text"; index: number }
  | { kind: "thinking"; index: number }
  | { kind: "tool"; index: number; json: string };

const textDecoder = new TextDecoder();

function headerString(message: EventStreamMessage, name: string): string | undefined {
  const value = message.headers[name];
  return typeof value === "string" ? value : undefined;
}

/** Event type from the `:event-type` header, falling back to payload shape. */
function eventTypeOf(message: EventStreamMessage, payload: unknown): string | undefined {
  const header = headerString(message, ":event-type");
  if (header) return header;
  if (typeof payload !== "object" || payload === null) return undefined;
  if ("toolUseId" in payload || "stop" in payload) return "toolUseEvent";
  if ("content" in payload) return "assistantResponseEvent";
  return undefined;
}

/** Translates decoded Kiro events into OMP events on one assistant message. */
class KiroEventTranslator {
  #open: OpenBlock | undefined;
  #usage: z.infer<typeof TokenUsageSchema> | undefined;
  #metadataStopReason: string | undefined;
  #contextPercent: number | undefined;
  #credits = 0;
  #firstTokenAt: number | undefined;

  constructor(
    private readonly stream: AssistantMessageEventStream,
    private readonly output: AssistantMessage,
    private readonly model: Model<Api>,
    private readonly now: () => number,
  ) {}

  handle(message: EventStreamMessage): void {
    const payloadText = textDecoder.decode(message.payload);
    let payload: unknown;
    try {
      payload = payloadText ? JSON.parse(payloadText) : {};
    } catch {
      throw new Error("Kiro stream sent a non-JSON event payload");
    }
    const messageType = headerString(message, ":message-type");
    if (messageType === "exception" || messageType === "error") {
      const parsed = ExceptionSchema.safeParse(payload);
      const kind = headerString(message, ":exception-type") ?? headerString(message, ":error-code") ?? "error";
      const detail = (parsed.success ? parsed.data.message : undefined) ?? headerString(message, ":error-message") ?? "no message";
      const reason = parsed.success && parsed.data.reason ? ` (${parsed.data.reason})` : "";
      throw new Error(`Kiro stream ${kind}: ${detail}${reason}`);
    }
    switch (eventTypeOf(message, payload)) {
      case "assistantResponseEvent": {
        const event = AssistantEventSchema.safeParse(payload);
        if (event.success && event.data.content) this.#delta("text", event.data.content);
        return;
      }
      case "reasoningContentEvent": {
        const event = ReasoningEventSchema.safeParse(payload);
        if (!event.success) return;
        if (event.data.text) this.#delta("thinking", event.data.text);
        if (event.data.signature && this.#open?.kind === "thinking") {
          (this.output.content[this.#open.index] as ThinkingContent).thinkingSignature = event.data.signature;
          this.#close();
        }
        return;
      }
      case "toolUseEvent": {
        const event = ToolUseEventSchema.safeParse(payload);
        if (event.success) this.#toolUse(event.data);
        return;
      }
      case "metadataEvent": {
        const event = MetadataEventSchema.safeParse(payload);
        if (!event.success) return;
        if (event.data.tokenUsage) this.#usage = { ...this.#usage, ...event.data.tokenUsage };
        if (event.data.stopReason) this.#metadataStopReason = event.data.stopReason;
        return;
      }
      case "contextUsageEvent": {
        const event = ContextUsageEventSchema.safeParse(payload);
        if (event.success) this.#contextPercent = event.data.contextUsagePercentage;
        return;
      }
      case "meteringEvent": {
        const event = MeteringEventSchema.safeParse(payload);
        if (event.success) this.#credits += event.data.usage;
        return;
      }
      default:
        return; // citations, code references, follow-up prompts: not part of the OMP message
    }
  }

  /** True once Kiro has produced any text, thinking, or tool-call output. */
  get receivedOutput(): boolean {
    return this.#firstTokenAt !== undefined;
  }

  #markFirstToken(): void {
    this.#firstTokenAt ??= this.now();
  }

  #delta(kind: "text" | "thinking", delta: string): void {
    this.#markFirstToken();
    let open = this.#open;
    if (!open || open.kind !== kind) {
      this.#close();
      const opened: OpenBlock = { kind, index: this.output.content.length };
      this.output.content.push(kind === "text" ? { type: "text", text: "" } : { type: "thinking", thinking: "" });
      this.#open = open = opened;
      this.stream.push({ type: kind === "text" ? "text_start" : "thinking_start", contentIndex: opened.index, partial: this.output });
    }
    const index = open.index;
    if (kind === "text") {
      (this.output.content[index] as TextContent).text += delta;
      this.stream.push({ type: "text_delta", contentIndex: index, delta, partial: this.output });
    } else {
      (this.output.content[index] as ThinkingContent).thinking += delta;
      this.stream.push({ type: "thinking_delta", contentIndex: index, delta, partial: this.output });
    }
  }

  #toolUse(event: z.infer<typeof ToolUseEventSchema>): void {
    this.#markFirstToken();
    const open = this.#open;
    const current = open?.kind === "tool" ? (this.output.content[open.index] as ToolCall) : undefined;
    if (event.toolUseId && current?.id !== event.toolUseId) {
      this.#close();
      const index = this.output.content.length;
      this.output.content.push({ type: "toolCall", id: event.toolUseId, name: event.name ?? "", arguments: {} });
      this.#open = { kind: "tool", index, json: "" };
      this.stream.push({ type: "toolcall_start", contentIndex: index, partial: this.output });
    }
    const tool = this.#open;
    if (tool?.kind !== "tool") return;
    if (event.name && !(this.output.content[tool.index] as ToolCall).name) {
      (this.output.content[tool.index] as ToolCall).name = event.name;
    }
    if (event.input !== undefined) {
      const chunk = typeof event.input === "string" ? event.input : JSON.stringify(event.input);
      // Kiro opens a call with empty or `{}` input before the argument chunks arrive.
      if (chunk !== "" && (chunk !== "{}" || tool.json !== "")) {
        tool.json += chunk;
        this.stream.push({ type: "toolcall_delta", contentIndex: tool.index, delta: chunk, partial: this.output });
      }
    }
    if (event.stop) this.#close();
  }

  #close(): void {
    const open = this.#open;
    if (!open) return;
    this.#open = undefined;
    const block = this.output.content[open.index]!;
    if (open.kind === "text") {
      this.stream.push({ type: "text_end", contentIndex: open.index, content: (block as TextContent).text, partial: this.output });
    } else if (open.kind === "thinking") {
      this.stream.push({ type: "thinking_end", contentIndex: open.index, content: (block as ThinkingContent).thinking, partial: this.output });
    } else {
      const call = block as ToolCall;
      let args: unknown;
      try {
        args = JSON.parse(open.json.trim() || "{}");
      } catch {
        throw new Error(`Kiro returned malformed arguments for tool "${call.name}"`);
      }
      if (typeof args !== "object" || args === null || Array.isArray(args)) {
        throw new Error(`Kiro returned non-object arguments for tool "${call.name}"`);
      }
      if (!call.name) throw new Error("Kiro returned a tool call without a name");
      call.arguments = args as Record<string, unknown>;
      this.stream.push({ type: "toolcall_end", contentIndex: open.index, toolCall: call, partial: this.output });
    }
  }

  finish(started: number): void {
    this.#close();
    const usage = this.output.usage;
    if (this.#usage) {
      usage.input = this.#usage.uncachedInputTokens ?? 0;
      usage.output = this.#usage.outputTokens ?? 0;
      usage.cacheRead = this.#usage.cacheReadInputTokens ?? 0;
      usage.cacheWrite = this.#usage.cacheWriteInputTokens ?? 0;
      usage.totalTokens = this.#usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
    }
    const contextWindow = this.model.contextWindow;
    if (this.#contextPercent !== undefined && contextWindow) {
      usage.contextTokens = Math.round((this.#contextPercent / 100) * contextWindow);
    }
    if (this.#credits > 0) usage.credits = { cost: this.#credits };
    const end = this.now();
    this.output.duration = end - started;
    if (this.#firstTokenAt !== undefined) this.output.ttft = this.#firstTokenAt - started;
    if (this.output.content.some(block => block.type === "toolCall")) this.output.stopReason = "toolUse";
    else if (this.#metadataStopReason && /max_tokens|length/i.test(this.#metadataStopReason)) this.output.stopReason = "length";
    else this.output.stopReason = "stop";
  }
}

function emptyUsage(): AssistantMessage["usage"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Settle with `work`, or reject as soon as `signal` aborts even if `work` ignores it. */
async function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  const { promise, reject } = Promise.withResolvers<never>();
  const onAbort = () => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([work, promise]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function postWithRetry(
  deps: KiroStreamDeps,
  fetchImpl: FetchLike,
  url: string,
  headers: Record<string, string>,
  body: string,
  signal: AbortSignal,
): Promise<Response> {
  // Kiro's fleet intermittently rejects valid requests with this 400; one identical retry clears it.
  for (let attempt = 0; ; attempt++) {
    const init: RequestInit = {
      method: "POST",
      headers: { ...headers, "amz-sdk-invocation-id": deps.randomUUID() },
      body,
      signal,
    };
    const response = await raceAbort(fetchImpl(url, init), signal);
    if (response.ok) return response;
    const error = await raceAbort(httpErrorFrom(response, "Kiro request"), signal);
    if (attempt === 0 && response.status === 400 && TRANSIENT_TOOL_FORMAT.test(error.detail ?? "")) continue;
    throw error;
  }
}

/**
 * Custom OMP APIs get no host stall watchdog, so the transport owns one: a
 * first-event budget until Kiro produces output, then an idle budget between
 * network chunks. `0` disables a budget, matching OMP's stream options.
 */
class StallWatchdog {
  readonly #controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;
  timedOut: string | undefined;

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  arm(ms: number, waitingFor: string): void {
    clearTimeout(this.#timer);
    if (!(ms > 0)) return;
    this.#timer = setTimeout(() => {
      this.timedOut = `Kiro stream timed out after ${ms / 1000}s waiting for ${waitingFor}`;
      this.#controller.abort(new Error(this.timedOut));
    }, Math.min(ms, MAX_TIMER_MS));
  }

  stop(): void {
    clearTimeout(this.#timer);
  }
}

async function run(
  deps: KiroStreamDeps,
  stream: AssistantMessageEventStream,
  output: AssistantMessage,
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
): Promise<void> {
  const started = output.timestamp;
  const firstEventMs = options?.streamFirstEventTimeoutMs ?? FIRST_EVENT_TIMEOUT_MS;
  const idleMs = options?.streamIdleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const watchdog = new StallWatchdog();
  const signal = options?.signal ? AbortSignal.any([options.signal, watchdog.signal]) : watchdog.signal;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  stream.push({ type: "start", partial: output });
  try {
    const apiKey = typeof options?.apiKey === "string" ? options.apiKey : undefined;
    if (!apiKey) throw new Error("No Kiro credential available; run /login and choose Kiro");
    const access = parseAccessKey(apiKey);
    const fetchImpl = options?.fetch ?? deps.fetch;
    watchdog.arm(firstEventMs, "the first event");
    const profile = access.profileArn
      ? { arn: access.profileArn, region: regionFromProfileArn(access.profileArn) ?? access.region }
      : await raceAbort(resolveProfile(fetchImpl, access.token, access.region, { builderId: false, signal }), signal);
    const body = buildKiroRequest(model, context, options, {
      toolSchema: deps.toolSchema,
      conversationId: options?.sessionId ?? deps.randomUUID(),
      profileArn: profile.arn,
    });
    const response = await postWithRetry(
      deps,
      fetchImpl,
      `${runtimeBaseUrl(profile.region)}/generateAssistantResponse`,
      {
        ...options?.headers,
        "Content-Type": "application/json",
        Accept: "application/vnd.amazon.eventstream",
        Authorization: `Bearer ${access.token}`,
        "x-amzn-codewhisperer-optout": "true",
        "x-amzn-kiro-agent-mode": "vibe",
        "x-amzn-kiro-profile-arn": profile.arn,
        "amz-sdk-request": "attempt=1; max=1",
        "user-agent": USER_AGENT,
        "x-amz-user-agent": USER_AGENT,
      },
      JSON.stringify(body),
      signal,
    );
    if (!response.body) throw new Error("Kiro returned an empty response body");

    const translator = new KiroEventTranslator(stream, output, model, deps.now);
    const decoder = new EventStreamDecoder();
    const activeReader = response.body.getReader();
    reader = activeReader;
    // Not every fetch ties the body to the request signal; cancel it directly so a stall or abort ends the read.
    if (signal.aborted) throw signal.reason;
    const cancelOnAbort = () => void activeReader.cancel(signal.reason).catch(() => undefined);
    signal.addEventListener("abort", cancelOnAbort, { once: true });
    try {
      for (;;) {
        const { done, value } = await activeReader.read();
        if (done) break;
        for (const message of decoder.push(value)) translator.handle(message);
        if (translator.receivedOutput) watchdog.arm(idleMs, "the next event");
      }
    } finally {
      signal.removeEventListener("abort", cancelOnAbort);
    }
    if (signal.aborted) throw signal.reason;
    reader = undefined;
    if (decoder.pendingBytes > 0) throw new Error("Kiro stream ended in the middle of an event frame");
    translator.finish(started);
    stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
  } catch (error) {
    // Stop the server-side generation we are no longer reading.
    void reader?.cancel().catch(() => undefined);
    const aborted = options?.signal?.aborted === true;
    output.stopReason = aborted ? "aborted" : "error";
    let message = watchdog.timedOut ?? (error instanceof Error ? error.message : String(error));
    if (error instanceof KiroHttpError) {
      output.errorStatus = error.status;
      if (error.status === 413 || CONTEXT_OVERFLOW.test(message)) message = `context_length_exceeded: ${message}`;
    }
    output.errorMessage = aborted ? "Request aborted" : message;
    output.duration = deps.now() - started;
    stream.push({ type: "error", reason: output.stopReason, error: output });
  } finally {
    watchdog.stop();
  }
}

export function streamKiro(
  deps: KiroStreamDeps,
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = deps.createStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: emptyUsage(),
    stopReason: "stop",
    timestamp: deps.now(),
  };
  void run(deps, stream, output, model, context, options);
  return stream;
}
