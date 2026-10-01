import { describe, expect, test } from "bun:test";
import { kiroUsageProvider } from "../src/usage";
import { fakeFetch, json, PROFILE_ARN } from "./fakes";

const ACCESS_KEY = JSON.stringify({ token: "test-access", region: "us-east-1", profileArn: PROFILE_ARN });
const RESET_SECONDS = 1_793_491_200; // 2026-11-01T00:00:00Z

function fetchUsage(body: unknown) {
  const { fetch, calls } = fakeFetch(() => json(200, body));
  const report = kiroUsageProvider(() => 42).fetchUsage(
    { provider: "kiro", credential: { type: "oauth", accessToken: ACCESS_KEY } },
    { fetch: fetch as never },
  );
  return { report, calls };
}

describe("Kiro usage", () => {
  test("reports monthly credits and bonus credits from the profile's region", async () => {
    const { report, calls } = fetchUsage({
      subscriptionInfo: { subscriptionTitle: "KIRO PRO MAX" },
      nextDateReset: RESET_SECONDS,
      usageBreakdownList: [
        {
          resourceType: "CREDIT",
          displayNamePlural: "Credits",
          currentUsage: 1250,
          currentUsageWithPrecision: 1250.5,
          usageLimit: 5000,
          usageLimitWithPrecision: 5000,
          currentOverages: 0,
          nextDateReset: null,
          freeTrialInfo: { freeTrialStatus: "ACTIVE", currentUsage: 10, usageLimit: 500, freeTrialExpiry: "2026-10-15T00:00:00Z" },
        },
      ],
    });
    const result = await report;
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe("https://management.eu-central-1.kiro.dev/Get-Usage-Limits");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      origin: "KIRO_CLI",
      resourceType: "CREDIT",
      isEmailRequired: "false",
      profileArn: PROFILE_ARN,
    });
    expect(calls[0]?.headers.Authorization).toBe("Bearer test-access");
    expect(result?.notes).toEqual(["Plan: KIRO PRO MAX"]);
    expect(result?.limits).toEqual([
      {
        id: "kiro:credit",
        label: "Credits",
        scope: { provider: "kiro", tier: "KIRO PRO MAX" },
        amount: { unit: "credits", used: 1250.5, limit: 5000, remaining: 3749.5, usedFraction: 1250.5 / 5000 },
        status: "ok",
        // The bucket's null reset falls back to the account-wide one, converted from seconds.
        window: { id: "kiro:credit", label: "Monthly", resetsAt: RESET_SECONDS * 1000 },
      },
      {
        id: "kiro:credit:bonus",
        label: "Bonus credits",
        scope: { provider: "kiro", tier: "KIRO PRO MAX" },
        amount: { unit: "credits", used: 10, limit: 500, remaining: 490, usedFraction: 0.02 },
        status: "ok",
        window: { id: "kiro:credit:bonus", label: "Bonus", resetsAt: Date.parse("2026-10-15T00:00:00Z") },
        notes: ["Status: ACTIVE"],
      },
    ]);
  });

  test("flags nearly spent and exhausted allowances", async () => {
    const statuses = [];
    for (const used of [4499, 4500, 5000, 5200]) {
      const { report } = fetchUsage({ usageBreakdownList: [{ resourceType: "CREDIT", currentUsage: used, usageLimit: 5000 }] });
      statuses.push((await report)?.limits[0]?.status);
    }
    expect(statuses).toEqual(["ok", "warning", "exhausted", "exhausted"]);
  });

  test("returns no report without a credential and surfaces HTTP errors", async () => {
    const provider = kiroUsageProvider(() => 0);
    const { fetch } = fakeFetch(() => json(403, { message: "Invalid token" }));
    expect(await provider.fetchUsage({ provider: "kiro", credential: { type: "oauth" } }, { fetch: fetch as never })).toBeNull();
    await expect(
      provider.fetchUsage({ provider: "kiro", credential: { type: "oauth", accessToken: ACCESS_KEY } }, { fetch: fetch as never }),
    ).rejects.toThrow("Kiro usage failed: HTTP 403 Invalid token");
  });
});
