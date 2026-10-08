import { describe, expect, test } from "bun:test";
import {
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  type Message,
  toolWireSchema,
} from "@oh-my-pi/pi-ai";
import { isDefinitiveOAuthFailure } from "@oh-my-pi/pi-ai/error";
import { loginKiro, refreshKiro } from "../src/auth";
import { fetchKiroModels } from "../src/catalog";
import { BUILDER_ID_PROFILE_ARN } from "../src/endpoints";
import { crc32, decodeFrame, EventStreamDecoder, EventStreamError, encodeFrame } from "../src/eventstream";
import { buildKiroRequest, kiroToolUseId, pickEffort } from "../src/request";
import { streamKiro } from "../src/stream";
import type { FetchLike } from "../src/http";
import { eventFrame, eventStreamResponse, exceptionFrame, fakeFetch, json, kiroModel, PROFILE_ARN } from "./fakes";

interface WireToolSpec {
  toolSpecification: { name: string; inputSchema: { json: unknown } };
}
interface WireUserMessage {
  content: string;
  userInputMessageContext?: { toolResults?: unknown[]; tools?: WireToolSpec[] };
}
interface WireTurn {
  userInputMessage?: WireUserMessage;
  assistantResponseMessage?: { content: string; toolUses?: { toolUseId: string }[] };
}
interface WireBody {
  conversationState: { history: WireTurn[]; currentMessage: { userInputMessage: WireUserMessage } };
  profileArn: string;
}

const ACCESS_KEY = JSON.stringify({ token: "test-access", region: "us-east-1", profileArn: PROFILE_ARN });
const readTool = {
  name: "read",
  description: "Read a file",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
} as unknown as NonNullable<Context["tools"]>[number];

function user(text: string): Message {
  return { role: "user", content: text, timestamp: 0 } as Message;
}
function assistant(content: unknown[], stopReason = "toolUse"): Message {
  return { role: "assistant", content, api: "kiro", provider: "kiro", model: "m", stopReason, timestamp: 0, usage: {} } as unknown as Message;
}
function toolResult(toolCallId: string, text: string, isError = false): Message {
  return { role: "toolResult", toolCallId, toolName: "read", content: [{ type: "text", text }], isError, timestamp: 0 } as Message;
}

