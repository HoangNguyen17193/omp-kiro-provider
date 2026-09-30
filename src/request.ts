import { createHash } from "node:crypto";
import type { Api, Context, ImageContent, Message, Model, SimpleStreamOptions, TextContent, Tool } from "@oh-my-pi/pi-ai";
import { EFFORT_LADDER, type EffortLevel } from "./catalog";

/**
 * Converts an OMP conversation into Kiro's `generateAssistantResponse` body.
 *
 * Kiro enforces first-party conversation invariants and rejects violations
 * with `400 Improperly formed request.` / `TOOL_USE_RESULT_MISMATCH`:
 * history starts and ends with a user turn, roles alternate, every assistant
 * tool use is answered by a result in the next user turn, no result lacks its
 * tool use, and every user turn has content or tool results. The builder
 * normalizes history into that shape instead of hoping the transcript fits.
 */

const ORIGIN = "KIRO_CLI";
const EMPTY_TURN_PLACEHOLDER = "Please proceed with the task.";
const INTERRUPTED_RESULT = "Tool use was interrupted and did not produce a result.";
const IMAGE_OMITTED = "[image omitted]";
/** Kiro rejects larger tool results; keep the head and tail around a marker. */
const MAX_TOOL_RESULT_CHARS = 250_000;
const TOOL_USE_ID_PATTERN = /^[a-zA-Z0-9_.:-]{1,64}$/;

export interface KiroImage {
  format: string;
  source: { bytes: string };
}
export interface KiroToolResult {
  toolUseId: string;
  content: { text: string }[];
  status: "success" | "error";
}
export interface KiroToolUse {
  toolUseId: string;
  name: string;
  input: Record<string, unknown>;
}
export interface KiroToolSpec {
  toolSpecification: { name: string; description: string; inputSchema: { json: Record<string, unknown> } };
}

interface UserTurn {
  role: "user";
  text: string[];
  images: KiroImage[];
  toolResults: KiroToolResult[];
}
interface AssistantTurn {
  role: "assistant";
  text: string[];
  toolUses: KiroToolUse[];
}
type Turn = UserTurn | AssistantTurn;

export interface KiroRequestDeps {
  /** OMP's JSON-Schema projection of a tool's parameters (`toolWireSchema`). */
  toolSchema(tool: Tool): Record<string, unknown>;
  conversationId: string;
  profileArn: string;
}

/** Kiro tool-use ids must match {@link TOOL_USE_ID_PATTERN}; remap foreign ids deterministically. */
export function kiroToolUseId(id: string): string {
  if (TOOL_USE_ID_PATTERN.test(id)) return id;
  return `t_${createHash("sha256").update(id).digest("base64url").slice(0, 40)}`;
}

function truncateToolResult(text: string): string {
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  const half = Math.floor(MAX_TOOL_RESULT_CHARS / 2);
  return `${text.slice(0, half)}\n[TRUNCATED ${text.length - MAX_TOOL_RESULT_CHARS} characters]\n${text.slice(-half)}`;
}

function toKiroImage(image: ImageContent): KiroImage {
  return { format: image.mimeType.split("/")[1] ?? "png", source: { bytes: image.data } };
}

function userTurnFrom(content: string | (TextContent | ImageContent)[]): UserTurn {
  const turn: UserTurn = { role: "user", text: [], images: [], toolResults: [] };
  if (typeof content === "string") {
    turn.text.push(content);
    return turn;
  }
  for (const block of content) {
    if (block.type === "text") turn.text.push(block.text);
    else turn.images.push(toKiroImage(block));
  }
  return turn;
}

