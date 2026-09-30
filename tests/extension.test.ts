import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent";
import { parseMarketplaceCatalog } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace/fetcher";

const root = resolve(import.meta.dir, "..");

describe("OMP packaging", () => {
  test("the built entry OMP loads registers the kiro provider", async () => {
    const manifest = await Bun.file(resolve(root, "package.json")).json();
    const [entry] = manifest.omp.extensions as string[];
    const result = await loadExtensions([resolve(root, entry!)], root);
    expect(result.errors).toEqual([]);
    const kiro = result.runtime.pendingProviderRegistrations.find(registration => registration.name === "kiro");
    expect(kiro?.config.api).toBe("kiro-generate-assistant-response");
    // Kiro's catalog is account-scoped: models come only from discovery.
    expect(kiro?.config.models).toBeUndefined();
    expect(typeof kiro?.config.fetchDynamicModels).toBe("function");
    expect(typeof kiro?.config.oauth?.login).toBe("function");
    expect(typeof kiro?.config.oauth?.refreshToken).toBe("function");
  });

  test("the marketplace catalog parses and points at the repository root", async () => {
    const path = resolve(root, ".omp-plugin/marketplace.json");
    const catalog = parseMarketplaceCatalog(await Bun.file(path).text(), path);
    expect(catalog.plugins.map(plugin => [plugin.name, plugin.source])).toEqual([["omp-kiro-provider", "./"]]);
  });
});
