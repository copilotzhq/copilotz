/**
 * The API's answers: JSON, errors as `{ error: { code, message } }` with the
 * status their code says, and bodies read within a limit. Any origin may
 * call it from a browser (a key is a header, never a cookie, so nothing
 * rides along that the caller didn't put there).
 */

/** The largest body taken (files go in as base64): 16 MB. */
export const MAX_BODY = 16 * 1024 * 1024;

/** The status each error code answers with. */
const STATUS: Record<string, number> = {
  invalid: 400,
  duplicate_key: 409,
  unauthorized: 401,
  forbidden: 403,
  not_here: 403,
  needs_share: 403,
  not_found: 404,
  method: 405,
  id_conflict: 409,
  too_large: 413,
  transcription_failed: 422,
  cancelled: 499,
  unavailable: 501,
  offline: 503,
};

/** Who may call from a browser, and with what. */
export const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, idempotency-key, last-event-id",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-max-age": "86400",
};

export const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value ?? null), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS, ...headers },
  });

/** An error as the API says it. */
export const failure = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) => json({ error: { code, message } }, status, headers);

/** An error's code, made by the API or by the runtime and plugins (`Object.assign(error, { code })`). */
export const fault = (code: string, message: string) => Object.assign(new Error(message), { code });

/** What a thrown error answers: its code's status and its message; anything else, a 500 that says nothing. */
export function answerFor(error: unknown): Response {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  // The runtime says an unknown name is invalid; to a caller, it isn't there.
  if (/^Unknown (action|query)/.test(message)) return failure(404, "not_found", message);
  if (typeof code === "string" && STATUS[code]) return failure(STATUS[code], code, message);
  console.error("api:", message);
  return failure(500, "internal", "Something went wrong.");
}

/** A request's body as text, refused past `MAX_BODY`. */
export async function textOf(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) {
    throw fault("too_large", "The body is too large (16 MB at most).");
  }
  if (!request.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_BODY) {
      await reader.cancel().catch(() => {});
      throw fault("too_large", "The body is too large (16 MB at most).");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return new TextDecoder().decode(bytes);
}

/** A request's JSON body; none is `{}`. */
export async function bodyOf(request: Request): Promise<unknown> {
  const text = await textOf(request);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw fault("invalid", "The body isn't JSON.");
  }
}
