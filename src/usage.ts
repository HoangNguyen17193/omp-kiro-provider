import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageReport, UsageStatus } from "@oh-my-pi/pi-ai";
import { z } from "zod";
import { resolveProfile } from "./catalog";
import { KIRO_PROVIDER_ID, managementBaseUrl, parseAccessKey, regionFromProfileArn } from "./endpoints";
import { type FetchLike, requestJson } from "./http";

/**
 * Kiro credit quota for OMP's `/usage` and `omp usage`.
 *
 * Kiro meters each prompt in *credits* against the plan's monthly allowance;
 * the balance only exists behind `GetUsageLimits` on the management API, which
 * is why nothing appears in `/usage` until this provider is registered on the
 * `kiro` provider config. The per-response `meteringEvent` in `stream.ts` counts
 * only what one request burned, not what is left.
 */

/** Kiro's usage endpoint meters agentic requests; `AI_EDITOR` is what Kiro CLI sends. */
const USAGE_ORIGIN = "AI_EDITOR";
const USAGE_RESOURCE_TYPE = "AGENTIC_REQUEST";

// Kiro sends counts as JSON numbers, but a decimal as a string is tolerated the
// same way the rest of the API tolerates it, so both shapes parse.
const CountSchema = z.union([z.number(), z.string()]);
const ResetSchema = z.union([z.number(), z.string()]);

const BreakdownSchema = z.looseObject({
  resourceType: z.string().optional(),
  currentUsage: CountSchema.optional(),
  usageLimit: CountSchema.optional(),
  currentUsageWithPrecision: CountSchema.optional(),
  usageLimitWithPrecision: CountSchema.optional(),
  nextDateReset: ResetSchema.optional(),
});
const UsageLimitsSchema = z.looseObject({
  usageBreakdownList: z.array(BreakdownSchema).default([]),
  nextDateReset: ResetSchema.optional(),
  subscriptionInfo: z.looseObject({ subscriptionTitle: z.string().optional() }).optional(),
});
export type KiroUsageLimitsResponse = z.infer<typeof UsageLimitsSchema>;