function streamDeps(fetch: FetchLike) {
  let uuid = 0;
  let clock = 1_000;
  return {
    createStream: createAssistantMessageEventStream,
    toolSchema: toolWireSchema,
    fetch,
    now: () => (clock += 10),
    randomUUID: () => `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
  };
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

describe("Kiro EventStream framing", () => {
  test("reassembles frames split at every byte boundary", () => {
    const frames = [eventFrame("assistantResponseEvent", { content: "Hel" }), eventFrame("assistantResponseEvent", { content: "lo" })];
    const decoder = new EventStreamDecoder();
    const decoded = [];
    for (const frame of frames) for (const byte of frame) decoded.push(...decoder.push(new Uint8Array([byte])));
    expect(decoded.map(message => new TextDecoder().decode(message.payload))).toEqual(['{"content":"Hel"}', '{"content":"lo"}']);
    expect(decoded[0]?.headers[":event-type"]).toBe("assistantResponseEvent");
    expect(decoder.pendingBytes).toBe(0);
  });

  test("uses IEEE CRC32 and rejects corrupted preludes and payloads", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    const frame = encodeFrame({ ":event-type": "x" }, new TextEncoder().encode('{"a":1}'));
    const payloadFlip = frame.slice();
    payloadFlip[payloadFlip.byteLength - 6]! ^= 0xff;
    expect(() => decodeFrame(payloadFlip)).toThrow("message CRC mismatch");
    const preludeFlip = frame.slice();
    preludeFlip[5]! ^= 0x01;
    expect(() => decodeFrame(preludeFlip)).toThrow(EventStreamError);
    expect(() => new EventStreamDecoder().push(new Uint8Array(12))).toThrow(EventStreamError);
  });

  test("fails fast on a corrupt prelude instead of waiting for its claimed length", () => {
    const valid = eventFrame("assistantResponseEvent", { content: "x" });
    const corrupt = valid.slice(0, 12);
    new DataView(corrupt.buffer).setUint32(0, 8 * 1024 * 1024); // claims 8 MiB, prelude CRC now wrong
    expect(() => new EventStreamDecoder().push(corrupt)).toThrow("prelude CRC mismatch");
  });
});

describe("Kiro request normalization", () => {
  test("enforces Kiro's history invariants and declares tools the history references", () => {
    const foreignId = "call_abc|fc_" + "x".repeat(80);
    const context: Context = {
      systemPrompt: ["You are careful."],
      tools: [readTool],
      messages: [
        user("first"),
        user("second"),
        assistant([
          { type: "text", text: "Reading." },
          { type: "toolCall", id: foreignId, name: "read", arguments: { path: "a" } },
          { type: "toolCall", id: "tool_2", name: "legacy_grep", arguments: { q: "b" } },
        ]),
        toolResult(foreignId, "file a"),
        toolResult("orphan", "no matching call"),
        assistant([{ type: "text", text: "Broken partial" }], "error"),
        user("now continue"),
      ],
    };
    const body = buildKiroRequest(kiroModel(), context, undefined, {
      toolSchema: toolWireSchema,
      conversationId: "conv-1",
      profileArn: PROFILE_ARN,
    }) as unknown as WireBody;
    const { history, currentMessage } = body.conversationState;

    expect(body.profileArn).toBe(PROFILE_ARN);
    expect(history[0]?.userInputMessage?.content).toBe("You are careful.\n\nfirst\n\nsecond");
    const mappedId = kiroToolUseId(foreignId);
    expect(mappedId).toMatch(/^[a-zA-Z0-9_.:-]{1,64}$/);
    expect(history[1]?.assistantResponseMessage?.toolUses?.map(use => use.toolUseId)).toEqual([mappedId, "tool_2"]);
    // The errored assistant turn is dropped, so the results and the next user text merge into the current turn.
    expect(history).toHaveLength(2);
    const current = currentMessage.userInputMessage;
    expect(current.content).toBe("now continue");
    expect(current.userInputMessageContext?.toolResults).toEqual([
      { toolUseId: mappedId, content: [{ text: "file a" }], status: "success" },
      { toolUseId: "tool_2", content: [{ text: "Tool use was interrupted and did not produce a result." }], status: "error" },
    ]);
    const tools = current.userInputMessageContext?.tools ?? [];
    expect(tools.map(tool => tool.toolSpecification.name)).toEqual(["read", "legacy_grep"]);
    expect(tools[0]?.toolSpecification.inputSchema.json).toMatchObject({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  test("starts with a user turn and never sends an empty one", () => {
    const body = buildKiroRequest(kiroModel(), { messages: [assistant([{ type: "text", text: "hi" }], "stop")] }, undefined, {
      toolSchema: toolWireSchema,
      conversationId: "c",
      profileArn: PROFILE_ARN,
    }) as unknown as WireBody;
    expect(body.conversationState.history[0]?.userInputMessage?.content).toBe("Please proceed with the task.");
    expect(body.conversationState.history[1]?.assistantResponseMessage?.content).toBe("hi");
    expect(body.conversationState.currentMessage.userInputMessage.content).toBe("Please proceed with the task.");
  });

  test("maps OMP effort onto the model's advertised Kiro effort field", () => {
    expect(pickEffort(["low", "medium", "high", "max"], "xhigh")).toBe("max");
    expect(pickEffort(["low", "medium", "high"], "minimal")).toBe("low");
    expect(pickEffort(["low", "medium"], "max")).toBe("medium");
    const deps = { toolSchema: toolWireSchema, conversationId: "c", profileArn: PROFILE_ARN };
    const adaptive = buildKiroRequest(kiroModel(), { messages: [user("x")] }, { reasoning: "xhigh" } as never, deps);
    expect(adaptive.additionalModelRequestFields).toEqual({ output_config: { effort: "max" }, thinking: { type: "adaptive", display: "summarized" } });
    const gpt = kiroModel({ thinking: { mode: "effort", efforts: ["low", "medium", "high"] } } as never);
    expect(buildKiroRequest(gpt, { messages: [user("x")] }, { reasoning: "medium" } as never, deps).additionalModelRequestFields).toEqual({
      reasoning: { effort: "medium" },
    });
    const off = buildKiroRequest(kiroModel(), { messages: [user("x")] }, { reasoning: "high", disableReasoning: true } as never, deps);
    expect(off.additionalModelRequestFields).toBeUndefined();
  });

  test("gives reused tool-use ids fresh ids and re-points their results", () => {
    const call = (id: string) => ({ type: "toolCall", id, name: "read", arguments: {} });
    const body = buildKiroRequest(
      kiroModel(),
      {
        tools: [readTool],
        messages: [user("a"), assistant([call("call_0")]), toolResult("call_0", "one"), assistant([call("call_0")]), toolResult("call_0", "two")],
      },
      undefined,
      { toolSchema: toolWireSchema, conversationId: "c", profileArn: PROFILE_ARN },
    ) as unknown as WireBody;
    const history = body.conversationState.history;
    const firstId = history[1]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId;
    const secondId = history[3]?.assistantResponseMessage?.toolUses?.[0]?.toolUseId;
    expect(firstId).toBe("call_0");
    expect(secondId).not.toBe("call_0");
    expect(secondId).toMatch(/^[a-zA-Z0-9_.:-]{1,64}$/);
    expect(body.conversationState.currentMessage.userInputMessage.userInputMessageContext?.toolResults).toEqual([
      { toolUseId: secondId, content: [{ text: "two" }], status: "success" },
    ]);
  });
});

describe("Kiro streaming", () => {
  test("streams thinking, text, and a chunked tool call from the profile's region", async () => {
    const { fetch, calls } = fakeFetch(() =>
      eventStreamResponse([
        eventFrame("reasoningContentEvent", { text: "Let me look." }),
        eventFrame("reasoningContentEvent", { signature: "sig-1" }),
        eventFrame("assistantResponseEvent", { content: "Reading " }),
        eventFrame("assistantResponseEvent", { content: "now." }),
        eventFrame("toolUseEvent", { toolUseId: "tooluse_1", name: "read", input: "" }),
        eventFrame("toolUseEvent", { toolUseId: "tooluse_1", name: "read", input: '{"pa' }),
        eventFrame("toolUseEvent", { toolUseId: "tooluse_1", name: "read", input: 'th":"a.ts"}' }),
        eventFrame("toolUseEvent", { toolUseId: "tooluse_1", name: "read", stop: true }),
        eventFrame("contextUsageEvent", { contextUsagePercentage: 2.5 }),
        eventFrame("metadataEvent", { tokenUsage: { uncachedInputTokens: 120, outputTokens: 30 } }),
        eventFrame("meteringEvent", { usage: 0.25, unit: "credit" }),
      ]),
    );
    const stream = streamKiro(streamDeps(fetch), kiroModel(), { messages: [user("open a.ts")], tools: [readTool] }, {
      apiKey: ACCESS_KEY,
      sessionId: "session-1",
    } as never);
    const events = await collect(stream);
    const result = await stream.result();

    expect(calls[0]?.url).toBe("https://runtime.eu-central-1.kiro.dev/generateAssistantResponse");
    expect(calls[0]?.headers.Authorization).toBe("Bearer test-access");
    expect((calls[0]?.body as { conversationState: { conversationId: string } }).conversationState.conversationId).toBe("session-1");
    expect(events.map(event => event.type)).toEqual([
      "start",
      "thinking_start", "thinking_delta", "thinking_end",
      "text_start", "text_delta", "text_delta", "text_end",
      "toolcall_start", "toolcall_delta", "toolcall_delta", "toolcall_end",
      "done",
    ]);
    expect(result.stopReason).toBe("toolUse");
    expect(result.content).toEqual([
      { type: "thinking", thinking: "Let me look.", thinkingSignature: "sig-1" },
      { type: "text", text: "Reading now." },
      { type: "toolCall", id: "tooluse_1", name: "read", arguments: { path: "a.ts" } },
    ]);
    expect(result.usage).toMatchObject({ input: 120, output: 30, totalTokens: 150, contextTokens: 5000, credits: { cost: 0.25 } });
  });

  test("surfaces exception frames as errors instead of a silent empty turn", async () => {
    const { fetch } = fakeFetch(() =>
      eventStreamResponse([
        eventFrame("assistantResponseEvent", { content: "partial" }),
        exceptionFrame("ThrottlingException", { message: "Too many requests", reason: "USER_REQUEST_RATE_EXCEEDED" }),
      ]),
    );
    const stream = streamKiro(streamDeps(fetch), kiroModel(), { messages: [user("x")] }, { apiKey: ACCESS_KEY } as never);
    const events = await collect(stream);
    const last = events.at(-1);
    expect(last?.type).toBe("error");
    expect(last?.type === "error" && last.error.errorMessage).toBe(
      "Kiro stream ThrottlingException: Too many requests (USER_REQUEST_RATE_EXCEEDED)",
    );
  });

  test("retries the transient tool-format 400 exactly once and reports other HTTP errors", async () => {
    const flaky = fakeFetch((_call, index) =>
      index === 0
        ? json(400, { message: "Invalid tool use format." })
        : eventStreamResponse([eventFrame("assistantResponseEvent", { content: "ok" })]),
    );
    const recovered = streamKiro(streamDeps(flaky.fetch), kiroModel(), { messages: [user("x")] }, { apiKey: ACCESS_KEY } as never);
    await collect(recovered);
    expect((await recovered.result()).content).toEqual([{ type: "text", text: "ok" }]);
    expect(flaky.calls).toHaveLength(2);
    expect(flaky.calls[0]?.headers["amz-sdk-invocation-id"]).not.toBe(flaky.calls[1]?.headers["amz-sdk-invocation-id"]);

    const tooBig = fakeFetch(() => json(400, { message: "Input is too long.", reason: "CONTENT_LENGTH_EXCEEDS_THRESHOLD" }));
    const failed = streamKiro(streamDeps(tooBig.fetch), kiroModel(), { messages: [user("x")] }, { apiKey: ACCESS_KEY } as never);
    await collect(failed);
    const error = await failed.result();
    expect(tooBig.calls).toHaveLength(1);
    expect(error.stopReason).toBe("error");
    expect(error.errorStatus).toBe(400);
    expect(error.errorMessage).toStartWith("context_length_exceeded: Kiro request failed: HTTP 400 Input is too long.");
  });

  test("times out a stalled stream and cancels the response body", async () => {
    let cancelled = false;
    const { fetch } = fakeFetch(() => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(eventFrame("assistantResponseEvent", { content: "partial" }));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { status: 200 });
    });
    const stream = streamKiro(streamDeps(fetch), kiroModel(), { messages: [user("x")] }, {
      apiKey: ACCESS_KEY,
      streamIdleTimeoutMs: 30,
    } as never);
    await collect(stream);
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("Kiro stream timed out after 0.03s waiting for the next event");
    expect(cancelled).toBeTrue();
  });

  test("times out even when the fetch ignores the abort signal", async () => {
    const neverAnswers: FetchLike = () => new Promise<Response>(() => undefined);
    const stream = streamKiro(streamDeps(neverAnswers), kiroModel(), { messages: [user("x")] }, {
      apiKey: ACCESS_KEY,
      streamFirstEventTimeoutMs: 30,
    } as never);
    await collect(stream);
    expect((await stream.result()).errorMessage).toBe("Kiro stream timed out after 0.03s waiting for the first event");
  });
});

describe("Kiro login and refresh", () => {
  test("runs the Builder ID device flow, backs off on slow_down, and falls back to the Builder ID profile", async () => {
    const tokenReplies = [
      json(400, { error: "authorization_pending" }),
      json(400, { error: "slow_down" }),
      json(200, { accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 3600 }),
    ];
    const { fetch, calls } = fakeFetch(call => {
      if (call.url.endsWith("/client/register")) return json(200, { clientId: "client-1", clientSecret: "secret-1" });
      if (call.url.endsWith("/device_authorization")) {
        return json(200, { deviceCode: "dev-1", userCode: "ABCD-EFGH", verificationUri: "https://device.sso/", verificationUriComplete: "https://device.sso/?code=ABCD-EFGH", interval: 5, expiresIn: 600 });
      }
      if (call.url.endsWith("/token")) return tokenReplies.shift()!;
      if (call.url.endsWith("/List-Available-Profiles")) return json(403, { message: "denied" });
      if (call.url.includes("/Get-Usage-Limits?")) return json(200, { userInfo: { email: "dev@example.com", userId: "user-1" } });
      throw new Error(`unexpected ${call.url}`);
    });
    const sleeps: number[] = [];
    let clock = 0;
    const auths: string[] = [];
    const credentials = await loginKiro(
      { fetch, now: () => clock, sleep: async ms => { sleeps.push(ms); clock += ms; } },
      { onPrompt: async () => "", onAuth: info => auths.push(info.url) },
    );

    expect(calls[0]?.url).toBe("https://oidc.us-east-1.amazonaws.com/client/register");
    expect((calls[1]?.body as { startUrl: string }).startUrl).toBe("https://view.awsapps.com/start");
    expect(auths).toEqual(["https://device.sso/?code=ABCD-EFGH"]);
    expect(sleeps).toEqual([5000, 5000, 10000]);
    expect(JSON.parse(credentials.access)).toEqual({ token: "access-1", region: "us-east-1", profileArn: BUILDER_ID_PROFILE_ARN });
    expect(JSON.parse(credentials.refresh)).toMatchObject({ refreshToken: "refresh-1", clientId: "client-1", oidcRegion: "us-east-1" });
    // The user identity lets OMP replace this user's row on a later sign-in instead of adding a duplicate.
    expect(new URL(calls.at(-1)!.url).searchParams.get("isEmailRequired")).toBe("true");
    expect(calls.at(-1)?.headers.Authorization).toBe("Bearer access-1");
    expect({ email: credentials.email, accountId: credentials.accountId }).toEqual({ email: "dev@example.com", accountId: "user-1" });
    expect(credentials.expires).toBe(20_000 + 3600_000 - 300_000);
  });

  test("a login cancelled during the identity lookup fails instead of saving the credential", async () => {
    const controller = new AbortController();
    const { fetch } = fakeFetch(call => {
      if (call.url.endsWith("/client/register")) return json(200, { clientId: "client-1", clientSecret: "secret-1" });
      if (call.url.endsWith("/device_authorization")) return json(200, { deviceCode: "dev-1", userCode: "ABCD-EFGH", verificationUri: "https://device.sso/" });
      if (call.url.endsWith("/token")) return json(200, { accessToken: "access-1", refreshToken: "refresh-1" });
      if (call.url.endsWith("/List-Available-Profiles")) return json(200, { profiles: [{ arn: PROFILE_ARN }] });
      controller.abort();
      return json(500, { message: "aborted" });
    });
    const login = loginKiro(
      { fetch, now: () => 0, sleep: async () => {} },
      { onPrompt: async () => "", onAuth: () => {}, signal: controller.signal },
    );
    await expect(login).rejects.toThrow();
  });

  test("refreshes against the registered OIDC region and keeps the profile", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, { accessToken: "access-2", expiresIn: 1800 }));
    const refreshed = await refreshKiro(
      { fetch, now: () => 1_000_000, sleep: async () => {} },
      {
        access: JSON.stringify({ token: "access-1", region: "eu-central-1", profileArn: PROFILE_ARN }),
        refresh: JSON.stringify({ refreshToken: "refresh-1", clientId: "c", clientSecret: "s", oidcRegion: "eu-west-1", startUrl: "https://org.awsapps.com/start" }),
        expires: 0,
      },
    );
    expect(calls[0]?.url).toBe("https://oidc.eu-west-1.amazonaws.com/token");
    expect(calls[0]?.body).toMatchObject({ grantType: "refresh_token", refreshToken: "refresh-1" });
    expect(JSON.parse(refreshed.access)).toEqual({ token: "access-2", region: "eu-central-1", profileArn: PROFILE_ARN });
    // Kiro may omit a rotated refresh token; the previous one stays valid.
    expect(JSON.parse(refreshed.refresh).refreshToken).toBe("refresh-1");
    expect(refreshed.expires).toBe(1_000_000 + 1800_000 - 300_000);

    await expect(
      refreshKiro({ fetch, now: () => 0, sleep: async () => {} }, { access: "{}", refresh: "not json", expires: 0 }),
    ).rejects.toThrow("run /login");
  });

  test("backfills a missing user identity on refresh, best effort", async () => {
    const credentials = {
      access: JSON.stringify({ token: "access-1", region: "eu-central-1", profileArn: PROFILE_ARN }),
      refresh: JSON.stringify({ refreshToken: "refresh-1", clientId: "c", clientSecret: "s", oidcRegion: "eu-west-1", startUrl: "https://org.awsapps.com/start" }),
      expires: 0,
    };
    const deps = (fetch: FetchLike) => ({ fetch, now: () => 0, sleep: async () => {} });
    const token = () => json(200, { accessToken: "access-2", expiresIn: 1800 });

    const lookup = fakeFetch(call => (call.url.endsWith("/token") ? token() : json(200, { userInfo: { email: "dev@example.com", userId: "user-1" } })));
    const backfilled = await refreshKiro(deps(lookup.fetch), credentials);
    expect(lookup.calls[1]?.headers.Authorization).toBe("Bearer access-2");
    expect({ email: backfilled.email, accountId: backfilled.accountId }).toEqual({ email: "dev@example.com", accountId: "user-1" });

    // A credential that already has its identity costs no extra request.
    const known = fakeFetch(token);
    const kept = await refreshKiro(deps(known.fetch), { ...credentials, accountId: "user-1" });
    expect(known.calls).toHaveLength(1);
    expect(kept.accountId).toBeUndefined();

    // An identity lookup failure never fails the refresh.
    const failing = fakeFetch(call => (call.url.endsWith("/token") ? token() : json(500, { message: "down" })));
    const refreshed = await refreshKiro(deps(failing.fetch), credentials);
    expect(JSON.parse(refreshed.access).token).toBe("access-2");
    expect(refreshed.accountId).toBeUndefined();
  });

  test("reports every dead-grant refresh failure in a form OMP classifies as final", async () => {
    const bodies = [
      { error: "invalid_grant", error_description: "Invalid refresh token provided" },
      { error: "expired_token", error_description: null },
      { __type: "com.amazonaws.ssooidc#InvalidGrantException", message: "Invalid grant provided" },
    ];
    for (const body of bodies) {
      const { fetch } = fakeFetch(() => json(400, body));
      const failure = await refreshKiro(
        { fetch, now: () => 0, sleep: async () => {} },
        {
          access: JSON.stringify({ token: "a", region: "us-east-1" }),
          refresh: JSON.stringify({ refreshToken: "r", clientId: "c", clientSecret: "s", oidcRegion: "us-east-1", startUrl: "https://view.awsapps.com/start" }),
          expires: 0,
        },
      ).catch((error: unknown) => error);
      expect(isDefinitiveOAuthFailure(String(failure))).toBeTrue();
    }
    // A transient refresh failure must stay retryable.
    const { fetch } = fakeFetch(() => json(500, { message: "Service unavailable" }));
    const transient = await refreshKiro(
      { fetch, now: () => 0, sleep: async () => {} },
      {
        access: JSON.stringify({ token: "a", region: "us-east-1" }),
        refresh: JSON.stringify({ refreshToken: "r", clientId: "c", clientSecret: "s", oidcRegion: "us-east-1", startUrl: "https://view.awsapps.com/start" }),
        expires: 0,
      },
    ).catch((error: unknown) => error);
    expect(isDefinitiveOAuthFailure(String(transient))).toBeFalse();
  });
});

describe("Kiro model discovery", () => {
  test("lists account models from the profile's region with thinking metadata", async () => {
    // A missing or expired key must fail discovery: an empty success would wipe OMP's cached Kiro catalog.
    await expect(fetchKiroModels(fakeFetch(() => json(500, {})).fetch, undefined)).rejects.toThrow("not signed in");
    const { fetch, calls } = fakeFetch(() =>
      json(200, {
        models: [
          {
            modelId: "claude-sonnet-4.6",
            displayName: "Claude Sonnet 4.6",
            supportedInputTypes: ["TEXT", "IMAGE"],
            tokenLimits: { maxInputTokens: 1_000_000, maxOutputTokens: 64_000 },
            additionalModelRequestFieldsSchema: {
              properties: {
                output_config: { properties: { effort: { enum: ["low", "medium", "high", "max"] } } },
                thinking: { properties: { display: { enum: ["summarized", "omitted"] } } },
              },
            },
          },
          {
            modelId: "gpt-5.6-sol",
            additionalModelRequestFieldsSchema: JSON.stringify({ properties: { reasoning: { properties: { effort: { enum: ["low", "high"] } } } } }),
          },
          { modelId: "minimax-m2.5" },
        ],
      }),
    );
    const models = await fetchKiroModels(fetch, ACCESS_KEY);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://management.eu-central-1.kiro.dev/List-Available-Models");
    expect(url.searchParams.get("profileArn")).toBe(PROFILE_ARN);
    expect(models[0]).toMatchObject({
      id: "claude-sonnet-4.6",
      reasoning: true,
      thinking: { mode: "anthropic-adaptive", efforts: ["low", "medium", "high", "max"], supportsDisplay: true },
      input: ["text", "image"],
      contextWindow: 1_000_000,
      maxTokens: 64_000,
    });
    expect(models[1]).toMatchObject({ id: "gpt-5.6-sol", reasoning: true, thinking: { mode: "effort", efforts: ["low", "high"] } });
    expect(models[2]).toMatchObject({ id: "minimax-m2.5", reasoning: false, input: ["text"], contextWindow: 200_000 });
  });
});
