import type { EventMutationContext } from "./store.ts";
import type { EventBodyRef } from "./types.ts";

export const EVENT_BODY_SCHEMA_VERSION = 1;

type EventBodyRow = Record<string, unknown> & {
  namespace: string;
  event_body_id: string;
  schema_version: number;
  body: unknown;
  digest: string;
  created_at: string | Date;
};

export type EventBodyStoreContext = Pick<
  EventMutationContext,
  "transaction" | "tables"
>;

export type WriteEventBodyInput = Readonly<{
  namespace: string;
  id: string;
  json: unknown;
}>;

export type EventBodyStore = Readonly<{
  write(input: WriteEventBodyInput): Promise<EventBodyRef>;
  read<T>(namespace: string, dataRef: EventBodyRef): Promise<T>;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalizeJson(child)]),
    );
  }
  return value;
}

function canonicalJson(value: unknown): string {
  const text = JSON.stringify(
    normalizeJson(value === undefined ? null : value),
  );
  if (text === undefined) {
    throw new TypeError("Event body must be JSON serializable.");
  }
  return text;
}

async function eventBodyDigest(value: unknown): Promise<`sha256:${string}`> {
  if (!globalThis.crypto?.subtle) {
    throw new TypeError(
      "A Web Crypto SHA-256 implementation is required to persist event bodies.",
    );
  }
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const input = bytes.slice().buffer as ArrayBuffer;
  const digest = new Uint8Array(
    await globalThis.crypto.subtle.digest("SHA-256", input),
  );
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

async function requireStoredBody(
  context: EventBodyStoreContext,
  namespace: string,
  eventBodyId: string,
): Promise<EventBodyRow> {
  const result = await context.transaction.query<EventBodyRow>(
    `SELECT namespace, event_body_id, schema_version, body, digest, created_at
       FROM ${context.tables.event_bodies}
      WHERE namespace = $1 AND event_body_id = $2
      LIMIT 1`,
    [namespace, eventBodyId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Event body '${eventBodyId}' was not found.`);
  }
  return row;
}

export async function writeEventBody(
  context: EventBodyStoreContext,
  input: WriteEventBodyInput,
): Promise<EventBodyRef> {
  const digest = await eventBodyDigest(input.json);
  const body = canonicalJson(input.json);
  const inserted = await context.transaction.query<EventBodyRow>(
    `INSERT INTO ${context.tables.event_bodies} (
       namespace, event_body_id, schema_version, body, digest, created_at
     ) VALUES ($1, $2, $3, $4::jsonb, $5, NOW())
     ON CONFLICT (namespace, event_body_id) DO NOTHING
     RETURNING namespace, event_body_id, schema_version, body, digest, created_at`,
    [
      input.namespace,
      input.id,
      EVENT_BODY_SCHEMA_VERSION,
      body,
      digest,
    ],
  );
  const row = inserted.rows[0] ??
    await requireStoredBody(context, input.namespace, input.id);
  if (
    Number(row.schema_version) !== EVENT_BODY_SCHEMA_VERSION ||
    String(row.digest) !== digest ||
    canonicalJson(row.body) !== body
  ) {
    throw new Error(
      `Event body '${input.id}' already exists with different content.`,
    );
  }
  return Object.freeze({
    eventBodyId: input.id,
    schemaVersion: EVENT_BODY_SCHEMA_VERSION,
    mediaType: "application/json",
  });
}

export async function readEventBody<T>(
  context: EventBodyStoreContext,
  namespace: string,
  dataRef: EventBodyRef,
): Promise<T> {
  const eventBodyId = dataRef.eventBodyId.trim();
  if (!eventBodyId) {
    throw new TypeError("Event body ref is missing eventBodyId.");
  }
  const row = await requireStoredBody(context, namespace, eventBodyId);
  if (Number(row.schema_version) !== dataRef.schemaVersion) {
    throw new Error(
      `Event body '${eventBodyId}' has the wrong schema version.`,
    );
  }
  const digest = await eventBodyDigest(row.body);
  if (digest !== row.digest) {
    throw new Error(`Event body '${eventBodyId}' digest verification failed.`);
  }
  return row.body as T;
}

export function createEventBodyStore(
  context: EventBodyStoreContext,
): EventBodyStore {
  return Object.freeze({
    write: (input) => writeEventBody(context, input),
    read: <T>(namespace: string, dataRef: EventBodyRef) =>
      readEventBody<T>(context, namespace, dataRef),
  });
}

export function eventDataRef(payload: unknown): EventBodyRef {
  const fields = record(payload);
  const ref = record(fields.dataRef);
  if (typeof ref.eventBodyId !== "string" || !ref.eventBodyId.trim()) {
    throw new TypeError(
      "Collection event payload is missing dataRef.eventBodyId.",
    );
  }
  const schemaVersion = Number(ref.schemaVersion);
  if (!Number.isInteger(schemaVersion) || schemaVersion <= 0) {
    throw new TypeError(
      "Collection event payload is missing dataRef.schemaVersion.",
    );
  }
  if (ref.mediaType !== "application/json") {
    throw new TypeError(
      "Collection event payload has an invalid dataRef.mediaType.",
    );
  }
  return Object.freeze({
    eventBodyId: ref.eventBodyId,
    schemaVersion,
    mediaType: "application/json",
  });
}
