/**
 * The client over HTTP: a link (see client.ts, `ClientLink`) that carries
 * its reads, writes, calls and events as requests to the runtime's REST API
 * (`/api/`, see api.ts), and its watches as server-sent streams. A key goes
 * in `Authorization`; without one, the request is the browser's (its
 * cookie, from the app's own page).
 *
 * - **Reads:** `find`, `findOne` and `count` on a collection
 *   (`GET /api/collections/<name>?filter=…`), and named queries
 *   (`POST /api/queries/<name>`).
 * - **Writes:** one document at a time, by filter (`POST`, `PATCH`, `PUT`
 *   and `DELETE` on `/api/collections/<name>`), answered as MongoDB does.
 * - **Calls** carry an `Idempotency-Key` (the caller's own id, else a new
 *   one): one that never got an answer (the network failed) is sent again,
 *   with the same key, for up to 30 s, and is done once.
 * - **Watches** open `Accept: text/event-stream`, and open again (longer
 *   apart) when the stream drops, until stopped; refused (a 4xx but 429),
 *   it says why, and stops.
 */
import type { Answer, Remote } from "./browsers.ts";
import type { ClientLink } from "./client.ts";
import type { WriteOp } from "./ops.ts";

/** How long a call is sent again while the network fails, in all (ms). */
const RETRY_MS = 30_000;

const enc = encodeURIComponent;

/** A failure the API answered, as an error with its code. */
const failure = (message: string, code?: string, status?: number) =>
  Object.assign(new Error(message), {
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
  });

/** A network failure (nothing answered), not a refusal: worth sending again. */
const unanswered = (error: unknown) =>
  error instanceof TypeError || (error as { name?: string })?.name === "TypeError";

/** What an answer that isn't ok says went wrong. */
async function refusal(response: Response): Promise<Error> {
  const said = await response.json().catch(() => undefined) as
    | { error?: { code?: string; message?: string } | string }
    | undefined;
  const error = typeof said?.error === "string" ? { message: said.error } : said?.error;
  return failure(
    error?.message ?? `${response.status} ${response.statusText}`,
    error?.code,
    response.status,
  );
}

/** Each server-sent event in a stream, as it comes: its name (`message` unless said) and data. */
async function* events(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  let buffer = "";
  const decoder = new TextDecoder();
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
      for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        let event = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const at = line.indexOf(":");
          const [field, text] = at < 0
            ? [line, ""]
            : [line.slice(0, at), line.slice(at + 1).replace(/^ /, "")];
          if (field === "event") event = text;
          else if (field === "data") data.push(text);
        }
        if (data.length) yield { event, data: data.join("\n") };
      }
    }
  } finally {
    // Done with it however it ended: what's left isn't read.
    await reader.cancel().catch(() => {});
  }
}

/**
 * A link to the REST API at `base` (`https://app.example`, or under an
 * org's `/o/acme`), with `key` (none: the browser's cookie), over `fetch`
 * (the platform's unless said: a runtime's own, in tests).
 */
