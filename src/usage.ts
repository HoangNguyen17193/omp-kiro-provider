import type { UsageFetchContext, UsageFetchParams, UsageLimit, UsageProvider, UsageReport, UsageStatus } from "@oh-my-pi/pi-ai";
import { z } from "zod";
import { profileFor } from "./catalog";
import { type KiroAccessEnvelope, KIRO_PROVIDER_ID, managementBaseUrl, parseAccessKey } from "./endpoints";
import { type FetchLike, requestJson } from "./http";

/**
 * Account credit usage for `omp usage` and `/usage`, from Kiro's
 * `Get-Usage-Limits` management endpoint. OMP refreshes an expiring OAuth
 * credential before calling `fetchUsage`, so the stored access envelope is
 * used as-is. The same response names the signed-in user, which is the only
 * identity Kiro exposes: the token is opaque and carries no claims.
 */

const WARNING_FRACTION = 0.9;

/** Kiro reports reset times as epoch seconds or ISO strings. */
const EpochSchema = z.union([z.number(), z.string()]).nullish();
const CountSchema = z.number().nullish();

const FreeTrialSchema = z.looseObject({
  freeTrialStatus: z.string().nullish(),
  freeTrialExpiry: EpochSchema,
  currentUsage: CountSchema,
  currentUsageWithPrecision: CountSchema,
  usageLimit: CountSchema,
  usageLimitWithPrecision: CountSchema,
});

const BreakdownSchema = z.looseObject({
  resourceType: z.string().nullish(),
  displayName: z.string().nullish(),
  displayNamePlural: z.string().nullish(),
  currentUsage: CountSchema,
  currentUsageWithPrecision: CountSchema,
  usageLimit: CountSchema,
  usageLimitWithPrecision: CountSchema,
  currentOverages: CountSchema,
  currentOveragesWithPrecision: CountSchema,
  nextDateReset: EpochSchema,
  freeTrialInfo: FreeTrialSchema.nullish(),
});

const UsageLimitsSchema = z.looseObject({
  nextDateReset: EpochSchema,
  usageBreakdownList: z.array(BreakdownSchema).nullish(),
  usageBreakdown: BreakdownSchema.nullish(),
  subscriptionInfo: z.looseObject({ subscriptionTitle: z.string().nullish() }).nullish(),
  overageConfiguration: z.looseObject({ overageStatus: z.string().nullish() }).nullish(),
  userInfo: z.looseObject({ email: z.string().nullish(), userId: z.string().nullish() }).nullish(),
});
type UsageLimits = z.infer<typeof UsageLimitsSchema>;
type Breakdown = z.infer<typeof BreakdownSchema>;

