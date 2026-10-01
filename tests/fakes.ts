import type { Api, Model, UsageFetchContext } from "@oh-my-pi/pi-ai";
import { encodeFrame } from "../src/eventstream";
import type { FetchLike } from "../src/http";

export interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A fetch double that records every request and answers from `handler`. */
export function fakeFetch(handler: (call: RecordedCall, index: number) => Response | Promise<Response>) {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const call: RecordedCall = {
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch, calls };
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const encoder = new TextEncoder();

export function eventFrame(eventType: string, payload: unknown): Uint8Array {
  return encodeFrame(
    { ":message-type": "event", ":event-type": eventType, ":content-type": "application/json" },
    encoder.encode(JSON.stringify(payload)),
  );
}

export function exceptionFrame(exceptionType: string, payload: unknown): Uint8Array {
  return encodeFrame(
    { ":message-type": "exception", ":exception-type": exceptionType, ":content-type": "application/json" },
    encoder.encode(JSON.stringify(payload)),
  );
}

/** Response whose body arrives in deliberately awkward chunks: frames split mid-prelude. */
export function eventStreamResponse(frames: readonly Uint8Array[], chunkSize = 7): Response {
  const bytes = new Uint8Array(frames.reduce((sum, frame) => sum + frame.byteLength, 0));
  let offset = 0;
  for (const frame of frames) {
    bytes.set(frame, offset);
    offset += frame.byteLength;
  }
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let start = 0; start < bytes.byteLength; start += chunkSize) controller.enqueue(bytes.slice(start, start + chunkSize));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "application/vnd.amazon.eventstream" } });
}

export const PROFILE_ARN = "arn:aws:codewhisperer:eu-central-1:111111111111:profile/TESTPROFILE";

export function kiroModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
  const model = {
    id: "claude-sonnet-4.6",
    name: "Claude Sonnet 4.6 (Kiro)",
    api: "kiro-generate-assistant-response",
    provider: "kiro",
    baseUrl: "https://runtime.us-east-1.kiro.dev",
    reasoning: true,
    thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "max"], supportsDisplay: true },
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 8_192,
    ...overrides,
  };
  // Test fixture: the fields a transport reads; catalog identity metadata is irrelevant here.
  return model as unknown as Model<Api>;
}

/**
 * Adapt the plugin's string-only fetch double to the host's wider `FetchImpl`
 * signature. The host only ever passes string URLs, so the cast is the whole
 * difference between the two types.
 */
export function usageContext(fetch: FetchLike): UsageFetchContext {
  return { fetch: fetch as unknown as UsageFetchContext["fetch"] };
}
