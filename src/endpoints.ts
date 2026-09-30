import { z } from "zod";

/**
 * Kiro hosts, region mapping, and the credential envelopes this plugin stores in
 * OMP's `/login` credential store. Nothing here touches the network.
 *
 * Kiro serves its management and runtime APIs from two regions; an SSO/OIDC
 * region maps onto one of them. The runtime host must follow the profile
 * ARN's region, otherwise Kiro answers `400 Improperly formed request.`
 */

export const KIRO_PROVIDER_ID = "kiro";
export const KIRO_API_ID = "kiro-generate-assistant-response";
export const KIRO_DEFAULT_REGION = "us-east-1";
export const BUILDER_ID_START_URL = "https://view.awsapps.com/start";
/**
 * Public placeholder profile Kiro accepts for AWS Builder ID accounts, which
 * may have no listable profile of their own.
 */
export const BUILDER_ID_PROFILE_ARN = "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";

const API_REGION_BY_SSO_REGION: Record<string, string> = {
  "us-east-1": "us-east-1",
  "us-east-2": "us-east-1",
  "us-west-1": "us-east-1",
  "us-west-2": "us-east-1",
  "ca-central-1": "us-east-1",
  "sa-east-1": "us-east-1",
  "ap-northeast-1": "us-east-1",
  "ap-northeast-2": "us-east-1",
  "ap-south-1": "us-east-1",
  "ap-southeast-1": "us-east-1",
  "ap-southeast-2": "us-east-1",
  "eu-central-1": "eu-central-1",
  "eu-west-1": "eu-central-1",
  "eu-west-2": "eu-central-1",
  "eu-west-3": "eu-central-1",
  "eu-north-1": "eu-central-1",
  "eu-south-1": "eu-central-1",
};

const REGION_PATTERN = /^[a-z]{2}(-[a-z]+)+-\d$/;

export function apiRegionFor(ssoRegion: string | undefined): string {
  if (!ssoRegion) return KIRO_DEFAULT_REGION;
  return API_REGION_BY_SSO_REGION[ssoRegion] ?? ssoRegion;
}

/** Region field of `arn:aws:codewhisperer:<region>:<account>:profile/<id>`. */
export function regionFromProfileArn(arn: string): string | undefined {
  const region = arn.split(":")[3];
  return region && REGION_PATTERN.test(region) ? region : undefined;
}

export function oidcBaseUrl(region: string): string {
  return `https://oidc.${region}.amazonaws.com`;
}

export function managementBaseUrl(region: string): string {
  return `https://management.${region}.kiro.dev`;
}

export function runtimeBaseUrl(region: string): string {
  return `https://runtime.${region}.kiro.dev`;
}

export const RegionSchema = z.string().regex(REGION_PATTERN);

/**
 * Stored as `OAuthCredentials.access`. OMP hands `access` verbatim to model
 * discovery (`peekApiKey`) and to the stream as `apiKey`, so the envelope
 * carries the region and profile both paths need.
 */
export const KiroAccessEnvelopeSchema = z.object({
  token: z.string().min(1),
  /** Kiro API region used for management calls. */
  region: RegionSchema,
  profileArn: z.string().min(1).optional(),
});
export type KiroAccessEnvelope = z.infer<typeof KiroAccessEnvelopeSchema>;

/** Stored as `OAuthCredentials.refresh`: everything a token refresh needs. */
export const KiroRefreshEnvelopeSchema = z.object({
  refreshToken: z.string().min(1),
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /** OIDC region the client was registered in; refresh must use the same one. */
  oidcRegion: RegionSchema,
  startUrl: z.url(),
});
export type KiroRefreshEnvelope = z.infer<typeof KiroRefreshEnvelopeSchema>;

function parseEnvelope<T>(raw: string, schema: z.ZodType<T>, label: string): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Kiro ${label} is not valid JSON; run /login and choose Kiro again`);
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error(`Kiro ${label} is incomplete; run /login and choose Kiro again`);
  return result.data;
}

/**
 * Accepts the plugin's envelope or a bare bearer token (e.g. `--api-key`), in
 * which case the default region applies and the profile is discovered.
 */
export function parseAccessKey(apiKey: string): KiroAccessEnvelope {
  const trimmed = apiKey.trim();
  if (!trimmed.startsWith("{")) return { token: trimmed, region: KIRO_DEFAULT_REGION };
  return parseEnvelope(trimmed, KiroAccessEnvelopeSchema, "credential");
}

export function parseRefreshEnvelope(refresh: string): KiroRefreshEnvelope {
  return parseEnvelope(refresh, KiroRefreshEnvelopeSchema, "refresh credential");
}