export function restLink(
  base: string,
  options: { key?: string; fetch?: typeof fetch } = {},
): Required<Pick<ClientLink, "read" | "call" | "emit" | "write" | "watch">> {
  const root = base.replace(/\/+$/, "");
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  const headers = (more: Record<string, string> = {}): Record<string, string> => ({
    accept: "application/json",
    ...(options.key ? { authorization: `Bearer ${options.key}` } : {}),
    ...more,
  });

  /** A request's JSON answer; one that isn't ok, thrown as what it says. */
  const ask = async (
    method: string,
    path: string,
    body?: unknown,
    more: Record<string, string> = {},
  ): Promise<unknown> => {
    const response = await send(`${root}${path}`, {
      method,
      headers: headers(body === undefined ? more : { "content-type": "application/json", ...more }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: "same-origin",
    });
    if (!response.ok) throw await refusal(response);
    if (response.status === 204) {
      await response.body?.cancel();
      return undefined;
    }
    return await response.json();
  };

  /** A collection's path, with its search parameters (JSON where they're objects). */
  const at = (collection: string, params: Record<string, unknown> = {}) => {
    const search = new URLSearchParams();
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined) continue;
      search.set(name, typeof value === "object" ? JSON.stringify(value) : String(value));
    }
    const query = search.toString();
    return `/api/collections/${enc(collection)}${query ? `?${query}` : ""}`;
  };

  /** Where a read is asked, and how: a collection's GET, or a query's POST. */
  const route = (read: Remote): { method: string; path: string; body?: unknown; one?: true } => {
    if ("query" in read) {
      return {
        method: "POST",
        path: `/api/queries/${enc(`${read.collection}.${read.query}`)}`,
        body: read.params ?? {},
      };
    }
    const { op } = read;
    switch (op.op) {
      case "find":
        return { method: "GET", path: at(op.collection, { filter: op.filter, ...op.options }) };
      case "findOne":
        return {
          method: "GET",
          path: at(op.collection, { filter: op.filter, ...op.options, limit: 1 }),
          one: true,
        };
      case "count":
        return { method: "GET", path: at(op.collection, { filter: op.filter, count: true }) };
      default:
        throw failure(`The HTTP API doesn't ${op.op}: connect over the socket`, "unavailable");
    }
  };

  /** A read's value: `findOne`'s is the first found, or null. */
  const value = async (read: Remote): Promise<unknown> => {
    const { method, path, body, one } = route(read);
    const found = await ask(method, path, body);
    return one ? (found as unknown[])[0] ?? null : found;
  };

  const answerOf = (error: unknown): Answer => {
    const { message, code } = error as { message?: string; code?: string };
    return { error: { message: message ?? String(error), ...(code ? { code } : {}) } };
  };

  return {
    read: (reads) =>
      Promise.all(reads.map(async ({ key, read }) => {
        try {
          return { key, value: (await value(read)) ?? null };
        } catch (error) {
          return { key, ...answerOf(error) };
        }
      })),

    async call(action, input, options = {}) {
      // Its own id, the same each time it's sent: sent again, it's done once.
      const id = options.id ?? crypto.randomUUID();
      for (let waited = 0, delay = 100;; delay = Math.min(delay * 2, 2_000)) {
        try {
          return await ask("POST", `/api/actions/${enc(action)}`, input ?? {}, {
            "idempotency-key": id,
          });
        } catch (error) {
          if (!unanswered(error) || waited >= RETRY_MS) throw error;
          await new Promise((resolve) => setTimeout(resolve, delay));
          waited += delay;
        }
      }
    },

    emit: async (type, data) => {
      await ask("POST", `/api/events/${enc(type)}`, data ?? {});
    },

    async write(op: WriteOp) {
      switch (op.op) {
        case "insert":
          if (op.docs.length !== 1) {
            throw failure("Over HTTP, insert one document at a time", "invalid");
          }
          return await ask("POST", at(op.collection), op.docs[0]);
        case "update":
          if (op.options.many) throw failure("Over HTTP, update one at a time", "invalid");
          return await ask(
            "PATCH",
            at(op.collection, { filter: op.filter, upsert: op.options.upsert || undefined }),
            op.update,
          );
        case "replace":
          return await ask(
            "PUT",
            at(op.collection, { filter: op.filter, upsert: op.options.upsert || undefined }),
            op.doc,
          );
        case "delete":
          if (op.options.many) throw failure("Over HTTP, delete one at a time", "invalid");
          return await ask("DELETE", at(op.collection, { filter: op.filter }));
        default:
          throw failure(`Nobody outside makes "${op.op}" directly`, "forbidden");
      }
    },

    watch(read, listener) {
      const stop = new AbortController();
      // A watch is a GET: a query's params go in its search.
      let given: { path: string; one?: true };
      try {
        given = "query" in read
          ? {
            path: `/api/queries/${enc(`${read.collection}.${read.query}`)}?${new URLSearchParams({
              params: JSON.stringify(read.params ?? {}),
            })}`,
          }
          : route(read);
      } catch (error) {
        queueMicrotask(() => listener(answerOf(error)));
        return () => {};
      }
      const follow = async (tries = 0): Promise<void> => {
        if (stop.signal.aborted) return;
        let again = true;
        try {
          const response = await send(`${root}${given.path}`, {
            headers: headers({ accept: "text/event-stream" }),
            signal: stop.signal,
            credentials: "same-origin",
          });
          if (!response.ok) {
            const error = await refusal(response);
            // Refused: it says why, and stops (a busy moment, or the server's, is tried again).
            if (response.status < 500 && response.status !== 429) {
              again = false;
              listener(answerOf(error));
              return;
            }
            throw error;
          }
          tries = 0;
          for await (const { event, data } of events(response.body!)) {
            if (stop.signal.aborted) return;
            const said = JSON.parse(data);
            if (event === "message") {
              listener({ value: given.one ? (said as unknown[])[0] ?? null : said });
            } else if (event === "failed") listener({ error: said.error });
            else if (event === "revoked") {
              again = false;
              listener({ error: said.error });
              return;
            }
          }
        } catch {
          // Dropped, or never reached: followed again, longer apart.
        } finally {
          if (again && !stop.signal.aborted) {
            setTimeout(() => void follow(tries + 1), Math.min(500 * 2 ** tries, 5_000));
          }
        }
      };
      void follow();
      return () => stop.abort();
    },
  };
}
