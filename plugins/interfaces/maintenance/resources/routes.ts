/**
 * The maintenance endpoints, the plugin's `routes` resource, under
 * `/maintenance/`. Every request shows the app's one maintenance key
 * (`Authorization: Bearer <key>`), compared in constant time, and acts as
 * the maintenance actor; `X-Maintenance-By` says who sent it, for the
 * record. JSON in and out, errors as `{ error: { code, message } }` with
 * the status their code says; no CORS, so a page elsewhere can't call it.
 *
 * - `GET /maintenance/`: what's here: whether the store runs SQL, the
 *   collections, the limits, the endpoints.
 * - `POST /maintenance/sql` `{ sql, params?, limit?, timeout? }`: one
 *   read-only statement on committed state: `{ rows, count, truncated, ms }`.
 * - `POST /maintenance/sql/write` `{ sql, params?, limit?, timeout? }`: one
 *   statement that writes, run by the owner in line with its other writes,
 *   fenced, with its `maintenance.sql` audit event (runtime/maintain.ts):
 *   `{ changed, rows, truncated, event, ms }`. It bypasses schemas and
 *   per-document events: use the collections' operations when they can.
 * - `POST /maintenance/collections/<collection>/<op>`: an operation through
 *   the owner's write path (the `maintenance.read` and `maintenance.write`
 *   Actions): insertOne `{ doc }`, insertMany `{ docs }`, updateOne and
 *   updateMany `{ filter, update, upsert? }`, replaceOne `{ filter, doc,
 *   upsert? }`, deleteOne and deleteMany `{ filter }` (all of them is
 *   `filter: {}`, said so); find `{ filter?, sort?, limit?, skip? }`,
 *   findOne `{ filter?, sort? }`, countDocuments `{ filter? }`, aggregate
 *   `{ pipeline }`.
 * - `GET /maintenance/blobs/<sha256-…>`: a blob's bytes and type, as a download.
 *
 * Writes take an `Idempotency-Key`: sent again, one answers what it did the
 * first time, without doing it twice. Reads take at most the settings'
 * `limit` rows and `timeout` ms, and may ask for less.
 */
import { type Actor, invalid, type Resources, type Runtime } from "../../../../runtime/mod.ts";
import type { MaintenanceActor, MaintenanceSettings } from "../contract.ts";
import { isRead, READS } from "../actions/read.ts";
import { isWrite, WRITES } from "../actions/write.ts";

// The settings (the `maintenance` resource), with their defaults, checked.

/** A key shorter than this is refused at start: it would be guessable. */
const MIN_KEY = 32;

type Settings = { key?: string; limit: number; timeout: number };

const positive = (value: unknown, name: string, fallback: number) => {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw invalid(`maintenance.${name} is a positive number`);
  }
  return Math.floor(value);
};

export function settingsOf(resources: Resources): Settings {
  const set = (resources.maintenance ?? {}) as MaintenanceSettings;
  const key = set.key === undefined || set.key === null || set.key === "" ? undefined : set.key;
  if (key !== undefined && (typeof key !== "string" || key.length < MIN_KEY)) {
    throw invalid(`maintenance.key is at least ${MIN_KEY} random characters`);
  }
  return {
    ...(key ? { key } : {}),
    limit: positive(set.limit, "limit", 1_000),
    timeout: positive(set.timeout, "timeout", 30_000),
  };
}

// The key a request shows, compared in constant time: both are hashed first, so the comparison
// takes as long whatever their lengths and wherever they differ.

const digest = async (text: string) =>
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));

/** Whether `given` is `key`, in time that tells nothing about either. */
export async function sameKey(given: string, key: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(given), digest(key)]);
  let differ = 0;
  for (let i = 0; i < a.length; i++) differ |= a[i] ^ b[i];
  return differ === 0;
}

/** The key a request shows: a Bearer token, or undefined. */
function bearer(request: Request): string | undefined {
  const [scheme, token, ...rest] = (request.headers.get("authorization") ?? "").trim().split(/\s+/);
  return scheme?.toLowerCase() === "bearer" && token && !rest.length ? token : undefined;
}

// Answers: JSON (bytes as `{ base64 }`, big integers as strings), and bodies read within a limit.

/** The largest body taken: 16 MB. */
const MAX_BODY = 16 * 1024 * 1024;

/** The status each error code answers with. */
const STATUS: Record<string, number> = {
  invalid: 400,
  sql: 400,
  read_only: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  method: 405,
  duplicate_key: 409,
  id_conflict: 409,
  too_large: 413,
  unsupported: 501,
  shared_schema: 501,
  unavailable: 503,
  fenced: 503,
  timeout: 504,
};

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
};

