import { digestContent } from "../content/digest.ts";
import type { ContentRef } from "../content/index.ts";
import type { EventMutationContext } from "../events/index.ts";

type AssetNodeRow = Record<string, unknown> & {
  id: string;
  data: unknown;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export async function writeEventBody(
  context: EventMutationContext,
  input: Readonly<{
    namespace: string;
    id: string;
    json: unknown;
  }>,
): Promise<ContentRef> {
  const bytes = new TextEncoder().encode(JSON.stringify(input.json));
  const digest = await digestContent(bytes);
  const body = new TextDecoder().decode(bytes);
  const data = JSON.stringify({
    mediaType: "application/json",
    byteLength: bytes.byteLength,
    digest,
    state: "ready",
    location: { kind: "database", encoding: "json" },
    body,
    origin: {
      scope: { type: "namespace", id: input.namespace },
      producer: { type: "collection_event", id: input.id },
    },
    metadata: { role: "event.body" },
  });
  await context.transaction.query(
    `INSERT INTO ${context.tables.nodes} (
       id, namespace, type, name, data, source_type, source_id
     ) VALUES ($1, $2, 'asset', $3, $4::jsonb, $5, $6)`,
    [
      input.id,
      input.namespace,
      "application/json",
      data,
      "collection_event_body",
      input.id,
    ],
  );
  return Object.freeze({
    assetId: input.id,
    kind: "json",
    role: "body",
    mediaType: "application/json",
  });
}

export async function readEventBody<T>(
  context: Pick<EventMutationContext, "transaction" | "tables">,
  namespace: string,
  dataRef: ContentRef,
): Promise<T> {
  const result = await context.transaction.query<AssetNodeRow>(
    `SELECT id, data FROM ${context.tables.nodes}
     WHERE namespace = $1 AND id = $2 AND type = 'asset' LIMIT 1`,
    [namespace, dataRef.assetId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`Event body '${dataRef.assetId}' was not found.`);
  }
  const data = record(row.data);
  const raw = data.body;
  if (typeof raw !== "string") {
    throw new Error(`Event body '${dataRef.assetId}' is missing JSON.`);
  }
  return JSON.parse(raw) as T;
}

export function eventDataRef(payload: unknown): ContentRef {
  const fields = record(payload);
  const ref = record(fields.dataRef);
  if (typeof ref.assetId !== "string" || !ref.assetId.trim()) {
    throw new TypeError("Collection event payload is missing dataRef.assetId.");
  }
  return Object.freeze({
    assetId: ref.assetId,
    kind: "json",
    role: typeof ref.role === "string" ? ref.role : "body",
    mediaType: typeof ref.mediaType === "string"
      ? ref.mediaType
      : "application/json",
  });
}
