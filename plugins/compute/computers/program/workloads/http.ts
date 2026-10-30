/**
 * `computer.http`: one HTTP exchange with a port this computer serves (a
 * job's, for its preview), forwarded to its own loopback (`127.0.0.1`) and
 * nowhere else. Its input is the request's head (`HttpRequestHead`, one JSON
 * line) then its body, raw; its output is the response's head
 * (`HttpResponseHead`, one JSON line) then its body as it comes, so a
 * streamed answer streams. A port nothing answers on gives 502; a head it
 * can't take answers its failure instead (`Failed`, one JSON line).
 *
 * Headers go as they came, but for those of one hop (`connection` and what
 * it names, `keep-alive`, `transfer-encoding`…), `host` (the port's own) and
 * `accept-encoding`: fetch asks for the encodings it decodes, and decodes
 * them (each runtime decodes only what it asked for itself), so a response
 * comes decoded, without its `content-encoding` (or its length). Redirects
 * are answered, never followed.
 */
import type { WorkerWorkHandler } from "@oxian/oxian-js";
import type { HttpRequestHead, HttpResponseHead } from "../../shared/workloads.ts";
import { fail } from "./answer.ts";
import type { Spaces } from "./spaces.ts";
import { bounded, failedLine, jsonLine, splitHead } from "./streams.ts";

/** Headers of one hop: never forwarded, either way. */
const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
  "http2-settings",
]);
/** What fetch decodes on its own. */
const DECODED = new Set(["gzip", "x-gzip", "deflate", "br"]);
/** What fetch never sends. */
const UNSENT = new Set(["CONNECT", "TRACE", "TRACK"]);
/** A method, as HTTP has them (a token). */
const METHOD = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** The head as the plugin sent it, checked. */
function checkHead(value: unknown): HttpRequestHead {
  const head = value as Partial<HttpRequestHead> | undefined;
  if (!head || typeof head !== "object") fail("The head must be an object");
  const { port, method, path, headers } = head;
  if (!Number.isInteger(port) || port! < 1 || port! > 65535) fail("port must be from 1 to 65535");
  if (typeof method !== "string" || !METHOD.test(method)) fail("method must be an HTTP method");
  if (UNSENT.has(method.toUpperCase())) fail(`${method} isn't forwarded`);
  if (typeof path !== "string" || !path.startsWith("/") || /[\s\0]/.test(path)) {
    fail('path must start with "/"');
  }
  if (
    !Array.isArray(headers) ||
    !headers.every((h) =>
      Array.isArray(h) && h.length === 2 && typeof h[0] === "string" && typeof h[1] === "string"
    )
  ) fail("headers must be [name, value] pairs");
  return head as HttpRequestHead;
}

/** The headers to send on: of more than one hop, its host the port's own, its encodings fetch's. */
function forwarded(given: [string, string][], port: number): Headers {
  const named = new Set(
    given.filter(([name]) => name.toLowerCase() === "connection")
      .flatMap(([, value]) => value.split(",").map((name) => name.trim().toLowerCase())),
  );
  const headers = new Headers();
  for (const [name, value] of given) {
    const lower = name.toLowerCase();
    if (HOP.has(lower) || named.has(lower) || lower === "host" || lower === "accept-encoding") {
      continue;
    }
    try {
      headers.append(name, value);
    } catch {
      fail(`The header "${name}" isn't valid`);
    }
  }
  headers.set("host", `127.0.0.1:${port}`);
  return headers;
}

/** A response's head: its headers but those of one hop, every `set-cookie` its own. */
function responseHead(response: Response): HttpResponseHead {
  const named = new Set(
    (response.headers.get("connection") ?? "").split(",").map((name) => name.trim().toLowerCase()),
  );
  const encoding = response.headers.get("content-encoding")?.trim().toLowerCase();
  const decoded = !!encoding && DECODED.has(encoding);
  const headers: [string, string][] = [];
  for (const [name, value] of response.headers) {
    if (HOP.has(name) || named.has(name) || name === "set-cookie") continue;
    if (decoded && (name === "content-encoding" || name === "content-length")) continue;
    headers.push([name, value]);
  }
  for (const cookie of response.headers.getSetCookie()) headers.push(["set-cookie", cookie]);
  return { status: response.status, headers };
}

/**
 * The request's body: none for GET and HEAD, nor when nothing follows the
 * head; else what follows, as it comes.
 */
async function bodyOf(method: string, rest: ReadableStream<Uint8Array>) {
  if (/^(GET|HEAD)$/i.test(method)) {
    await rest.cancel().catch(() => {});
    return undefined;
  }
  const reader = rest.getReader();
  const first = await reader.read();
  if (first.done) return undefined;
  let pending: Uint8Array | undefined = first.value;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pending) {
        controller.enqueue(pending);
        pending = undefined;
        return;
      }
      const { value, done } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
}

/** The exchange that answers 502: nothing answered on the port. */
function unanswered(port: number, error: unknown): Uint8Array {
  const why = (error as { cause?: { code?: string } })?.cause?.code ??
    (error instanceof Error ? error.message : String(error));
  const head: HttpResponseHead = {
    status: 502,
    headers: [["content-type", "text/plain; charset=utf-8"]],
  };
  const text = new TextEncoder().encode(`Nothing answered on port ${port} (${why})\n`);
  const line = jsonLine(head);
  const bytes = new Uint8Array(line.length + text.length);
  bytes.set(line);
  bytes.set(text, line.length);
  return bytes;
}

/** `computer.http`, for the spaces of this computer. */
export function createHttp(spaces: Spaces): WorkerWorkHandler {
  return async ({ input, signal }) => {
    let split: Awaited<ReturnType<typeof splitHead>> | undefined;
    let head: HttpRequestHead;
    let headers: Headers;
    try {
      split = await splitHead(input);
      head = checkHead(split.head);
      // Its scope, as other work's: a space's folder, and whose.
      await spaces.folder(head.scope);
      headers = forwarded(head.headers, head.port);
    } catch (error) {
      void (split?.rest ?? input).cancel().catch(() => {});
      return failedLine(error);
    }
    const { rest } = split;
    // Only this machine's loopback: the path is put after its port, never parsed as a URL alone.
    const url = new URL(`http://127.0.0.1:${head.port}${head.path}`);
    if (url.hostname !== "127.0.0.1" || Number(url.port || 80) !== head.port) {
      void rest.cancel().catch(() => {});
      return failedLine(
        Object.assign(new Error("Only this computer's ports"), { code: "invalid" }),
      );
    }
    let response: Response;
    try {
      const body = await bodyOf(head.method, rest);
      response = await fetch(url, {
        method: head.method,
        headers,
        redirect: "manual",
        signal,
        ...(body ? { body, duplex: "half" } : {}),
      } as RequestInit);
    } catch (error) {
      void rest.cancel().catch(() => {});
      if (signal.aborted) throw error;
      return unanswered(head.port, error);
    }
    return bounded(response.body, jsonLine(responseHead(response)));
  };
}
