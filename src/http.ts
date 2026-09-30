import { z } from "zod";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** An HTTP failure from a Kiro or AWS endpoint, with the parsed error body. */
export class KiroHttpError extends Error {
  override name = "KiroHttpError";
  constructor(
    readonly status: number,
    /** Kiro `reason` code, e.g. `CONTENT_LENGTH_EXCEEDS_THRESHOLD`. */
    readonly reason: string | undefined,
    /** OAuth `error` code or AWS `__type` suffix, e.g. `invalid_grant`. */
    readonly errorCode: string | undefined,
    /** The server's own message, without this plugin's label or codes. */
    readonly detail: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

// AWS and Kiro may send absent fields as `null`; nullish keeps the rest of the body usable.
const ErrorBodySchema = z.looseObject({
  message: z.string().nullish(),
  Message: z.string().nullish(),
  reason: z.string().nullish(),
  error: z.string().nullish(),
  error_description: z.string().nullish(),
  __type: z.string().nullish(),
});

/**
 * Turns a non-2xx response into a {@link KiroHttpError}.
 *
 * The OAuth `error` code is part of the message because OMP decides whether a
 * refresh failure is final (it matches `invalid_grant`, `invalid_token`,
 * `revoked`, …) from the error text. A non-JSON body is never quoted: an
 * intermediary that echoes the request could otherwise copy OIDC client
 * secrets or tokens into the message.
 */
export async function httpErrorFrom(response: Response, label: string): Promise<KiroHttpError> {
  const text = await response.text().catch(() => "");
  let body: z.infer<typeof ErrorBodySchema> | undefined;
  try {
    const parsed = ErrorBodySchema.safeParse(JSON.parse(text));
    if (parsed.success) body = parsed.data;
  } catch {
    body = undefined;
  }
  const errorCode = body?.error ?? body?.__type?.split("#").pop() ?? undefined;
  const detail = body?.message ?? body?.Message ?? body?.error_description ?? undefined;
  const reason = body?.reason ?? undefined;
  const parts = [`${label} failed: HTTP ${response.status}`];
  if (errorCode && errorCode !== detail) parts.push(`${errorCode}:`);
  if (detail) parts.push(detail);
  else if (!body && text) parts.push(`(non-JSON ${response.headers.get("content-type") ?? "unknown"} body, ${text.length} bytes)`);
  if (reason) parts.push(`(${reason})`);
  return new KiroHttpError(response.status, reason, errorCode, detail, parts.join(" "));
}

export interface JsonRequest {
  method: "GET" | "POST";
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal | undefined;
  /** Human label used in error messages, e.g. "Kiro model discovery". */
  label: string;
}

/** Issue a JSON request and validate the response body with `schema`. */
export async function requestJson<T>(fetchImpl: FetchLike, request: JsonRequest, schema: z.ZodType<T>): Promise<T> {
  const init: RequestInit = {
    method: request.method,
    headers: { Accept: "application/json", ...(request.body === undefined ? {} : { "Content-Type": "application/json" }), ...request.headers },
  };
  if (request.body !== undefined) init.body = JSON.stringify(request.body);
  if (request.signal) init.signal = request.signal;
  const response = await fetchImpl(request.url, init);
  if (!response.ok) throw await httpErrorFrom(response, request.label);
  const parsed = schema.safeParse(await response.json());
  if (!parsed.success) throw new Error(`${request.label} returned an unexpected response shape`);
  return parsed.data;
}
