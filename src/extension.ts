import { setTimeout as sleep } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { createAssistantMessageEventStream, toolWireSchema } from "@oh-my-pi/pi-ai";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { KIRO_PROVIDER_ID, kiroProviderConfig } from "./provider";

/**
 * OMP extension entry. This is the only module that imports OMP runtime
 * values; everything under `src/` receives them through injected deps, so the
 * transport stays testable without a host.
 */
export default function kiroProvider(api: ExtensionAPI): void {
  api.setLabel("Kiro provider");
  api.registerProvider(
    KIRO_PROVIDER_ID,
    kiroProviderConfig({
      createStream: createAssistantMessageEventStream,
      toolSchema: toolWireSchema,
      fetch,
      now: Date.now,
      randomUUID,
      sleep: (ms, signal) => sleep(ms, undefined, signal ? { signal } : {}),
    }),
  );
}