export interface KiroUsageSnapshot {
  /** Credits spent in the current billing cycle. */
  usedCredits: number;
  /** Credits the plan grants this cycle (add-on credits included, as Kiro reports them). */
  totalCredits: number;
  remainingCredits: number;
  /** Epoch-millisecond reset timestamp, when Kiro returned a parseable date. */
  resetTimestampMs?: number | undefined;
  subscriptionTitle?: string | undefined;
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Kiro reports the reset as Unix seconds, milliseconds, or an ISO date
 * depending on the plan. Anything unparseable is dropped rather than shown as
 * a bogus countdown.
 */
function toResetTimestampMs(value: unknown): number | undefined {
  const numeric = toFiniteNumber(value);
  if (numeric !== undefined) return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Read the account's credit quota. The profile ARN decides which management
 * region answers, and is resolved from the stored credential when the envelope
 * does not carry one (bare-token `--api-key` logins).
 */
export async function fetchKiroUsage(
  fetchImpl: FetchLike,
  accessToken: string,
  region: string,
  profileArn: string | undefined,
  signal?: AbortSignal,
): Promise<KiroUsageSnapshot> {
  const arn = profileArn ?? (await resolveProfile(fetchImpl, accessToken, region, { builderId: false, signal })).arn;
  const apiRegion = regionFromProfileArn(arn) ?? region;
  const query = new URLSearchParams({
    origin: USAGE_ORIGIN,
    resourceType: USAGE_RESOURCE_TYPE,
    profileArn: arn,
  });
  const response = await requestJson(
    fetchImpl,
    {
      method: "GET",
      url: `${managementBaseUrl(apiRegion)}/GetUsageLimits?${query}`,
      headers: { Authorization: `Bearer ${accessToken}` },
      signal,
      label: "Kiro usage lookup",
    },
    UsageLimitsSchema,
  );
  const credit = response.usageBreakdownList.find(item => item.resourceType === "CREDIT");
  if (!credit) throw new Error(`Kiro usage lookup returned no credit breakdown in ${apiRegion}`);
  const used = toFiniteNumber(credit.currentUsageWithPrecision) ?? toFiniteNumber(credit.currentUsage);
  const total = toFiniteNumber(credit.usageLimitWithPrecision) ?? toFiniteNumber(credit.usageLimit);
  if (used === undefined || total === undefined) {
    throw new Error(`Kiro usage lookup returned an incomplete credit breakdown in ${apiRegion}`);
  }
  const resetTimestampMs = toResetTimestampMs(credit.nextDateReset) ?? toResetTimestampMs(response.nextDateReset);
  const snapshot: KiroUsageSnapshot = {
    usedCredits: used,
    totalCredits: total,
    remainingCredits: Math.max(total - used, 0),
  };
  if (resetTimestampMs !== undefined) snapshot.resetTimestampMs = resetTimestampMs;
  const subscriptionTitle = response.subscriptionInfo?.subscriptionTitle;
  if (subscriptionTitle) snapshot.subscriptionTitle = subscriptionTitle;
  return snapshot;
}

/**
 * OMP's `UsageUnit` union is narrower than the units the host itself emits —
 * its own usage providers report `credits`, and the shipped type definitions
 * have not caught up. Widen the amount and report locally instead of casting at
 * every call site.
 */
export type KiroCreditLimit = Omit<UsageLimit, "amount"> & {
  amount: Omit<UsageLimit["amount"], "unit"> & { unit: "credits" };
};
export interface KiroUsageReport extends Omit<UsageReport, "limits"> {
  limits: KiroCreditLimit[];
}

/**
 * Structural equivalent of the host's `UsageProvider`. The `usage` field on a
 * `registerProvider` config is additive: hosts that predate it ignore the
 * field, and this module never imports the (unpublished) registry type.
 */
export interface KiroUsageProvider {
  id: string;
  fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<KiroUsageReport | null>;
  supports?(params: UsageFetchParams): boolean;
  validatesCredentials?: boolean;
}

function usageStatusFor(usedFraction: number | undefined): UsageStatus {
  if (usedFraction === undefined) return "unknown";
  if (usedFraction >= 1) return "exhausted";
  if (usedFraction >= 0.9) return "warning";
  return "ok";
}

/**
 * Only OAuth credentials carrying the plugin's access envelope can back a Kiro
 * report: an API-key credential has no refresh token, so a rejected token could
 * not be recovered by the host before the lookup.
 */
function supportsKiroUsage(params: UsageFetchParams): boolean {
  return (
    params.provider === KIRO_PROVIDER_ID && params.credential.type === "oauth" && Boolean(params.credential.accessToken)
  );
}

/**
 * `fetchUsage` implementation for the `kiro` provider.
 *
 * A credential that is not signed in, or whose envelope cannot be parsed,
 * reports `null` ("no data") instead of throwing, so a stale or hand-written
 * `--api-key` never reads as a usage outage. A rejected token does throw: the
 * host refreshes the credential and retries, and a genuinely dead grant should
 * surface rather than silently hide the balance.
 */
export async function fetchKiroUsageReport(
  params: UsageFetchParams,
  ctx: UsageFetchContext,
): Promise<KiroUsageReport | null> {
  if (!supportsKiroUsage(params)) return null;
  const credential = params.credential;
  const raw = credential.accessToken?.trim();
  if (!raw) return null;
  let access;
  try {
    access = parseAccessKey(raw);
  } catch {
    return null;
  }
  const region = (access.profileArn ? regionFromProfileArn(access.profileArn) : undefined) ?? access.region;
  const snapshot = await fetchKiroUsage(ctx.fetch, access.token, region, access.profileArn, params.signal);
  const usedFraction = snapshot.totalCredits > 0 ? snapshot.usedCredits / snapshot.totalCredits : undefined;
  const remainingFraction =
    snapshot.totalCredits > 0 ? snapshot.remainingCredits / snapshot.totalCredits : undefined;
  const limit: KiroCreditLimit = {
    id: "credits",
    label: "Credits",
    scope: {
      provider: KIRO_PROVIDER_ID,
      ...(snapshot.subscriptionTitle ? { tier: snapshot.subscriptionTitle } : {}),
      ...(credential.accountId ? { accountId: credential.accountId } : {}),
      ...(credential.projectId ? { projectId: credential.projectId } : {}),
      ...(credential.orgId ? { orgId: credential.orgId } : {}),
    },
    window: {
      id: "monthly",
      label: "Monthly",
      ...(snapshot.resetTimestampMs !== undefined ? { resetsAt: snapshot.resetTimestampMs } : {}),
    },
    amount: {
      used: snapshot.usedCredits,
      limit: snapshot.totalCredits,
      remaining: snapshot.remainingCredits,
      ...(usedFraction !== undefined ? { usedFraction } : {}),
      ...(remainingFraction !== undefined ? { remainingFraction } : {}),
      unit: "credits",
    },
    status: usageStatusFor(usedFraction),
  };
  return {
    provider: KIRO_PROVIDER_ID,
    fetchedAt: Date.now(),
    limits: [limit],
    metadata: {
      region,
      ...(credential.email ? { email: credential.email } : {}),
      ...(snapshot.subscriptionTitle ? { subscriptionTitle: snapshot.subscriptionTitle } : {}),
    },
  };
}

/** Registered as the `usage` field of the `kiro` provider config. */
export const kiroUsageProvider: KiroUsageProvider = {
  id: KIRO_PROVIDER_ID,
  supports: supportsKiroUsage,
  validatesCredentials: true,
  fetchUsage: fetchKiroUsageReport,
};