function turnFrom(message: Message): Turn | undefined {
  switch (message.role) {
    case "user":
    case "developer":
      return userTurnFrom(message.content);
    case "toolResult": {
      const text = message.content.map(block => (block.type === "text" ? block.text : IMAGE_OMITTED)).join("\n");
      return {
        role: "user",
        text: [],
        images: [],
        toolResults: [{
          toolUseId: kiroToolUseId(message.toolCallId),
          content: [{ text: truncateToolResult(text) }],
          status: message.isError ? "error" : "success",
        }],
      };
    }
    case "assistant": {
      // A failed turn holds partial output the model never finished; replaying it misleads.
      if (message.stopReason === "error") return undefined;
      const turn: AssistantTurn = { role: "assistant", text: [], toolUses: [] };
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) turn.text.push(block.text);
        else if (block.type === "toolCall") {
          turn.toolUses.push({ toolUseId: kiroToolUseId(block.id), name: block.name, input: block.arguments });
        }
      }
      return turn.text.length > 0 || turn.toolUses.length > 0 ? turn : undefined;
    }
  }
}

/** Merge same-role neighbours so roles alternate. */
function mergeTurns(messages: readonly Message[]): Turn[] {
  const turns: Turn[] = [];
  for (const message of messages) {
    const turn = turnFrom(message);
    if (!turn) continue;
    const previous = turns.at(-1);
    if (previous?.role === "user" && turn.role === "user") {
      previous.text.push(...turn.text);
      previous.images.push(...turn.images);
      previous.toolResults.push(...turn.toolResults);
    } else if (previous?.role === "assistant" && turn.role === "assistant") {
      previous.text.push(...turn.text);
      previous.toolUses.push(...turn.toolUses);
    } else {
      turns.push(turn);
    }
  }
  return turns;
}

/**
 * Kiro rejects a conversation that reuses a tool-use id. Providers that mint
 * per-response ids (`call_0`) reuse them across turns, so a repeated id gets a
 * deterministic replacement, and the following user turn's results are
 * re-pointed in order so pairing still holds.
 */
function dedupeToolUseIds(turns: Turn[]): void {
  const seen = new Set<string>();
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index]!;
    if (turn.role !== "assistant") continue;
    const assigned = new Map<string, string[]>();
    for (const use of turn.toolUses) {
      let id = use.toolUseId;
      for (let attempt = 1; seen.has(id); attempt++) id = kiroToolUseId(`${use.toolUseId}#${index}.${attempt}`);
      seen.add(id);
      assigned.set(use.toolUseId, [...(assigned.get(use.toolUseId) ?? []), id]);
      use.toolUseId = id;
    }
    const next = turns[index + 1];
    if (next?.role !== "user") continue;
    for (const result of next.toolResults) {
      const id = assigned.get(result.toolUseId)?.shift();
      if (id) result.toolUseId = id;
    }
  }
}

/**
 * Enforce Kiro's pairing invariants: each user turn carries exactly one result
 * per tool use of the assistant turn before it, in order, and nothing else.
 * Missing results become explicit interrupted-tool errors.
 */
function pairToolResults(turns: Turn[]): void {
  for (let index = 0; index < turns.length; index++) {
    const turn = turns[index]!;
    if (turn.role !== "user") continue;
    const previous = turns[index - 1];
    const uses = previous?.role === "assistant" ? previous.toolUses : [];
    const byId = new Map(turn.toolResults.map(result => [result.toolUseId, result]));
    turn.toolResults = uses.map(use => byId.get(use.toolUseId) ?? {
      toolUseId: use.toolUseId,
      content: [{ text: INTERRUPTED_RESULT }],
      status: "error",
    });
  }
}

function normalizedTurns(context: Context): Turn[] {
  const turns = mergeTurns(context.messages);
  if (turns[0]?.role !== "user") turns.unshift({ role: "user", text: [EMPTY_TURN_PLACEHOLDER], images: [], toolResults: [] });
  if (turns.at(-1)?.role !== "user") turns.push({ role: "user", text: [], images: [], toolResults: [] });
  dedupeToolUseIds(turns);
  pairToolResults(turns);
  const system = context.systemPrompt?.filter(part => part.trim()).join("\n\n");
  const first = turns[0] as UserTurn;
  if (system) first.text.unshift(system);
  return turns;
}

function userContent(turn: UserTurn): string {
  const content = turn.text.join("\n\n");
  return content === "" && turn.toolResults.length === 0 ? EMPTY_TURN_PLACEHOLDER : content;
}

