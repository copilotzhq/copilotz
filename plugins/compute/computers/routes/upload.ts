/**
 * `PUT /computers/upload?desk=<desk>&path=<path>[&replace=1]`: a file a
 * person puts on a space's computer, its body the file's bytes, streamed on
 * to the computer as they come (`computer.files.put`): no bound but the
 * computer's (2 GiB) and its disk's, and nothing held whole here. Past what
 * one request may carry on its way (a proxy's limit: Cloud Run's 32 MiB,
 * a CDN's 100 MB), it comes in parts, in order, each its own request
 * (`&upload=<id>&offset=<where it starts>&total=<the file's size>`): one
 * before the last answers `{ received }`, and the last puts the file in
 * place. The person
 * the request is may (`computer.upload`, which wakes a computer that
 * sleeps); a computer just woken, or between connections, is waited for a
 * while. Then it's asked what it serves (`computer.info`, which every
 * program answers): one from before uploads is told so at once, rather than
 * left to wait for work it never takes. Same-site only: the runtime refuses
 * a write from elsewhere before it gets here.
 *
 * It answers JSON: `{ path, size }` (or a part's `{ received }`), or
 * `{ error: { message, code } }`, its
 * message for people, with its status: 400 `invalid`/`invalid_path`, 401
 * `unauthorized`, 403 `forbidden`/`denied`, 404 `not_found`, 405, 409
 * `exists` (a file there: `replace=1` replaces it; a folder never is), 411
 * `length_required`, 413 `too_large`, 501 `outdated` (the computer's
 * program takes no uploads yet: it updates), 503 `offline`/`unavailable`,
 * 507 `full`.
 */
import { people, type Route } from "../../../../runtime/mod.ts";
import { headed } from "../shared/streams.ts";
import { type FilesPutHead, type Info, MOST_PUT, type Scope, WORK } from "../shared/workloads.ts";

/** Where people put files on computers. */
export const UPLOAD = "/computers/upload";

/** How long a computer woken for an upload has to connect, and one between connections. */
const WAKE_MS = 90_000;
const BACK_MS = 15_000;

const STATUS: Record<string, number> = {
  invalid: 400,
  invalid_path: 400,
  unauthorized: 401,
  forbidden: 403,
  denied: 403,
  not_found: 404,
  exists: 409,
  length_required: 411,
  too_large: 413,
  outdated: 501,
  offline: 503,
  unavailable: 503,
  full: 507,
};

/** Codes whose words are for people as they are; any other is said plainly instead. */
const SAID = new Set([...Object.keys(STATUS), "failed"]);

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

/** A refusal, with its status and words. */
const refuse = (code: string, message: string) =>
  json(STATUS[code] ?? 500, { error: { message, code } });

const codeOf = (error: unknown) => {
  const code = (error as { code?: unknown })?.code;
  return typeof code === "string" ? code : "failed";
};

/** What went wrong, as the person is told it: its own words where they're for people. */
function refusal(error: unknown) {
  const code = codeOf(error);
  if (SAID.has(code) && error instanceof Error) return refuse(code, error.message);
  console.error("computers: an upload failed:", error);
  return refuse("failed", "The upload failed: try again.");
}

const OUTDATED = "This computer's program is too old to take files this way: it updates itself " +
  "when the app does, or its owner updates it.";

export const uploadRoute: Route = async (request, { runtime, actor }) => {
  if (request.method !== "PUT") {
    return json(405, { error: { message: "Put a file with PUT.", code: "invalid" } }, {
      allow: "PUT",
    });
  }
  if (!people(actor)) return refuse("unauthorized", "Sign in to put files on a computer.");
  const url = new URL(request.url);
  const desk = url.searchParams.get("desk");
  const path = url.searchParams.get("path");
  if (!desk || !path) return refuse("invalid", "Say which computer (desk) and where (path).");
  const length = request.headers.get("content-length");
  const size = length === null || length === "" ? NaN : Number(length);
  if (!Number.isSafeInteger(size) || size < 0) {
    return refuse("length_required", "Say the file's size (Content-Length).");
  }
  // In parts: which upload, where this one starts, and the whole file's size.
  const id = url.searchParams.get("upload");
  const numbers = ["offset", "total"].map((name) => Number(url.searchParams.get(name) ?? NaN));
  const [offset, total] = numbers;
  if (id !== null && !numbers.every((n) => Number.isSafeInteger(n) && n >= 0)) {
    return refuse("invalid", "Say where the part starts (offset) and the file's size (total).");
  }
  if ((id === null ? size : total) > MOST_PUT) {
    return refuse("too_large", "A file put on a computer may be 2 GiB at most.");
  }

  let where: { computer: string; scope: Scope; woke?: boolean };
  try {
    where = await runtime.call("computer.upload", { desk, path }, { actor });
  } catch (error) {
    return refusal(error);
  }
  const head: FilesPutHead = {
    scope: where.scope,
    path,
    size,
    ...(url.searchParams.get("replace") === "1" ? { replace: true } : {}),
    ...(id !== null ? { upload: { id, offset, total } } : {}),
  };
  const signal = request.signal;
  /** Work for the computer, answered as one JSON value. */
  const ask = async (workload: string, input: ReadableStream<Uint8Array>) => {
    const job = await runtime.workers.dispatch("computer", where.computer, workload, input, {
      signal,
    });
    const [text] = await Promise.all([new Response(job.output).text(), job.done]);
    return JSON.parse(text) as unknown;
  };
  /**
   * Work for the computer once it's there: a computer woken, or between
   * connections, comes in a moment. One found offline is refused before its
   * input is read, so the next try sends it whole.
   */
  const there = async (workload: string, input: () => ReadableStream<Uint8Array>) => {
    for (const until = Date.now() + (where.woke ? WAKE_MS : BACK_MS);;) {
      try {
        return await ask(workload, input());
      } catch (error) {
        if (codeOf(error) !== "offline" || Date.now() > until || signal.aborted) throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  };
  const gone = (error: unknown) =>
    codeOf(error) !== "offline"
      ? refusal(error)
      : where.woke
      ? refuse("offline", "The computer didn't wake in time: try again.")
      : refuse("offline", "The computer is offline: it takes files once it's on again.");
  let said: unknown;
  try {
    // What it serves, asked at a file's first part: its program is the same for the rest.
    if (id === null || offset === 0) {
      const info = await there(WORK.info, () => headed({}, null)) as Partial<Info>;
      if (!info.serves?.includes(WORK.filesPut)) return refuse("outdated", OUTDATED);
    }
    said = await there(WORK.filesPut, () => headed(head, request.body));
  } catch (error) {
    return gone(error);
  }
  const failed = (said as { error?: { message?: unknown; code?: unknown } } | null)?.error;
  if (failed && typeof failed === "object") {
    return refusal(
      Object.assign(new Error(String(failed.message ?? "The upload failed")), {
        code: typeof failed.code === "string" ? failed.code : "failed",
      }),
    );
  }
  return json(200, said);
};
