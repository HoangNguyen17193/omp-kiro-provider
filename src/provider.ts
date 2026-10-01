import type { Api, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { type KiroAuthDeps, loginKiro, refreshKiro } from "./auth";
import { fetchKiroModels } from "./catalog";
import { KIRO_API_ID, KIRO_DEFAULT_REGION, runtimeBaseUrl } from "./endpoints";
import { type KiroStreamDeps, streamKiro } from "./stream";
import { kiroUsageProvider } from "./usage";

export { KIRO_PROVIDER_ID } from "./endpoints";

export type KiroProviderDeps = KiroStreamDeps & KiroAuthDeps;

/**
 * The `pi.registerProvider("kiro", …)` configuration. Models come only from
 * `fetchDynamicModels`: Kiro's catalog is scoped to the signed-in account and
 * profile, so a static list would advertise models the account cannot use.
 */
export function kiroProviderConfig(deps: KiroProviderDeps) {
  return {
    // Per-request hosts follow the profile ARN's region; this is the default region's runtime host.
    baseUrl: runtimeBaseUrl(KIRO_DEFAULT_REGION),
    api: KIRO_API_ID,
    authHeader: false,
    streamSimple: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
      streamKiro(deps, model, context, options),
    oauth: {
      name: "Kiro (AWS Builder ID / IAM Identity Center)",
      login: (callbacks: OAuthLoginCallbacks) => loginKiro({ ...deps, fetch: callbacks.fetch ?? deps.fetch }, callbacks),
      refreshToken: (credentials: OAuthCredentials, signal?: AbortSignal) => refreshKiro(deps, credentials, signal),
    },
    fetchDynamicModels: (apiKey: string | undefined) => fetchKiroModels(deps.fetch, apiKey),
    usage: kiroUsageProvider(deps.now),
  };
}
