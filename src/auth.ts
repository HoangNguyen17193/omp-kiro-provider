import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/oauth/types";
import { z } from "zod";
import { resolveProfile } from "./catalog";
import {
  apiRegionFor,
  BUILDER_ID_START_URL,
  type KiroAccessEnvelope,
  type KiroRefreshEnvelope,
  KIRO_DEFAULT_REGION,
  oidcBaseUrl,
  parseAccessKey,
  parseRefreshEnvelope,
  RegionSchema,
} from "./endpoints";
import { type FetchLike, KiroHttpError, requestJson } from "./http";
import { fetchKiroIdentity, type KiroIdentity } from "./usage";

/**
 * AWS SSO-OIDC device-code login (RFC 8628) for AWS Builder ID and IAM
 * Identity Center, as Kiro CLI performs it. Tokens are returned to OMP, which
 * stores them in its `/login` credential store; this plugin never persists them.
 */

const SCOPES = [
  "codewhisperer:completions",
  "codewhisperer:analysis",
  "codewhisperer:conversations",
  "codewhisperer:transformations",
  "codewhisperer:taskassist",
];
const CLIENT_NAME = "omp-kiro-provider";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
/** Refresh five minutes before the reported expiry so no request races it. */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 15_000;
/** OMP gives a whole refresh 10 s; the identity lookup after the token request must fit well inside it. */
const REFRESH_IDENTITY_TIMEOUT_MS = 3_000;
/** Regions probed when an Identity Center user does not name one. */
const IDC_REGIONS = [
  "us-east-1", "eu-west-1", "eu-central-1", "us-east-2", "eu-west-2", "eu-west-3",
  "eu-north-1", "ap-southeast-1", "ap-northeast-1", "us-west-2", "sa-east-1", "ap-northeast-2",
];

/** OIDC refresh failures that mean the grant is dead and a new `/login` is required. */
const DEAD_GRANT_CODES: Record<string, true> = {
  invalid_grant: true,
  expired_token: true,
  invalid_client: true,
  unauthorized_client: true,
  invalidgrantexception: true,
  expiredtokenexception: true,
  invalidclientexception: true,
  unauthorizedclientexception: true,
};

const RegisterSchema = z.looseObject({ clientId: z.string().min(1), clientSecret: z.string().min(1) });
const DeviceSchema = z.looseObject({
  deviceCode: z.string().min(1),
  userCode: z.string().min(1),
  verificationUri: z.string().min(1),
  verificationUriComplete: z.string().optional(),
  interval: z.number().positive().optional(),
  expiresIn: z.number().positive().optional(),
});
const TokenSchema = z.looseObject({
  accessToken: z.string().min(1),
  refreshToken: z.string().optional(),
  expiresIn: z.number().positive().optional(),
});