/** What JSON can't say as it is: bytes, and integers too big for a number. */
const plain = (_key: string, value: unknown) =>
  typeof value === "bigint"
    ? value.toString()
    : value instanceof Uint8Array
    ? { base64: base64(value) }
    : value;

const json = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value ?? null, plain), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

/** An error as the endpoints say it. */
const failure = (
  status: number,
  code: string,
  message: string,
  headers: Record<string, string> = {},
) => json({ error: { code, message } }, status, headers);

/** An error with a code: the endpoints' own, the runtime's, the stores'. */
const fault = (code: string, message: string) => Object.assign(new Error(message), { code });

/** What a thrown error answers: its code's status and its message; anything else, a 500. */
function answerFor(error: unknown): Response {
  const code = (error as { code?: unknown })?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (/^Unknown (action|collection)/.test(message)) return failure(404, "not_found", message);
  if (typeof code === "string" && STATUS[code]) {
    const state = (error as { state?: unknown }).state;
    return json(
      { error: { code, message, ...(state !== undefined ? { state } : {}) } },
      STATUS[code],
    );
  }
  console.error("maintenance:", message);
  return failure(500, "internal", "Something went wrong.");
}

/** A request's JSON body, an object; none is `{}`. Refused past `MAX_BODY`. */
async function bodyOf(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length") ?? 0) > MAX_BODY) {
    throw fault("too_large", "The body is too large (16 MB at most).");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (request.body) {
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
  }
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) (bytes.set(chunk, at), at += chunk.length);
  const text = new TextDecoder().decode(bytes);
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw fault("invalid", "The body isn't JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw fault("invalid", "The body is a JSON object.");
  }
  return body as Record<string, unknown>;
}

// The endpoints.

/** What the web host hands a `serve` route: the runtime, and who a session signs in (unused). */
type Served = {
  runtime: Pick<Runtime, "call" | "describe" | "maintenance">;
  whom?(): Promise<Actor | null>;
};

const BLOB = /^sha256-[0-9a-f]{64}$/;

const unauthorized = () =>
  failure(401, "unauthorized", "Show the maintenance key: `Authorization: Bearer <key>`.", {
    "www-authenticate": 'Bearer realm="maintenance"',
  });

/** Who sends it: the key's holder, by the name the request gives (as given). */
function actorOf(request: Request): MaintenanceActor {
  const by = request.headers.get("x-maintenance-by");
  if (by === null) return { kind: "maintenance", id: "maintenance" };
  if (!/^[\x20-\x7e]{1,100}$/.test(by) || !by.trim()) {
    throw fault("invalid", "X-Maintenance-By is a name: 1 to 100 visible ASCII characters.");
  }
  return { kind: "maintenance", id: "maintenance", by: by.trim() };
}

/** A write's id, from the caller's `Idempotency-Key`, apart for each kind of write. */
function idOf(request: Request, kind: "sql" | "op"): string | undefined {
  const given = request.headers.get("idempotency-key");
  if (given === null) return undefined;
  if (!/^[\x21-\x7e]{1,200}$/.test(given)) {
    throw fault("invalid", "An Idempotency-Key is 1 to 200 visible ASCII characters.");
  }
  return `maintenance:${kind}:${given}`;
}

/** Only these fields, so a misspelt one isn't quietly ignored. */
function only(body: Record<string, unknown>, fields: string[]) {
  const other = Object.keys(body).find((field) => !fields.includes(field));
  if (other) throw fault("invalid", `Unknown field \`${other}\`: this takes ${fields.join(", ")}.`);
}

/** A whole number from 1 to `max`, or `max` when not given. */
function upTo(value: unknown, name: string, max: number): number {
  if (value === undefined) return max;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    throw fault("invalid", `\`${name}\` is a whole number from 1 to ${max}.`);
  }
  return value as number;
}

/** A SQL request's statement and options, checked against the settings. */
function sqlOf(body: Record<string, unknown>, settings: Settings) {
  only(body, ["sql", "params", "limit", "timeout"]);
  if (typeof body.sql !== "string" || !body.sql.trim()) {
    throw fault("invalid", "`sql` is the statement, as text.");
  }
  if (body.params !== undefined && !Array.isArray(body.params)) {
    throw fault("invalid", "`params` is a list, bound in order ($1, $2… or ?1, ?2…).");
  }
  return {
    sql: body.sql,
    ...(body.params !== undefined ? { params: body.params as unknown[] } : {}),
    limit: upTo(body.limit, "limit", settings.limit),
    timeout: upTo(body.timeout, "timeout", settings.timeout),
  };
}

