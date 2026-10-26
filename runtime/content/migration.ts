import {
  type ContentReference,
  type MissingContent,
  type UnrecoverableDecisions,
  unrecoverableIdentity,
  verifyUnrecoverableDecisions,
} from "./unrecoverable.ts";
import {
  contentFingerprint,
  retainedRows,
  type RowManifest,
} from "./offline-rows.ts";
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
import {
  inspectOfflinePrefixes,
  type OfflinePrefix,
} from "./offline-prefixes.ts";
export type EmbeddedBodyLocation = Readonly<
  { namespace: string; kind: string; backendId: string; key: string }
>;
type Copy = EmbeddedBodyLocation & {
  sourceKey?: string;
  collectable: boolean;
  bodyId: string;
  length: number;
  digest?: string;
  versionToken?: string;
  unavailable?: true;
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
    rows: readonly Row[] | RowManifest;
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
    /** Private native database selected by the offline upgrade, never inferred from an adapter label. */
    nativeDatabase?: SqlSession;
    /** Maximum simultaneous content checks; defaults to 16. */
    concurrency?: number;
    unrecoverable?: UnrecoverableDecisions;
    /** Internal read-only inventory sink; skips digest and migration validation. */
    missingContent?: MissingContent[];
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
  const reviewed = await verifyUnrecoverableDecisions(input.unrecoverable);
  const decisions = new Map(
    (reviewed?.entries ?? []).map((e) => [unrecoverableIdentity(e), e]),
  );
  const concurrency = input.concurrency ?? 16;
  if (
    !Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 256
  ) {
    throw new TypeError(
      "Content concurrency must be an integer from 1 to 256.",
    );
  }
  const schema = validateEventSchemaName(input.schema);
  const mappings = new Map<
    string,
    NonNullable<typeof input.copyMappings>[number]
  >();
  for (const mapping of input.copyMappings ?? []) {
    const key = JSON.stringify([
      mapping.namespace,
      mapping.backendId,
      mapping.sourceBodyId,
    ]);
    if (!mappings.has(key)) mappings.set(key, mapping);
  }
  const mappingFor = (loc: EmbeddedBodyLocation) =>
    mappings.get(JSON.stringify([loc.namespace, loc.backendId, loc.key]));
  let prefixes: ReadonlyMap<string, OfflinePrefix> = new Map();
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
    const mapping = mappingFor(loc);
    const physicalKey = mapping?.targetBodyId ?? loc.key;
    const store = input.storeFor({ ...loc, key: physicalKey }),
      head = prefixes.get(key)?.head ??
        await store.head({ bodyId: physicalKey });
    if (decisions.has(unrecoverableIdentity(loc))) {
      if (mapping) {
        throw new Error(
          "Unrecoverable decision conflicts with a copy mapping.",
        );
      }
      if (head !== null) {
        throw new Error(`Unrecoverable decision object exists: ${loc.key}`);
      }
      const copy: Copy = {
        ...loc,
        collectable: false,
        bodyId: `body:migrated:${
          (await digestContent(new TextEncoder().encode(key))).slice(7)
        }`,
        length: 0,
        // Keep the referencing record's terminal outcome; eligibility already
        // excludes completed references.
        outcome: outcome === "completed" ? "failed" : outcome,
        unavailable: true,
      };
      copies.set(key, copy);
      return copy;
    }
    if (!head || !(head.state === "ready" || head.state === "incomplete")) {
      throw new Error(
        `Migration requires a retained terminal copy: ${loc.key}`,
      );
    }
    const length = typeof claims.byteLength === "number"
      ? claims.byteLength
      : head.byteLength;
    const digest = prefixes.get(key)?.digest ??
      await digestCatalogPrefix(store, physicalKey, length);
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
  // Discover in canonical order before doing I/O. Each physical identity has one
  // worker, so repeated claims cannot race or silently bypass disagreement checks.
  const work = new Map<
    string,
    {
      loc: EmbeddedBodyLocation;
      claims: Record<string, unknown>;
      outcome?: Copy["outcome"];
      reference: ContentReference;
    }[]
  >();
  function enqueue(
    loc: EmbeddedBodyLocation,
    claims: Record<string, unknown>,
    outcome: Copy["outcome"] | undefined,
    reference: ContentReference,
  ) {
    const key = identity(loc), group = work.get(key) ?? [];
    // Never retain the enclosing JSON object (which can contain megabytes).
    group.push({
      loc,
      claims: { byteLength: claims.byteLength, digest: claims.digest },
      outcome,
      reference,
    });
    work.set(key, group);
  }
  const logicalReferences = new Map<string, ContentReference[]>();
  function visit(
    value: unknown,
    namespace: string,
    reference: ContentReference,
  ): void {
    if (Array.isArray(value)) {
      for (const child of value) visit(child, namespace, reference);
      return;
    }
    const item = object(value);
    if (!item) return;
    const status = item.outcome ?? item.status ??
      (["open", "terminating"].includes(String(item.state))
        ? item.state
        : undefined);
    if (typeof status === "string" && reference.outcome === "unknown") {
      reference = {
        ...reference,
        outcome: status,
        terminal:
          ["completed", "failed", "cancelled", "abandoned", "superseded"]
            .includes(status) &&
          (item.state === undefined ||
            ["terminal", "failed", "ready", "cancelled"].includes(
              String(item.state),
            )),
      };
    }
    const loc = location(item, namespace);
    if (loc) enqueue(loc, item, undefined, reference);
    else if (typeof item.bodyId === "string") {
      const key = JSON.stringify([namespace, item.bodyId]);
      const refs = logicalReferences.get(key) ?? [];
      refs.push(reference);
      logicalReferences.set(key, refs);
    }
    for (const child of Object.values(item)) visit(child, namespace, reference);
  }
  for await (const row of retainedRows(input.session, schema)) {
    visit(row.value, row.namespace, {
      kind: row.kind,
      id: row.id,
      outcome: "unknown",
      terminal: false,
    });
  }
  if (input.nativeDatabase) {
    const requests = new Map<string, { key: string; length?: number }>();
    for (const [key, group] of work) {
      const { loc, claims } = group[0];
      if (loc.kind === "database" && loc.backendId === "database:default") {
        requests.set(key, {
          key: mappingFor(loc)?.targetBodyId ?? loc.key,
          ...(typeof claims.byteLength === "number"
            ? { length: claims.byteLength }
            : {}),
        });
      }
    }
    prefixes = await inspectOfflinePrefixes(
      input.nativeDatabase,
      schema,
      requests,
    );
  }
  const streamRows: ContentMigrationPlan["streamRows"][number][] = [];
  const pendingStreams: {
    identity: string;
    row: ContentMigrationPlan["streamRows"][number];
  }[] = [];
  const streams = `"${schema}"."copilotz_operation_streams"`;
  if (
    (await input.session.query<{ present: boolean }>(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [streams],
    )).rows[0]?.present
  ) {
    const streamKeys = (await input.session.query<
      { namespace: string; operation_id: string; stream_id: string }
    >(
      `SELECT namespace,operation_id,stream_id FROM ${streams} ORDER BY namespace COLLATE "C",stream_id COLLATE "C"`,
    )).rows;
    for (let start = 0; start < streamKeys.length; start += 2000) {
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
      >(
        `SELECT s.namespace,s.stream_id,s.body_id,s.state,s.outcome,to_jsonb(s)->>'committed_offset' AS committed_offset,to_jsonb(s)->>'digest' AS digest,s.availability,to_jsonb(s)->>'reason' AS reason
         FROM ${streams} s JOIN jsonb_to_recordset($1::jsonb) AS k(namespace text,operation_id text,stream_id text)
         ON s.namespace=k.namespace AND s.operation_id=k.operation_id AND s.stream_id=k.stream_id
         ORDER BY s.namespace COLLATE "C",s.stream_id COLLATE "C"`,
        [JSON.stringify(streamKeys.slice(start, start + 2000))],
      ))
        .rows;
      for (const stream of entries) {
        if (!input.missingContent && stream.state !== "terminal") {
          throw new Error("Drain in-flight streams before content migration.");
        }
        const decidedStream = input.streamBackend &&
          decisions.has(unrecoverableIdentity({
            namespace: stream.namespace,
            backendId: input.streamBackend.backendId,
            key: stream.body_id,
          }));
        if (
          !input.missingContent && !decidedStream &&
          !["retained", "purge_pending"].includes(stream.availability)
        ) {
          const key = JSON.stringify([stream.namespace, stream.body_id]);
          const refs = logicalReferences.get(key) ?? [];
          refs.push({
            kind: "stream",
            id: stream.stream_id,
            outcome: stream.outcome,
            terminal: stream.state === "terminal",
          });
          logicalReferences.set(key, refs);
          continue;
        }
        if (!input.streamBackend) {
          throw new TypeError(
            "Stream backend must be selected explicitly for migration.",
          );
        }
        const loc = {
          namespace: stream.namespace,
          ...input.streamBackend,
          key: stream.body_id,
        };
        enqueue(
          loc,
          {
            byteLength: Number(stream.committed_offset),
            digest: stream.digest,
          },
          stream.outcome === "superseded"
            ? "cancelled"
            : stream.outcome === "abandoned"
            ? "failed"
            : stream.outcome,
          {
            kind: "stream",
            id: stream.stream_id,
            outcome: stream.outcome,
            terminal: stream.state === "terminal",
          },
        );
        pendingStreams.push({
          identity: identity(loc),
          row: {
            namespace: stream.namespace,
            streamId: stream.stream_id,
            physicalKey: stream.body_id,
            bodyId: "",
            ...((stream.reason || stream.outcome === "superseded" ||
                stream.outcome === "abandoned")
              ? { reason: stream.reason ?? stream.outcome }
              : {}),
          },
        });
      }
    }
  }
  const referencesFor = (
    group: { loc: EmbeddedBodyLocation; reference: ContentReference }[],
  ) => [
    ...group.map((item) => item.reference),
    ...(logicalReferences.get(
      JSON.stringify([group[0].loc.namespace, group[0].loc.key]),
    ) ?? []),
  ];
  const eligible = (
    group: typeof work extends Map<string, infer G> ? G : never,
  ) =>
    referencesFor(group).every((reference) =>
      reference.terminal &&
      ["failed", "cancelled", "abandoned", "superseded"].includes(
        reference.outcome,
      )
    );
  for (const [key] of decisions) {
    const groups = [...work.values()].filter((g) =>
      unrecoverableIdentity(g[0].loc) === key
    );
    if (!groups.length) {
      throw new Error("Unrecoverable decision location is not referenced.");
    }
    if (groups.some((g) => !eligible(g))) {
      throw new Error(
        "Unrecoverable decision references completed or non-terminal content.",
      );
    }
  }
  const groups = [...work.values()];
  let next = 0;
  let firstError: { index: number; error: unknown } | undefined;
  const recordError = (index: number, error: unknown) => {
    if (!firstError || index < firstError.index) firstError = { index, error };
  };
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(concurrency, groups.length) }, async () => {
      while (next < groups.length && !firstError) {
        const index = next++, group = groups[index];
        try {
          if (input.missingContent) {
            const loc = group[0].loc;
            if (
              loc.kind !== "database" &&
              await input.storeFor(loc).head({ bodyId: loc.key }) === null
            ) {
              input.missingContent.push({
                namespace: loc.namespace,
                backendId: loc.backendId,
                key: loc.key,
                references: referencesFor(group),
                eligible: eligible(group),
              });
            }
            continue;
          }
          if (decisions.has(unrecoverableIdentity(group[0].loc))) {
            await include(group[0].loc, group[0].claims, group[0].outcome);
            continue;
          }
          for (const item of group) {
            await include(item.loc, item.claims, item.outcome);
          }
        } catch (error) {
          recordError(index, error);
        }
      }
    }),
  );
  if (firstError) throw firstError.error;
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  if (input.missingContent) {
    input.missingContent.sort((a, b) =>
      unrecoverableIdentity(a).localeCompare(unrecoverableIdentity(b))
    );
    return {
      schema,
      inventory: [],
      rows: { count: 0, digest: "" },
      streamRows: [],
      fingerprint: "",
    };
  }
  for (const pending of pendingStreams) {
    streamRows.push({
      ...pending.row,
      bodyId: copies.get(pending.identity)!.bodyId,
    });
  }
  streamRows.sort((a, b) =>
    a.namespace.localeCompare(b.namespace) ||
    a.streamId.localeCompare(b.streamId)
  );
  const inventory = [...copies.values()].sort((a, b) =>
    a.bodyId.localeCompare(b.bodyId)
  );
  const { fingerprint, rows } = await contentFingerprint(input.session, {
    schema,
    inventory,
    rows: { count: 0, digest: "" },
    streamRows,
  });
  return { schema, inventory, rows, streamRows, fingerprint };
}
function convert(
  value: unknown,
  namespace: string,
  copies: ReadonlyMap<string, Copy>,
  byBody: ReadonlyMap<string, readonly Copy[]>,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => convert(child, namespace, copies, byBody));
  }
  const item = object(value);
  if (!item) return value;
  const output = Object.fromEntries(
    Object.entries(item).map((
      [key, child],
    ) => [key, convert(child, namespace, copies, byBody)]),
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
    if (copy.unavailable) {
      output.byteLength = 0;
      output.availability = "unavailable";
      delete output.digest;
    }
  } else if (typeof item.bodyId === "string") {
    const matches = byBody.get(JSON.stringify([namespace, item.bodyId])) ?? [];
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
  const tables = createCoreTableNames(plan.schema),
    copies = new Map(plan.inventory.map((copy) => [identity(copy), copy]));
  const byBody = new Map<string, Copy[]>();
  for (const copy of plan.inventory) {
    const key = JSON.stringify([copy.namespace, copy.sourceKey ?? copy.key]);
    const list = byBody.get(key) ?? [];
    list.push(copy);
    byBody.set(key, list);
  }
  let documents = 0;
  await runSqlTransaction(input.session, async (transaction) => {
    const actual = await contentFingerprint(transaction, plan);
    if (
      actual.fingerprint !== plan.fingerprint ||
      (!Array.isArray(plan.rows) &&
        JSON.stringify(actual.rows) !== JSON.stringify(plan.rows))
    ) {
      throw new Error("Reviewed migration inventory changed.");
    }
    for (const statement of contentCatalogStatements(plan.schema)) {
      await transaction.query(statement);
    }
    for (let start = 0; start < plan.inventory.length; start += 2000) {
      const batch = plan.inventory.slice(start, start + 2000).map((copy) => ({
        body_id: copy.bodyId,
        namespace: copy.namespace,
        key: copy.key,
        length: copy.length,
        seal: copy.outcome === "completed"
          ? { length: copy.length, digest: copy.digest }
          : null,
        terminal: {
          length: copy.length,
          ...(copy.outcome === "completed" ? { digest: copy.digest } : {}),
          outcome: copy.outcome,
        },
        kind: copy.kind,
        backend: copy.backendId,
        version: copy.versionToken,
        collectable: copy.collectable,
        unavailable: copy.unavailable ?? false,
      }));
      const json = JSON.stringify(batch);
      await transaction.query(
        `INSERT INTO ${tables.content_logical_bodies}(body_id,namespace,current_copy,writer_id,generation,revocation,protected_until,committed_offset,seal_intent,terminal)
         SELECT body_id,namespace,key,'offline-migration',1,'revoked',NOW(),length,seal,terminal
         FROM jsonb_to_recordset($1::jsonb) AS v(body_id text,namespace text,key text,length bigint,seal jsonb,terminal jsonb)
         ON CONFLICT(body_id) DO NOTHING`,
        [json],
      );
      await transaction.query(
        `INSERT INTO ${tables.content_copies}(copy_key,backend_kind,backend_id,body_id,version_token,state,collectable)
         SELECT key,kind,backend,body_id,version,'current',collectable
         FROM jsonb_to_recordset($1::jsonb) AS v(key text,kind text,backend text,body_id text,version text,collectable boolean,unavailable boolean) WHERE NOT unavailable
         ON CONFLICT(copy_key) DO NOTHING`,
        [json],
      );
      const conflict = await transaction.query(
        `SELECT 1 FROM jsonb_to_recordset($1::jsonb) AS v(key text,body_id text,version text,unavailable boolean)
         LEFT JOIN ${tables.content_copies} c ON c.copy_key=v.key
         WHERE NOT v.unavailable AND (c.body_id IS DISTINCT FROM v.body_id OR c.version_token IS DISTINCT FROM v.version) LIMIT 1`,
        [json],
      );
      if (conflict.rows.length) {
        throw new Error(
          "Migration copy conflicts with existing catalog state.",
        );
      }
      console.error(
        `[upgrade:${plan.schema}] logical copies ${
          Math.min(start + 2000, plan.inventory.length)
        }/${plan.inventory.length}`,
      );
    }
    const nodes: Record<string, unknown>[] = [],
      events: Record<string, unknown>[] = [];
    // Batch by encoded size as well as count: a few large retained bodies can
    // otherwise exceed V8's maximum string length in one JSON parameter.
    let pendingBytes = 0;
    async function flush() {
      pendingBytes = 0;
      if (nodes.length) {
        const result = await transaction.query(
          `UPDATE ${tables.nodes} n SET data=v.converted
           FROM jsonb_to_recordset($1::jsonb) AS v(namespace text,id text,converted jsonb,original jsonb)
           WHERE n.namespace=v.namespace AND n.id=v.id AND n.data=v.original RETURNING n.id`,
          [JSON.stringify(nodes)],
        );
        if (result.rows.length !== nodes.length) {
          throw new Error("Migration source changed after review.");
        }
        nodes.length = 0;
      }
      if (events.length) {
        const result = await transaction.query(
          `UPDATE ${tables.event_bodies} b SET body=v.converted,digest=v.digest
           FROM jsonb_to_recordset($1::jsonb) AS v(namespace text,id text,converted jsonb,digest text,original jsonb)
           WHERE b.namespace=v.namespace AND b.event_body_id=v.id AND b.body=v.original RETURNING b.event_body_id`,
          [JSON.stringify(events)],
        );
        if (result.rows.length !== events.length) {
          throw new Error("Migration event changed after review.");
        }
        events.length = 0;
      }
    }
    for await (
      const row of Array.isArray(plan.rows)
        ? plan.rows
        : retainedRows(transaction, plan.schema)
    ) {
      const converted = convert(row.value, row.namespace, copies, byBody);
      const convertedJson = JSON.stringify(converted),
        originalJson = JSON.stringify(row.value);
      if (convertedJson === originalJson) continue;
      documents++;
      const update = {
        namespace: row.namespace,
        id: row.id,
        converted,
        original: row.value,
      };
      if (row.kind === "node") nodes.push(update);
      else {
        const encoded = await encodeEventBody(converted);
        events.push({
          ...update,
          converted: JSON.parse(encoded.body),
          digest: encoded.digest,
        });
      }
      pendingBytes += convertedJson.length * 2 + originalJson.length;
      if (
        nodes.length + events.length >= 2000 || pendingBytes >= 32 * 1024 * 1024
      ) await flush();
    }
    await flush();
    console.error(
      `[upgrade:${plan.schema}] converted documents ${documents}/${
        Array.isArray(plan.rows)
          ? plan.rows.length
          : (plan.rows as RowManifest).count
      }`,
    );
    const unavailable = new Set(
      plan.inventory.filter((copy) => copy.unavailable).map((copy) =>
        copy.bodyId
      ),
    );
    if (plan.streamRows.some((stream) => unavailable.has(stream.bodyId))) {
      await transaction.query(
        `ALTER TABLE "${plan.schema}"."copilotz_operation_streams" ADD COLUMN IF NOT EXISTS availability_reason TEXT`,
      );
    }
    for (let start = 0; start < plan.streamRows.length; start += 2000) {
      const batch = plan.streamRows.slice(start, start + 2000);
      const missing = batch.filter((stream) => unavailable.has(stream.bodyId));
      if (missing.length) {
        await transaction.query(
          `UPDATE "${plan.schema}"."copilotz_operation_streams" s
         SET committed_offset=0,digest=NULL,availability='purged',availability_reason='missing'
         FROM jsonb_to_recordset($1::jsonb) AS v(namespace text,"streamId" text)
         WHERE s.namespace=v.namespace AND s.stream_id=v."streamId"`,
          [JSON.stringify(missing)],
        );
      }
      // Several streams may share one logical body; preserve the last reason.
      const reasons = new Map(
        batch.filter((stream) => stream.reason).map(
          (stream) => [stream.bodyId, stream],
        ),
      );
      if (reasons.size) {
        await transaction.query(
          `UPDATE ${tables.content_logical_bodies} b SET terminal=b.terminal || jsonb_build_object('reason',v.reason)
         FROM jsonb_to_recordset($1::jsonb) AS v("bodyId" text,reason text)
         WHERE b.body_id=v."bodyId"`,
          [JSON.stringify([...reasons.values()])],
        );
      }
      await transaction.query(
        `UPDATE "${plan.schema}"."copilotz_operation_streams" s SET body_id=v."bodyId"
         FROM jsonb_to_recordset($1::jsonb) AS v(namespace text,"streamId" text,"bodyId" text,"physicalKey" text)
         WHERE s.namespace=v.namespace AND s.stream_id=v."streamId" AND s.body_id=v."physicalKey"`,
        [JSON.stringify(batch)],
      );
    }
  });
  return {
    bodies: plan.inventory.length,
    documents,
    streams: plan.streamRows.length,
  };
}

/** Heads all external references without requiring them to be recoverable. */
export async function listMissingContent(
  input: Omit<
    Parameters<typeof inspectEmbeddedContent>[0],
    "unrecoverable" | "missingContent"
  >,
): Promise<MissingContent[]> {
  const missingContent: MissingContent[] = [];
  await inspectEmbeddedContent({ ...input, missingContent });
  return missingContent;
}