function toolSpecs(context: Context, turns: readonly Turn[], deps: KiroRequestDeps): KiroToolSpec[] {
  const specs: KiroToolSpec[] = (context.tools ?? []).map(tool => ({
    toolSpecification: {
      name: tool.name,
      description: tool.description || tool.name,
      inputSchema: { json: deps.toolSchema(tool) },
    },
  }));
  // Kiro rejects history that names a tool the current request does not declare.
  const declared = new Set(specs.map(spec => spec.toolSpecification.name));
  for (const turn of turns) {
    if (turn.role !== "assistant") continue;
    for (const use of turn.toolUses) {
      if (declared.has(use.name)) continue;
      declared.add(use.name);
      specs.push({
        toolSpecification: {
          name: use.name,
          description: "Tool no longer available.",
          inputSchema: { json: { type: "object", properties: {} } },
        },
      });
    }
  }
  return specs;
}

/** Nearest allowed effort at or above `wanted`, else the highest below it. */
export function pickEffort(allowed: readonly string[], wanted: EffortLevel): string | undefined {
  const rank = (effort: string) => EFFORT_LADDER.indexOf(effort as EffortLevel);
  const ranked = allowed.filter(effort => rank(effort) >= 0).sort((a, b) => rank(a) - rank(b));
  return ranked.find(effort => rank(effort) >= rank(wanted)) ?? ranked.at(-1);
}

export function requestFieldsFor(
  model: Model<Api>,
  options: SimpleStreamOptions | undefined,
): Record<string, unknown> | undefined {
  const thinking = model.thinking;
  if (!model.reasoning || !thinking || options?.disableReasoning || !options?.reasoning) return undefined;
  const effort = pickEffort(thinking.efforts, options.reasoning as EffortLevel);
  if (!effort) return undefined;
  if (thinking.mode === "effort") return { reasoning: { effort } };
  const display = thinking.supportsDisplay && !options.hideThinkingSummary ? { display: "summarized" } : {};
  return { output_config: { effort }, thinking: { type: "adaptive", ...display } };
}

export function buildKiroRequest(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  deps: KiroRequestDeps,
): Record<string, unknown> {
  const modelId = model.requestModelId ?? model.id;
  const turns = normalizedTurns(context);
  const current = turns.at(-1) as UserTurn;
  const tools = toolSpecs(context, turns, deps);

  const history = turns.slice(0, -1).map(turn => {
    if (turn.role === "assistant") {
      return {
        assistantResponseMessage: {
          content: turn.text.join("\n\n"),
          ...(turn.toolUses.length > 0 ? { toolUses: turn.toolUses } : {}),
        },
      };
    }
    // Only the current turn carries image bytes; history keeps a marker to bound request size.
    const text = turn.images.length > 0 ? [...turn.text, IMAGE_OMITTED] : turn.text;
    return {
      userInputMessage: {
        content: userContent({ ...turn, text }),
        modelId,
        origin: ORIGIN,
        ...(turn.toolResults.length > 0 ? { userInputMessageContext: { toolResults: turn.toolResults } } : {}),
      },
    };
  });

  const currentContext = {
    ...(tools.length > 0 ? { tools } : {}),
    ...(current.toolResults.length > 0 ? { toolResults: current.toolResults } : {}),
  };
  const body: Record<string, unknown> = {
    conversationState: {
      chatTriggerType: "MANUAL",
      agentTaskType: "vibe",
      conversationId: deps.conversationId,
      ...(history.length > 0 ? { history } : {}),
      currentMessage: {
        userInputMessage: {
          content: userContent(current),
          modelId,
          origin: ORIGIN,
          ...(current.images.length > 0 ? { images: current.images } : {}),
          ...(Object.keys(currentContext).length > 0 ? { userInputMessageContext: currentContext } : {}),
        },
      },
    },
    profileArn: deps.profileArn,
    agentMode: "vibe",
  };
  const fields = requestFieldsFor(model, options);
  if (fields) body.additionalModelRequestFields = fields;
  return body;
}