/** Answers a request under `/maintenance/`. */
export async function serveMaintenance(request: Request, host?: Served): Promise<Response> {
  if (!host?.runtime) {
    return failure(501, "unavailable", "The web host doesn't hand this route the runtime.");
  }
  const { runtime } = host;
  try {
    const settings = settingsOf(runtime.describe().resources);
    if (!settings.key) {
      return failure(
        503,
        "unavailable",
        "Maintenance is off: the app's settings give it no key (resources.maintenance.key).",
      );
    }
    const given = bearer(request);
    if (!given || !await sameKey(given, settings.key)) return unauthorized();
    const actor = actorOf(request);
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/maintenance\/?/, "/");
    const method = (want: string) => {
      if (request.method !== want) throw fault("method", `Use ${want} for ${url.pathname}.`);
    };

    if (path === "/") {
      method("GET");
      return json({
        sql: runtime.maintenance.sql,
        collections: Object.keys(runtime.describe().collections).sort(),
        limit: settings.limit,
        timeout: settings.timeout,
        endpoints: {
          "POST /maintenance/sql": "{ sql, params?, limit?, timeout? }: one read-only statement",
          "POST /maintenance/sql/write": "{ sql, params?, limit?, timeout? }: one that writes",
          "POST /maintenance/collections/<collection>/<op>": [...WRITES, ...READS].join(", "),
          "GET /maintenance/blobs/<id>": "a blob's bytes",
        },
      });
    }
    if (path === "/sql") {
      method("POST");
      const { sql, ...options } = sqlOf(await bodyOf(request), settings);
      const started = performance.now();
      try {
        const { rows, truncated } = await runtime.maintenance.read(sql, options);
        return json({ rows, count: rows.length, truncated, ms: elapsed(started) });
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== "read_only") throw error;
        throw fault(code, `${(error as Error).message} (this endpoint reads: /sql/write writes)`);
      }
    }
    if (path === "/sql/write") {
      method("POST");
      const { sql, ...options } = sqlOf(await bodyOf(request), settings);
      const id = idOf(request, "sql");
      const started = performance.now();
      const done = await runtime.maintenance.write(sql, {
        ...options,
        actor,
        ...(id ? { id } : {}),
      });
      return json({
        changed: done.changed,
        rows: done.rows,
        truncated: done.truncated,
        event: { id: done.event.id, seq: done.event.seq, at: done.event.at },
        ms: elapsed(started),
        ...(done.repeated ? { repeated: true } : {}),
      });
    }
    const operation = /^\/collections\/([^/]+)\/([^/]+)$/.exec(path);
    if (operation) {
      method("POST");
      const [collection, op] = operation.slice(1).map(decodeURIComponent);
      const body = await bodyOf(request);
      if (isWrite(op)) {
        only(body, ["doc", "docs", "filter", "update", "upsert"]);
        const id = idOf(request, "op");
        return json(
          await runtime.call(
            "maintenance.write",
            { ...body, collection, op },
            { actor, ...(id ? { id } : {}) },
          ),
        );
      }
      if (isRead(op)) {
        only(body, ["filter", "sort", "limit", "skip", "pipeline"]);
        const limit = upTo(body.limit, "limit", settings.limit);
        return json(
          await runtime.call("maintenance.read", { ...body, collection, op, limit }, { actor }),
        );
      }
      throw fault("not_found", `No operation "${op}": ${[...WRITES, ...READS].join(", ")}.`);
    }
    const blob = /^\/blobs\/([^/]+)$/.exec(path);
    if (blob) {
      method("GET");
      const id = decodeURIComponent(blob[1]);
      if (!BLOB.test(id)) throw fault("invalid", "A blob's id is sha256- and 64 hex digits.");
      const found = await runtime.maintenance.blob(id);
      if (!found) throw fault("not_found", `No blob ${id}.`);
      return new Response(found.data as BodyInit, {
        headers: {
          "content-type": found.type || "application/octet-stream",
          "content-length": String(found.data.length),
          // Never shown at the app's address, whatever it holds: saved, as a file.
          "content-disposition": `attachment; filename="${id}"`,
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          "cache-control": "no-store",
        },
      });
    }
    throw fault("not_found", `Nothing at ${url.pathname}: see GET /maintenance/ for what's here.`);
  } catch (error) {
    return answerFor(error);
  }
}

const elapsed = (started: number) => Math.round((performance.now() - started) * 100) / 100;

/** The route the web host serves them at. */
export const route = { path: "/maintenance/", serve: serveMaintenance };