export interface KiroAuthDeps {
  fetch: FetchLike;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

function timeoutSignal(signal: AbortSignal | undefined, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface RegisteredDevice {
  region: string;
  client: z.infer<typeof RegisterSchema>;
  device: z.infer<typeof DeviceSchema>;
}

async function registerAndAuthorize(
  deps: KiroAuthDeps,
  region: string,
  startUrl: string,
  signal: AbortSignal | undefined,
): Promise<RegisteredDevice> {
  const base = oidcBaseUrl(region);
  const client = await requestJson(
    deps.fetch,
    {
      method: "POST",
      url: `${base}/client/register`,
      body: { clientName: CLIENT_NAME, clientType: "public", scopes: SCOPES, grantTypes: [DEVICE_GRANT, "refresh_token"] },
      signal: timeoutSignal(signal),
      label: "Kiro client registration",
    },
    RegisterSchema,
  );
  const device = await requestJson(
    deps.fetch,
    {
      method: "POST",
      url: `${base}/device_authorization`,
      body: { clientId: client.clientId, clientSecret: client.clientSecret, startUrl },
      signal: timeoutSignal(signal),
      label: "Kiro device authorization",
    },
    DeviceSchema,
  );
  return { region, client, device };
}

async function pollForToken(
  deps: KiroAuthDeps,
  registered: RegisteredDevice,
  signal: AbortSignal | undefined,
): Promise<z.infer<typeof TokenSchema>> {
  const { device, client } = registered;
  let intervalMs = (device.interval ?? 5) * 1000;
  const deadline = deps.now() + (device.expiresIn ?? 600) * 1000;
  while (deps.now() < deadline) {
    await deps.sleep(intervalMs, signal);
    try {
      return await requestJson(
        deps.fetch,
        {
          method: "POST",
          url: `${oidcBaseUrl(registered.region)}/token`,
          body: { clientId: client.clientId, clientSecret: client.clientSecret, deviceCode: device.deviceCode, grantType: DEVICE_GRANT },
          signal: timeoutSignal(signal),
          label: "Kiro token request",
        },
        TokenSchema,
      );
    } catch (error) {
      const code = error instanceof KiroHttpError ? error.errorCode?.toLowerCase() : undefined;
      if (code === "authorization_pending" || code === "authorizationpendingexception") continue;
      if (code === "slow_down" || code === "slowdownexception") {
        intervalMs += 5000;
        continue;
      }
      throw error;
    }
  }
  throw new Error("Kiro login timed out before the device code was approved");
}

function credentialsFrom(
  deps: KiroAuthDeps,
  token: z.infer<typeof TokenSchema>,
  refresh: KiroRefreshEnvelope,
  access: Omit<KiroAccessEnvelope, "token">,
  identity: KiroIdentity,
): OAuthCredentials {
  const envelope: KiroAccessEnvelope = { token: token.accessToken, ...access };
  return {
    access: JSON.stringify(envelope),
    refresh: JSON.stringify(refresh),
    expires: deps.now() + (token.expiresIn ?? 3600) * 1000 - EXPIRY_MARGIN_MS,
    ...identity,
  };
}

/**
 * The signed-in user, recorded on the credential so OMP can tell accounts
 * apart and replace a re-signed-in user's row. Best effort: a login or refresh
 * never fails because Kiro withheld the identity.
 */
async function lookUpIdentity(
  deps: KiroAuthDeps,
  access: KiroAccessEnvelope,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<KiroIdentity> {
  try {
    return await fetchKiroIdentity(deps.fetch, access, timeoutSignal(signal, timeoutMs));
  } catch (error) {
    if (signal?.aborted) throw error;
    return {};
  }
}

export async function loginKiro(deps: KiroAuthDeps, callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
  const signal = callbacks.signal;
  const startInput = (
    await callbacks.onPrompt({
      message: "IAM Identity Center start URL (leave blank for AWS Builder ID)",
      placeholder: "https://<org>.awsapps.com/start",
      allowEmpty: true,
    })
  ).trim();
  const builderId = startInput === "";
  const startUrl = builderId ? BUILDER_ID_START_URL : startInput;
  if (!builderId && !URL.canParse(startUrl)) throw new Error(`Not a valid start URL: ${startUrl}`);

  let regions = [KIRO_DEFAULT_REGION];
  if (!builderId) {
    const regionInput = (
      await callbacks.onPrompt({ message: "Identity Center region (leave blank to detect)", placeholder: "us-east-1", allowEmpty: true })
    ).trim();
    if (regionInput && !RegionSchema.safeParse(regionInput).success) throw new Error(`Not an AWS region: ${regionInput}`);
    regions = regionInput ? [regionInput] : IDC_REGIONS;
  }

  let registered: RegisteredDevice | undefined;
  let lastError: unknown;
  for (const region of regions) {
    callbacks.onProgress?.(`Contacting AWS SSO in ${region}…`);
    try {
      registered = await registerAndAuthorize(deps, region, startUrl, signal);
      break;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  if (!registered) throw new Error("Could not start Kiro device login in any region", { cause: lastError });

  const { device } = registered;
  callbacks.onAuth({
    url: device.verificationUriComplete ?? device.verificationUri,
    instructions: `Approve the request in your browser. Code: ${device.userCode}`,
  });
  callbacks.onProgress?.("Waiting for approval…");
  const token = await pollForToken(deps, registered, signal);
  if (!token.refreshToken) throw new Error("Kiro login returned no refresh token");

  const apiRegion = apiRegionFor(registered.region);
  const profile = await resolveProfile(deps.fetch, token.accessToken, apiRegion, { builderId, signal });
  const access = { region: apiRegion, profileArn: profile.arn };
  const identity = await lookUpIdentity(deps, { token: token.accessToken, ...access }, signal, REQUEST_TIMEOUT_MS);
  return credentialsFrom(
    deps,
    token,
    {
      refreshToken: token.refreshToken,
      clientId: registered.client.clientId,
      clientSecret: registered.client.clientSecret,
      oidcRegion: registered.region,
      startUrl,
    },
    access,
    identity,
  );
}

export async function refreshKiro(
  deps: KiroAuthDeps,
  credentials: OAuthCredentials,
  signal?: AbortSignal,
): Promise<OAuthCredentials> {
  const refresh = parseRefreshEnvelope(credentials.refresh);
  const previous = parseAccessKey(credentials.access);
  let token: z.infer<typeof TokenSchema>;
  try {
    token = await requestJson(
      deps.fetch,
      {
        method: "POST",
        url: `${oidcBaseUrl(refresh.oidcRegion)}/token`,
        body: {
          clientId: refresh.clientId,
          clientSecret: refresh.clientSecret,
          refreshToken: refresh.refreshToken,
          grantType: "refresh_token",
        },
        signal: timeoutSignal(signal),
        label: "Kiro token refresh",
      },
      TokenSchema,
    );
  } catch (error) {
    // OMP retires a credential only when the refresh error text names a dead grant.
    const code = error instanceof KiroHttpError ? error.errorCode?.toLowerCase() : undefined;
    if (error instanceof KiroHttpError && code && Object.hasOwn(DEAD_GRANT_CODES, code)) {
      throw new Error(`Kiro token refresh failed: invalid_grant (${error.message}); run /login and choose Kiro again`, { cause: error });
    }
    throw error;
  }
  const { token: _stale, ...access } = previous;
  // OMP keeps a stored identity across refreshes; look it up only for credentials signed in without one.
  const identity = credentials.accountId
    ? {}
    : await lookUpIdentity(deps, { token: token.accessToken, ...access }, signal, REFRESH_IDENTITY_TIMEOUT_MS);
  return credentialsFrom(deps, token, { ...refresh, refreshToken: token.refreshToken ?? refresh.refreshToken }, access, identity);
}