function toMillis(value: z.infer<typeof EpochSchema>): number | undefined {
  if (value === null || value === undefined) return undefined;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function statusFor(used: number | undefined, limit: number | undefined): UsageStatus {
  if (used === undefined || !limit) return "unknown";
  if (used >= limit) return "exhausted";
  return used / limit >= WARNING_FRACTION ? "warning" : "ok";
}

function creditLimit(input: {
  id: string;
  label: string;
  used: number | undefined;
  limit: number | undefined;
  resetsAt: number | undefined;
  windowLabel: string;
  tier: string | undefined;
  notes: string[];
}): UsageLimit {
  const { used, limit } = input;
  const usage: UsageLimit = {
    id: input.id,
    label: input.label,
    scope: { provider: KIRO_PROVIDER_ID, ...(input.tier ? { tier: input.tier } : {}) },
    amount: {
      unit: "credits",
      ...(used !== undefined ? { used } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(used !== undefined && limit ? { remaining: Math.max(0, limit - used), usedFraction: used / limit } : {}),
    },
    status: statusFor(used, limit),
  };
  if (input.resetsAt !== undefined) {
    usage.window = { id: input.id, label: input.windowLabel, resetsAt: input.resetsAt };
  }
  if (input.notes.length > 0) usage.notes = input.notes;
  return usage;
}

function limitsFor(bucket: Breakdown, index: number, tier: string | undefined, fallbackReset: number | undefined): UsageLimit[] {
  const id = `kiro:${(bucket.resourceType ?? `usage-${index}`).toLowerCase()}`;
  const overages = bucket.currentOveragesWithPrecision ?? bucket.currentOverages ?? 0;
  const limits = [
    creditLimit({
      id,
      label: bucket.displayNamePlural ?? bucket.displayName ?? "Credits",
      used: bucket.currentUsageWithPrecision ?? bucket.currentUsage ?? undefined,
      limit: bucket.usageLimitWithPrecision ?? bucket.usageLimit ?? undefined,
      resetsAt: toMillis(bucket.nextDateReset) ?? fallbackReset,
      windowLabel: "Monthly",
      tier,
      notes: overages > 0 ? [`Overage: ${overages}`] : [],
    }),
  ];
  const trial = bucket.freeTrialInfo;
  const trialLimit = trial?.usageLimitWithPrecision ?? trial?.usageLimit ?? undefined;
  if (trial && trialLimit) {
    limits.push(
      creditLimit({
        id: `${id}:bonus`,
        label: "Bonus credits",
        used: trial.currentUsageWithPrecision ?? trial.currentUsage ?? undefined,
        limit: trialLimit,
        resetsAt: toMillis(trial.freeTrialExpiry),
        windowLabel: "Bonus",
        tier,
        notes: trial.freeTrialStatus ? [`Status: ${trial.freeTrialStatus}`] : [],
      }),
    );
  }
  return limits;
}

/**
 * The signed-in user: the Builder ID or IAM Identity Center user id (stable,
 * unique per user) and email. OMP keys a stored credential by `accountId`, so
 * signing the same user in again replaces its row instead of adding one.
 */
export interface KiroIdentity {
  email?: string;
  accountId?: string;
}

async function requestUsageLimits(fetchImpl: FetchLike, access: KiroAccessEnvelope, signal: AbortSignal | undefined): Promise<UsageLimits> {
  const profile = await profileFor(fetchImpl, access, signal);
  const query = new URLSearchParams({
    origin: "KIRO_CLI",
    resourceType: "CREDIT",
    isEmailRequired: "true",
    profileArn: profile.arn,
  });
  return requestJson(
    fetchImpl,
    {
      method: "GET",
      url: `${managementBaseUrl(profile.region)}/Get-Usage-Limits?${query}`,
      headers: { Authorization: `Bearer ${access.token}` },
      signal,
      label: "Kiro usage",
    },
    UsageLimitsSchema,
  );
}

function identityFrom(raw: UsageLimits): KiroIdentity {
  const email = raw.userInfo?.email?.trim();
  const accountId = raw.userInfo?.userId?.trim();
  return { ...(email ? { email } : {}), ...(accountId ? { accountId } : {}) };
}

/** The user Kiro reports for `access`; empty when Kiro names none. */
export async function fetchKiroIdentity(fetchImpl: FetchLike, access: KiroAccessEnvelope, signal?: AbortSignal): Promise<KiroIdentity> {
  return identityFrom(await requestUsageLimits(fetchImpl, access, signal));
}

export async function fetchKiroUsage(
  fetchImpl: FetchLike,
  apiKey: string,
  now: number,
  signal?: AbortSignal,
): Promise<UsageReport> {
  const raw = await requestUsageLimits(fetchImpl, parseAccessKey(apiKey), signal);
  const tier = raw.subscriptionInfo?.subscriptionTitle ?? undefined;
  const buckets = raw.usageBreakdownList ?? (raw.usageBreakdown ? [raw.usageBreakdown] : []);
  const fallbackReset = toMillis(raw.nextDateReset);
  const report: UsageReport = {
    provider: KIRO_PROVIDER_ID,
    fetchedAt: now,
    limits: buckets.flatMap((bucket, index) => limitsFor(bucket, index, tier, fallbackReset)),
    metadata: {
      // OMP's usage identity (email, accountId) tells same-plan accounts apart.
      ...identityFrom(raw),
      ...(tier ? { subscription: tier } : {}),
      ...(raw.overageConfiguration?.overageStatus ? { overageStatus: raw.overageConfiguration.overageStatus } : {}),
    },
  };
  if (tier) report.notes = [`Plan: ${tier}`];
  return report;
}

/** The `usage` entry for `pi.registerProvider("kiro", …)`. */
export function kiroUsageProvider(now: () => number): UsageProvider {
  return {
    id: KIRO_PROVIDER_ID,
    validatesCredentials: true,
    async fetchUsage(params: UsageFetchParams, ctx: UsageFetchContext): Promise<UsageReport | null> {
      const key = params.credential.accessToken ?? params.credential.apiKey;
      if (!key) return null;
      return fetchKiroUsage(ctx.fetch, key, now(), params.signal);
    },
  };
}
