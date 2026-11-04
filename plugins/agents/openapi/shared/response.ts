/**
 * A response, read: no more than a cap (checked as it streams in), JSON
 * parsed, text as text, anything else (an image) as a data URL. A failed one
 * becomes an error that says `HTTP <status>` and what the API said, bounded,
 * and carries the status.
 */
import { failure } from "../../../../runtime/mod.ts";
import { textual } from "../../chat/contract.ts";

/** How much of what an API said an error repeats. */
const SAID = 500;

/**
 * The first `limit` bytes of a body, and whether there was more. A body that
 * says it's longer isn't read, unless only its start is wanted (`start`).
 */
export async function readUpTo(
  response: Response,
  limit: number,
  start = false,
): Promise<{ bytes: Uint8Array; over: boolean }> {
  const declared = Number(response.headers.get("content-length") ?? NaN);
  if ((declared > limit && !start) || !response.body) {
    await response.body?.cancel().catch(() => {});
    return { bytes: new Uint8Array(), over: declared > limit };
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = limit - size;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return { bytes: concat(chunks), over: true };
    }
  }
  return { bytes: concat(chunks), over: false };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/** A response's media type, lowercased, without its parameters. */
export const typeOf = (response: Response): string =>
  (response.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();

export const isJson = (type: string): boolean => /^application\/(.+\+)?json$/.test(type);

/** Bytes as text, in the charset the response names (UTF-8 when it names none it knows). */
export function decode(bytes: Uint8Array, response: Response): string {
  const charset = /charset=([^;]+)/i.exec(response.headers.get("content-type") ?? "")?.[1];
  try {
    return new TextDecoder(charset?.trim().replace(/"/g, "") || "utf-8").decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

/** Whether a body is text (JSON, XML…) rather than bytes; none said: text. */
export const isText = (type: string): boolean =>
  !type || textual(type) || /x-www-form-urlencoded|html|problem/.test(type);

/** A body as a call's result: JSON parsed (text if it isn't), text, or a data URL. */
export function resultOf(bytes: Uint8Array, response: Response): unknown {
  const type = typeOf(response);
  if (!bytes.byteLength) return null;
  if (!isText(type)) return `data:${type};base64,${base64(bytes)}`;
  const text = decode(bytes, response);
  if (isJson(type) || (!type && /^\s*[[{]/.test(text))) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

export function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** At most `max` characters, on one line. */
export const bounded = (text: string, max = SAID): string => {
  // deno-lint-ignore no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

/** What an error body says: its message where APIs usually put one, else the body itself. */
export function said(body: unknown): string {
  if (typeof body === "string") {
    // An HTML error page: its words.
    const words = /<[a-z!/]/i.test(body) ? body.replace(/<[^>]*>/g, " ") : body;
    return bounded(words);
  }
  if (!body || typeof body !== "object") return body === null ? "" : bounded(String(body));
  const b = body as Record<string, unknown>;
  const error = b.error && typeof b.error === "object" ? b.error as Record<string, unknown> : {};
  // Lists of problems (FastAPI's `detail`, `errors`): each with where it is.
  const listed = [b.detail, b.errors, error.errors].find(Array.isArray) as unknown[] | undefined;
  const list = listed?.map((item) => {
    if (typeof item === "string") return item;
    const i = (item ?? {}) as Record<string, unknown>;
    const at = [i.loc, i.path, i.field, i.pointer].find((v) => v !== undefined);
    const message = i.message ?? i.msg ?? i.detail ?? i.title;
    const where = Array.isArray(at) ? at.join(".") : at;
    return typeof message === "string" ? (where ? `${where}: ${message}` : message) : "";
  }).filter(Boolean).join("; ");
  const message = [
    error.message,
    b.error_description,
    b.message,
    typeof b.error === "string" ? b.error : undefined,
    typeof b.detail === "string" ? b.detail : undefined,
    b.title,
    b.msg,
  ].find((v): v is string => typeof v === "string" && v.trim() !== "");
  const code = [error.code, b.code].find((v): v is string => typeof v === "string");
  const words = [code && message ? `${code}:` : "", message, list].filter(Boolean).join(" ");
  return bounded(words || JSON.stringify(body));
}

/** A failed response as an error: `HTTP 404: Trip not found`, with `status` and the body. */
export function httpError(response: Response, body: unknown): Error {
  const words = said(body);
  const message = `HTTP ${response.status}${
    words ? `: ${words}` : response.statusText ? ` ${response.statusText}` : ""
  }`;
  return Object.assign(failure("http", message), { status: response.status, body });
}
