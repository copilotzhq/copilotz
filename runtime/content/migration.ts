/** Offline-only conversion. Callers must drain the old runtime and review the inventory. */
import {
  createCoreTableNames,
  validateEventSchemaName,
} from "../events/schema.ts";
import { runSqlTransaction, type SqlSession } from "../events/session.ts";
import { encodeEventBody } from "../events/body-store.ts";
import { contentCatalogStatements } from "./catalog-schema.ts";
import type { BodyStore } from "./body-store.ts";
import { digestContent } from "./digest.ts";
import { digestCatalogPrefix } from "./prefix-digest.ts";
export type EmbeddedBodyLocation = Readonly<
  { namespace: string; kind: string; backendId: string; key: string }
>;
type Copy = EmbeddedBodyLocation & {
  sourceKey?: string;
  collectable: boolean;
  bodyId: string;
  length: number;
  digest: string;
  versionToken: string;
  outcome: "completed" | "failed" | "cancelled";
};
type Row = {
  namespace: string;
  id: string;
  value: unknown;
  kind: "node" | "event";
};
export type ContentMigrationPlan = Readonly<
  {
    schema: string;
    inventory: readonly Copy[];
    rows: readonly Row[];
    streamRows: readonly {
      namespace: string;
      streamId: string;
      physicalKey: string;
      bodyId: string;
      reason?: string;
    }[];
    fingerprint: string;
  }
