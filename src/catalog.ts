import type { Model } from "@oh-my-pi/pi-ai";
import { z } from "zod";
import {
  BUILDER_ID_PROFILE_ARN,
  KIRO_DEFAULT_REGION,
  managementBaseUrl,
  parseAccessKey,
  regionFromProfileArn,
} from "./endpoints";
import { type FetchLike, KiroHttpError, requestJson } from "./http";

/** Model entry in the shape `pi.registerProvider` accepts. */
export interface KiroModelConfig {
  id: string;
  name: string;
  reasoning: boolean;
  thinking?: NonNullable<Model["thinking"]>;
  input: ("text" | "image")[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8_192;
/** User-facing effort ladder, least → most intensive (mirrors OMP's `Effort`). */
export const EFFORT_LADDER = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type EffortLevel = (typeof EFFORT_LADDER)[number];

const ProfilesSchema = z.looseObject({
  profiles: z.array(z.looseObject({ arn: z.string().optional() })).default([]),
});

const ModelSchema = z.looseObject({
  modelId: z.string().min(1),
  modelName: z.string().optional(),
  displayName: z.string().optional(),
  supportedInputTypes: z.array(z.string()).optional(),
  tokenLimits: z
    .looseObject({
      maxInputTokens: z.number().int().positive().optional(),
      maxOutputTokens: z.number().int().positive().optional(),
    })
    .optional(),
  additionalModelRequestFieldsSchema: z.unknown().optional(),
});
const ModelsSchema = z.looseObject({ models: z.array(ModelSchema).min(1) });
export type KiroCatalogModel = z.infer<typeof ModelSchema>;

export interface ProfileResolution {
  arn: string;
  /** Region to call the runtime and model catalog in (the profile ARN's region). */
  region: string;
}

/**
 * Find the account's Kiro profile. Profiles live in one of Kiro's API regions,
 * so probe the credential's region first, then both API regions; a 403 means
 * "no profile here". AWS Builder ID accounts may have no listable profile and
 * fall back to Kiro's public Builder ID placeholder profile.
 */
export async function resolveProfile(
  fetchImpl: FetchLike,
  token: string,
  region: string,
  options: { builderId: boolean; signal?: AbortSignal | undefined },
): Promise<ProfileResolution> {
  const candidates = [...new Set([region, KIRO_DEFAULT_REGION, "eu-central-1"])];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      const { profiles } = await requestJson(
        fetchImpl,
        {
          method: "POST",
          url: `${managementBaseUrl(candidate)}/List-Available-Profiles`,
          headers: { Authorization: `Bearer ${token}` },
          body: {},
          signal: options.signal,
          label: "Kiro profile discovery",
        },
        ProfilesSchema,
      );
      const arn = profiles.find(profile => profile.arn)?.arn;
      if (arn) return { arn, region: regionFromProfileArn(arn) ?? candidate };
    } catch (error) {
      if (!(error instanceof KiroHttpError) || (error.status !== 403 && !options.builderId)) throw error;
      lastError = error;
    }
  }
  if (options.builderId) return { arn: BUILDER_ID_PROFILE_ARN, region: KIRO_DEFAULT_REGION };
  throw new Error("No Kiro profile is available for this account", { cause: lastError });
}

/** String enum at `path` inside a JSON Schema document, if present. */
function enumAt(root: unknown, path: readonly string[]): string[] | undefined {
  let node = root;
  for (const key of path) {
    if (typeof node !== "object" || node === null) return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return Array.isArray(node) && node.every(value => typeof value === "string") ? node : undefined;
}

/**
 * Derive OMP thinking metadata from Kiro's `additionalModelRequestFieldsSchema`.
 * `reasoning.effort` models (GPT family) map to `effort` mode; Claude-style
 * `output_config.effort` models map to `anthropic-adaptive`. The mode is the
 * only standard field that survives OMP's model cache, so the stream reads the
 * wire field choice back from it.
 */
export function thinkingFromSchema(raw: unknown): NonNullable<Model["thinking"]> | undefined {
  let schema = raw;
  if (typeof schema === "string") {
    try {
      schema = JSON.parse(schema);
    } catch {
      return undefined;
    }
  }
  const reasoning = enumAt(schema, ["properties", "reasoning", "properties", "effort", "enum"]);
  const outputConfig = enumAt(schema, ["properties", "output_config", "properties", "effort", "enum"]);
  const wire = reasoning ?? outputConfig;
  if (!wire) return undefined;
  const efforts = EFFORT_LADDER.filter(effort => wire.includes(effort));
  if (efforts.length === 0) return undefined;
  const thinking = {
    mode: reasoning ? "effort" : "anthropic-adaptive",
    efforts,
  } as unknown as NonNullable<Model["thinking"]>;
  const display = enumAt(schema, ["properties", "thinking", "properties", "display", "enum"]);
  if (!reasoning && display?.includes("summarized")) thinking.supportsDisplay = true;
  return thinking;
}

export function toModelConfig(model: KiroCatalogModel): KiroModelConfig {
  const thinking = thinkingFromSchema(model.additionalModelRequestFieldsSchema);
  const config: KiroModelConfig = {
    id: model.modelId,
    name: `${model.displayName ?? model.modelName ?? model.modelId} (Kiro)`,
    reasoning: thinking !== undefined,
    input: model.supportedInputTypes?.some(type => type.toUpperCase() === "IMAGE") ? ["text", "image"] : ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.tokenLimits?.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.tokenLimits?.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (thinking) config.thinking = thinking;
  return config;
}

/**
 * `fetchDynamicModels` implementation.
 *
 * A missing key fails discovery rather than returning an empty catalog. OMP
 * hands discovery the stored access token only while it is unexpired and never
 * refreshes it there, and Kiro discovery is authoritative: an empty success
 * would wipe the cached catalog the day after login, leaving no Kiro model to
 * select and so no request that could trigger a refresh. A failure keeps the
 * cached catalog; selecting a model refreshes the token through `/login` state.
 */
export async function fetchKiroModels(
  fetchImpl: FetchLike,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<KiroModelConfig[]> {
  if (!apiKey) throw new Error("Kiro is not signed in or its token has expired; model discovery deferred (run /login to sign in)");
  const access = parseAccessKey(apiKey);
  const profile = access.profileArn
    ? { arn: access.profileArn, region: regionFromProfileArn(access.profileArn) ?? access.region }
    : await resolveProfile(fetchImpl, access.token, access.region, { builderId: false, signal });
  const query = new URLSearchParams({ origin: "KIRO_CLI", profileArn: profile.arn });
  const { models } = await requestJson(
    fetchImpl,
    {
      method: "GET",
      url: `${managementBaseUrl(profile.region)}/List-Available-Models?${query}`,
      headers: { Authorization: `Bearer ${access.token}` },
      signal,
      label: "Kiro model discovery",
    },
    ModelsSchema,
  );
  return models.map(toModelConfig);
}
