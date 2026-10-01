import { describe, expect, test } from "bun:test";
import type { UsageFetchParams } from "@oh-my-pi/pi-ai";
import { KIRO_DEFAULT_REGION } from "../src/endpoints";
import { fetchKiroUsage, kiroUsageProvider } from "../src/usage";
import { fakeFetch, json, PROFILE_ARN, usageContext } from "./fakes";

const ACCESS_KEY = JSON.stringify({ token: "test-access", region: "eu-central-1", profileArn: PROFILE_ARN });
const MANAGEMENT_URL = `https://management.eu-central-1.kiro.dev/GetUsageLimits`;

/** A stored OAuth credential whose `access` carries the plugin's envelope. */
function usageParams(overrides: { provider?: string; accessToken?: string; type?: "oauth" | "api_key" } = {}) {
  const credential = {
    type: overrides.type ?? "oauth",
    accessToken: overrides.accessToken ?? ACCESS_KEY,
    email: "dev@example.com",
  };
  return {
    provider: overrides.provider ?? "kiro",
    credential,
    baseUrl: `https://runtime.${KIRO_DEFAULT_REGION}.kiro.dev`,
  } as unknown as UsageFetchParams;
}

const creditResponse = {
  usageBreakdownList: [
    { resourceType: "AGENTIC_REQUEST", currentUsage: 40, usageLimit: 100 },
    { resourceType: "CREDIT", currentUsage: 320.5, usageLimit: 1000, nextDateReset: "2026-11-01T00:00:00.000Z" },
  ],
  subscriptionInfo: { subscriptionTitle: "Kiro Pro" },
};

describe("Kiro credit quota", () => {
  test("reads the account's credit breakdown from the management API", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, creditResponse));
    const snapshot = await fetchKiroUsage(fetch, "test-access", "eu-central-1", PROFILE_ARN);
    expect(calls).toHaveLength(1);
    const url = new URL(calls[0]!.url);
    expect(`${url.origin}${url.pathname}`).toBe(MANAGEMENT_URL);
    expect(url.searchParams.get("profileArn")).toBe(PROFILE_ARN);
    expect(url.searchParams.get("origin")).toBe("AI_EDITOR");
    expect(url.searchParams.get("resourceType")).toBe("AGENTIC_REQUEST");
    expect(calls[0]!.headers.Authorization).toBe("Bearer test-access");
    expect(snapshot).toEqual({
      usedCredits: 320.5,
      totalCredits: 1000,
      remainingCredits: 679.5,
      resetTimestampMs: Date.parse("2026-11-01T00:00:00.000Z"),
      subscriptionTitle: "Kiro Pro",
    });
  });

  test("prefers precision fields, tolerates string counts, and reads a Unix reset", async () => {
    const { fetch } = fakeFetch(() =>
      json(200, {
        usageBreakdownList: [
          {
            resourceType: "CREDIT",
            currentUsage: 300,
            usageLimit: 900,
            currentUsageWithPrecision: "327.46",
            usageLimitWithPrecision: "1000",
            nextDateReset: 1_790_000_000,
          },
        ],
      }),
    );
    const snapshot = await fetchKiroUsage(fetch, "test-access", "eu-central-1", PROFILE_ARN);
    expect(snapshot.usedCredits).toBe(327.46);
    expect(snapshot.totalCredits).toBe(1000);
    expect(snapshot.remainingCredits).toBe(672.54);
    expect(snapshot.resetTimestampMs).toBe(1_790_000_000_000);
  });

  test("fails loudly rather than reporting a zero balance when the breakdown is missing", async () => {
    const { fetch } = fakeFetch(() => json(200, { usageBreakdownList: [{ resourceType: "AGENTIC_REQUEST" }] }));
    expect(fetchKiroUsage(fetch, "test-access", "eu-central-1", PROFILE_ARN)).rejects.toThrow(/no credit breakdown/);
  });

  test("discovers the profile when the credential envelope has none", async () => {
    const { fetch, calls } = fakeFetch(call => {
      if (call.url.endsWith("/List-Available-Profiles")) return json(200, { profiles: [{ arn: PROFILE_ARN }] });
      return json(200, creditResponse);
    });
    const snapshot = await fetchKiroUsage(fetch, "test-access", "eu-central-1", undefined);
    expect(calls.map(call => new URL(call.url).pathname)).toEqual(["/List-Available-Profiles", "/GetUsageLimits"]);
    expect(snapshot.totalCredits).toBe(1000);
  });
});

describe("Kiro usage provider wiring", () => {
  test("reports a credits limit for the signed-in account", async () => {
    const { fetch } = fakeFetch(() => json(200, creditResponse));
    const report = await kiroUsageProvider.fetchUsage(usageParams(), usageContext(fetch));
    expect(report?.provider).toBe("kiro");
    expect(report?.limits).toHaveLength(1);
    const [limit] = report!.limits;
    expect(limit).toMatchObject({
      id: "credits",
      label: "Credits",
      scope: { provider: "kiro", tier: "Kiro Pro" },
      window: { id: "monthly", label: "Monthly", resetsAt: Date.parse("2026-11-01T00:00:00.000Z") },
      amount: { used: 320.5, limit: 1000, remaining: 679.5, unit: "credits" },
      status: "ok",
    });
    expect(limit!.amount.usedFraction).toBeCloseTo(0.3205);
  });

  test("marks an exhausted plan and omits the countdown when Kiro sends no reset", async () => {
    const { fetch } = fakeFetch(() =>
      json(200, { usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: 1000, usageLimit: 1000 }] }),
    );
    const report = await kiroUsageProvider.fetchUsage(usageParams(), usageContext(fetch));
    expect(report?.limits[0]?.status).toBe("exhausted");
    expect(report?.limits[0]?.window?.resetsAt).toBeUndefined();
    expect(report?.limits[0]?.amount.usedFraction).toBe(1);
  });

  test("ignores credentials it cannot serve", async () => {
    expect(kiroUsageProvider.supports!(usageParams({ provider: "openai-codex" }))).toBe(false);
    expect(kiroUsageProvider.supports!(usageParams({ type: "api_key" }))).toBe(false);
    expect(await kiroUsageProvider.fetchUsage(usageParams({ provider: "openai-codex" }), usageContext(fetch))).toBeNull();
  });

  test("reports no data for an unparseable access envelope instead of failing the whole report", async () => {
    const { fetch, calls } = fakeFetch(() => json(200, creditResponse));
    const report = await kiroUsageProvider.fetchUsage(usageParams({ accessToken: '{"token":' }), usageContext(fetch));
    expect(report).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