>;
function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
function location(
  value: Record<string, unknown>,
  namespace: string,
): EmbeddedBodyLocation | undefined {
  const stored = object(value.location);
  const kind = stored?.kind ?? value.storeKind;
  const key = stored?.key ?? value.bodyId;
  if (typeof kind !== "string" || typeof key !== "string") return undefined;
  const backendId = stored?.backendId ?? value.backendId ??
    (kind === "database" ? "database:default" : undefined);
  if (typeof backendId !== "string") {
    throw new TypeError(
      "Embedded physical backend requires an explicit migration decision.",
    );
  }
  return { namespace, kind, backendId, key };
}
function identity(value: EmbeddedBodyLocation & { sourceKey?: string }) {
  return JSON.stringify([
    value.namespace,
    value.kind,
    value.backendId,
    value.sourceKey ?? value.key,
  ]);
}
/** Read-only inventory. Missing or inconsistent bytes abort rather than inventing content. */
export async function inspectEmbeddedContent(
  input: {
    session: SqlSession;
    schema: string;
    storeFor: (location: EmbeddedBodyLocation) => BodyStore;
    streamBackend?: Readonly<{ kind: string; backendId: string }>;
    copyMappings?: readonly Readonly<
      {
        namespace: string;
        backendId: string;
        sourceBodyId: string;
        targetBodyId: string;
      }
    >[];
  },
): Promise<ContentMigrationPlan> {
  const schema = validateEventSchemaName(input.schema),
    tables = createCoreTableNames(schema),
    rows: Row[] = [];
  for (
    const row of (await input.session.query<
      { namespace: string; id: string; data: unknown }
    >(`SELECT namespace,id,data FROM ${tables.nodes}`)).rows
  ) {
    rows.push({
      namespace: row.namespace,
      id: row.id,
      value: row.data,
      kind: "node",
    });
  }
  for (
    const row of (await input.session.query<
      { namespace: string; event_body_id: string; body: unknown }
    >(`SELECT namespace,event_body_id,body FROM ${tables.event_bodies}`)).rows
  ) {
    rows.push({
      namespace: row.namespace,
      id: row.event_body_id,
      value: row.body,
      kind: "event",
    });
  }
  rows.sort((a, b) =>
    a.kind.localeCompare(b.kind) || a.namespace.localeCompare(b.namespace) ||
    a.id.localeCompare(b.id)
  );
  const copies = new Map<string, Copy>();
  async function include(
    loc: EmbeddedBodyLocation,
    claims: Record<string, unknown>,
    outcome: Copy["outcome"] = "completed",
  ) {
    const key = identity(loc);
    const existing = copies.get(key);
    if (existing) {
      if (
        (typeof claims.byteLength === "number" &&
          claims.byteLength !== existing.length) ||
        (typeof claims.digest === "string" &&
          claims.digest !== existing.digest) ||
        existing.outcome !== outcome
      ) {
        throw new Error(
          `Migration references disagree about retained content: ${loc.key}`,
        );
      }
      return existing;
    }
    const mapping = input.copyMappings?.find((copy) =>
      copy.namespace === loc.namespace && copy.backendId === loc.backendId &&
      copy.sourceBodyId === loc.key
    );
    const physicalKey = mapping?.targetBodyId ?? loc.key;
    const store = input.storeFor({ ...loc, key: physicalKey }),
      head = await store.head({ bodyId: physicalKey });
    if (!head || !(head.state === "ready" || head.state === "incomplete")) {
      throw new Error(
        `Migration requires a retained terminal copy: ${loc.key}`,
      );
    }
    const length = typeof claims.byteLength === "number"
      ? claims.byteLength
      : head.byteLength;
    const digest = await digestCatalogPrefix(store, physicalKey, length);
    if (typeof claims.digest === "string" && claims.digest !== digest) {
      throw new Error(`Migration integrity mismatch: ${loc.key}`);
    }
    if (
      outcome === "completed" &&
      (head.state !== "ready" || head.byteLength !== length ||
        head.digest !== digest)
    ) throw new Error(`Migration cannot certify completion: ${loc.key}`);
    const bodyId = `body:migrated:${
      (await digestContent(new TextEncoder().encode(key))).slice(7)
    }`;
    const copy = {
      ...loc,
      ...(mapping ? { key: physicalKey, sourceKey: loc.key } : {}),
      collectable: store.conditionalDelete,
      bodyId,
      length,
      digest,
      versionToken: head.versionToken,
      outcome,
    };
    copies.set(key, copy);
    return copy;
  }
  async function visit(value: unknown, namespace: string): Promise<void> {
    if (Array.isArray(value)) {
      for (const child of value) await visit(child, namespace);
      return;
    }
    const item = object(value);
    if (!item) return;
    const loc = location(item, namespace);
    if (loc) await include(loc, item);
    for (const child of Object.values(item)) await visit(child, namespace);
  }
  for (const row of rows) await visit(row.value, row.namespace);
  const streamRows: ContentMigrationPlan["streamRows"][number][] = [];
  const streams = `"${schema}"."copilotz_operation_streams"`;
  if (
    (await input.session.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [streams],
    )).rows[0]?.present
  ) {
    const entries = (await input.session.query<
      {
        namespace: string;
        stream_id: string;
        body_id: string;
        state: string;
        outcome: Copy["outcome"] | "superseded" | "abandoned";
        reason: string | null;
        committed_offset: string | number;
        digest: string;
        availability: string;
      }
    >(`SELECT s.*,to_jsonb(s)->>'reason' AS reason FROM ${streams} s`))
      .rows;
    for (const stream of entries) {
      if (stream.state !== "terminal") {
        throw new Error("Drain in-flight streams before content migration.");
      }
      if (!["retained", "purge_pending"].includes(stream.availability)) {
        continue;
      }
      if (!input.streamBackend) {
        throw new TypeError(
          "Stream backend must be selected explicitly for migration.",
        );
      }
      const copy = await include(
        {
          namespace: stream.namespace,
          ...input.streamBackend,
          key: stream.body_id,
        },
        { byteLength: Number(stream.committed_offset), digest: stream.digest },
        stream.outcome === "superseded"
          ? "cancelled"
          : stream.outcome === "abandoned"
          ? "failed"
          : stream.outcome,
      );
      streamRows.push({
        namespace: stream.namespace,
        streamId: stream.stream_id,
        physicalKey: stream.body_id,
        bodyId: copy.bodyId,
        ...((stream.reason || stream.outcome === "superseded" ||
            stream.outcome === "abandoned")
          ? { reason: stream.reason ?? stream.outcome }
          : {}),
      });
    }
  }
  streamRows.sort((a, b) =>
    a.namespace.localeCompare(b.namespace) ||
    a.streamId.localeCompare(b.streamId)
  );
  const inventory = [...copies.values()].sort((a, b) =>
    a.bodyId.localeCompare(b.bodyId)
  );
  const fingerprint = await digestContent(
    new TextEncoder().encode(
      JSON.stringify({ schema, inventory, rows, streamRows }),
    ),
  );
  return { schema, inventory, rows, streamRows, fingerprint };
}
function convert(
  value: unknown,
  namespace: string,
  copies: ReadonlyMap<string, Copy>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => convert(child, namespace, copies));
  }
  const item = object(value);
  if (!item) return value;
  const output = Object.fromEntries(
    Object.entries(item).map((
      [key, child],
    ) => [key, convert(child, namespace, copies)]),
  );
  const loc = location(item, namespace);
  if (loc) {
    const copy = copies.get(identity(loc));
    if (!copy) throw new Error("Migration inventory is incomplete.");
    delete output.location;
    delete output.storeKind;
    delete output.backendId;
    delete output.protectedUntil;
    output.bodyId = copy.bodyId;
  } else if (typeof item.bodyId === "string") {
    const matches = [...copies.values()].filter((copy) =>
      copy.namespace === namespace &&
      (copy.sourceKey ?? copy.key) === item.bodyId
    );
    if (matches.length === 1) output.bodyId = matches[0].bodyId;
    else if (matches.length > 1) {
      throw new Error("Ambiguous embedded body identity requires review.");
    }
  }
  return output;
}
/** Applies only the exact reviewed, drained fixture/inventory in one SQL transaction. */
export async function migrateEmbeddedContent(
  input: {
    session: SqlSession;
    plan: ContentMigrationPlan;
    drained: true;
    reviewedFingerprint: string;
  },
): Promise<{ bodies: number; documents: number; streams: number }> {
  const { plan } = input;
  if (
    input.drained !== true || input.reviewedFingerprint !== plan.fingerprint
  ) {
    throw new TypeError(
      "A drained runtime and reviewed content inventory are required.",
    );
  }
  const fingerprint = await digestContent(
    new TextEncoder().encode(
      JSON.stringify({
        schema: plan.schema,
        inventory: plan.inventory,
        rows: plan.rows,
        streamRows: plan.streamRows,
      }),
    ),
  );
  if (fingerprint !== plan.fingerprint) {
    throw new Error("Reviewed migration inventory changed.");
  }
  const tables = createCoreTableNames(plan.schema),
    copies = new Map(plan.inventory.map((copy) => [identity(copy), copy]));
  let documents = 0;
  await runSqlTransaction(input.session, async (transaction) => {
    for (const statement of contentCatalogStatements(plan.schema)) {
      await transaction.query(statement);
    }
    for (const copy of plan.inventory) {
      await transaction.query(
        `INSERT INTO ${tables.content_logical_bodies}(body_id,namespace,current_copy,writer_id,generation,revocation,protected_until,committed_offset,seal_intent,terminal) VALUES($1,$2,$3,'offline-migration',1,'revoked',NOW(),$4,$5::jsonb,$6::jsonb) ON CONFLICT(body_id) DO NOTHING`,
        [
          copy.bodyId,
          copy.namespace,
          copy.key,
          copy.length,
          copy.outcome === "completed"
            ? JSON.stringify({ length: copy.length, digest: copy.digest })
            : null,
          JSON.stringify({
            length: copy.length,
            ...(copy.outcome === "completed" ? { digest: copy.digest } : {}),
            outcome: copy.outcome,
          }),
        ],
      );
      await transaction.query(
        `INSERT INTO ${tables.content_copies}(copy_key,backend_kind,backend_id,body_id,version_token,state,collectable) VALUES($1,$2,$3,$4,$5,'current',$6) ON CONFLICT(copy_key) DO NOTHING`,
        [
          copy.key,
          copy.kind,
          copy.backendId,
          copy.bodyId,
          copy.versionToken,
          copy.collectable,
        ],
      );
      const stored =
        (await transaction.query<{ body_id: string; version_token: string }>(
          `SELECT body_id,version_token FROM ${tables.content_copies} WHERE copy_key=$1`,
          [copy.key],
        )).rows[0];
      if (
        stored.body_id !== copy.bodyId ||
        stored.version_token !== copy.versionToken
      ) {
        throw new Error(
          "Migration copy conflicts with existing catalog state.",
        );
      }
    }
    for (const row of plan.rows) {
      const converted = convert(row.value, row.namespace, copies);
      if (JSON.stringify(converted) === JSON.stringify(row.value)) continue;
      documents++;
      if (row.kind === "node") {
        const result = await transaction.query(
          `UPDATE ${tables.nodes} SET data=$3::jsonb WHERE namespace=$1 AND id=$2 AND data=$4::jsonb RETURNING id`,
          [
            row.namespace,
            row.id,
            JSON.stringify(converted),
            JSON.stringify(row.value),
          ],
        );
        if (!result.rows.length) {
          throw new Error("Migration source changed after review.");
        }
      } else {
        const encoded = await encodeEventBody(converted);
        const result = await transaction.query(
          `UPDATE ${tables.event_bodies} SET body=$3::jsonb,digest=$4 WHERE namespace=$1 AND event_body_id=$2 AND body=$5::jsonb RETURNING event_body_id`,
          [
            row.namespace,
            row.id,
            encoded.body,
            encoded.digest,
            JSON.stringify(row.value),
          ],
        );
        if (!result.rows.length) {
          throw new Error("Migration event changed after review.");
        }
      }
    }
    for (const stream of plan.streamRows) {
      if (stream.reason) {
        await transaction.query(
          `UPDATE ${tables.content_logical_bodies} SET terminal=terminal || jsonb_build_object('reason',$2::text) WHERE body_id=$1`,
          [stream.bodyId, stream.reason],
        );
      }
      await transaction.query(
        `UPDATE "${plan.schema}"."copilotz_operation_streams" SET body_id=$3 WHERE namespace=$1 AND stream_id=$2 AND body_id=$4`,
        [stream.namespace, stream.streamId, stream.bodyId, stream.physicalKey],
      );
    }
  });
  return {
    bodies: plan.inventory.length,
    documents,
    streams: plan.streamRows.length,
  };
}
