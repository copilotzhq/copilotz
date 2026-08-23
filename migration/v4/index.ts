/**
 * Explicit upgrade for the exact legacy-graph-v1 profile deployed by
 * Copilotz 0.47/0.48. It archives the old graph, emits ordinary final source
 * Events, rebuilds and verifies projections, then writes the v4 ready marker.
 */
import {
  createCoreSchemaStatements,
  createCoreTableNames,
  EVENT_SCHEMA_VERSION,
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../../runtime/events/schema.ts";
import type { SqlExecutor, SqlSession } from "../../runtime/events/session.ts";
import { createEventStore } from "../../runtime/events/store.ts";
import {
  eventDataRef,
  readEventBody,
  writeEventBody,
} from "../../runtime/events/body-store.ts";
import { createDatabaseBodyStore } from "../../runtime/content/database-body-store.ts";
import { assetBodyKey } from "../../runtime/content/body-store.ts";
import { readBodyBytes } from "../../runtime/content/body-store.ts";
import { digestContent } from "../../runtime/content/digest.ts";
import type {
  AssetEventBody,
  AssetRecord,
  ContentRef,
} from "../../runtime/content/types.ts";
import {
  type AnyCopilotzPlugin,
  createPluginRegistry,
} from "../../runtime/plugins/index.ts";
import type { CollectionDefinition } from "../../runtime/collections/definition.ts";
import { validateCollectionRecord } from "../../runtime/collections/validate.ts";
import type {
  CollectionEventBody,
  GraphRelationEventBody,
} from "../../runtime/collections/types.ts";
import {
  rebuildNamespaceProjections,
  verifyCollectionProjections,
} from "../../runtime/collections/replay.ts";
import { detectLegacyGraphV1, type LegacyProfile } from "./profile.ts";

const STATE_TABLE = "copilotz_v4_migration_state";
const ARCHIVE_SUFFIX = "_copilotz_v4_legacy";

export type LegacyAssetReference = Readonly<{
  /** Original application schema, even after its tables move to the archive. */
  sourceSchema: string;
  id: string;
  namespace: string;
  type: string;
  name: string;
  ref: string;
  data: Readonly<Record<string, unknown>>;
  sourceType: string | null;
  sourceId: string | null;
}>;

/** Resolves one durable `asset://` reference. Any thrown error aborts the cut. */
export type ResolvedLegacyAsset = Readonly<{
  bytes: Uint8Array;
  mediaType?: string;
}>;

export type ResolveLegacyAsset = (
  reference: LegacyAssetReference,
) => ResolvedLegacyAsset | Promise<ResolvedLegacyAsset>;

export type LegacyGraphV1Preflight = Readonly<{
  schema: string;
  profile: "legacy-graph-v1";
  counts: Readonly<
    Record<"threads" | "events" | "nodes" | "edges" | "assetRefs", number>
  >;
  digest: string;
}>;

export type MigrateToV4Options = Readonly<{
  session: SqlSession;
  /** The physical schema containing the released graph. Defaults to public. */
  schema?: string;
  /** Required for the cut: every legacy asset:// reference is resolved first. */
  resolveLegacyAsset: ResolveLegacyAsset;
  /** Final collection graph used to validate and replay source records. */
  plugins: readonly AnyCopilotzPlugin[];
  /** Immutable caller-owned migration configuration, fingerprinted canonically. */
  config?: unknown;
  /** Bounded read page size. */
  pageSize?: number;
}>;

type V4ArchiveCutResult = Readonly<{
  schema: string;
  archiveSchema: string;
  sourceProfile: "legacy-graph-v1";
  baselineDigest: string;
  configFingerprint: string;
  counts: LegacyGraphV1Preflight["counts"];
  stage: "archive-cut";
  alreadyCut: boolean;
}>;

export type V4SourceResult = Readonly<{
  schema: string;
  archiveSchema: string;
  baselineDigest: string;
  pluginFingerprint: string;
  stage: "sources";
  counts: Readonly<{ assets: number; records: number }>;
}>;

export type V4MigrationResult = Readonly<{
  schema: string;
  archiveSchema: string;
  baselineDigest: string;
  pluginFingerprint: string;
  stage: "complete";
  counts: Readonly<
    { retained: number; retired: number; sourceEvents: number; assets: number }
  >;
}>;

type StateRow = Readonly<{
  source_profile: string;
  archive_schema: string;
  baseline_digest: string;
  config_fingerprint: string;
  counts: unknown;
  stage: string;
  plugin_fingerprint?: string | null;
  source_cursor?: unknown;
}>;

const RETIRED_NODE_TYPES = new Set([
  "tool_execution",
  "llm_attempt",
  "llm_usage",
]);

function q(schema: string, table: string): string {
  return `${quoteEventIdentifier(schema)}.${quoteEventIdentifier(table)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return asRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalize(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)]),
    );
  }
  return value;
}

function canonical(value: unknown): string {
  return JSON.stringify(normalize(value));
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const result = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `sha256:${
    Array.from(result, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const result = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes.slice().buffer),
  );
  return `sha256:${
    Array.from(result, (byte) => byte.toString(16).padStart(2, "0")).join("")
  }`;
}

function strictConfig(value: unknown): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return value;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return value;
    throw new TypeError(
      "v4 migration config must not contain non-finite numbers.",
    );
  }
  if (Array.isArray(value)) return value.map(strictConfig);
  if (
    value && typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, strictConfig(child)]),
    );
  }
  throw new TypeError(
    "v4 migration config must be losslessly JSON-serializable.",
  );
}

async function fingerprintConfig(value: unknown): Promise<string> {
  return await sha256(strictConfig(value));
}

function pageSize(value: number | undefined): number {
  const size = value ?? 250;
  if (!Number.isSafeInteger(size) || size < 1 || size > 1_000) {
    throw new TypeError(
      "v4 migration pageSize must be an integer from 1 through 1000.",
    );
  }
  return size;
}

function numberCounts(value: unknown): LegacyGraphV1Preflight["counts"] {
  const counts = asRecord(value);
  const number = (
    key: "threads" | "events" | "nodes" | "edges" | "assetRefs",
  ) => {
    const candidate = Number(counts[key]);
    if (!Number.isSafeInteger(candidate) || candidate < 0) {
      throw new Error("v4 archive state has invalid counts.");
    }
    return candidate;
  };
  return Object.freeze({
    threads: number("threads"),
    events: number("events"),
    nodes: number("nodes"),
    edges: number("edges"),
    assetRefs: number("assetRefs"),
  });
}

/** A stable, valid archive schema name, including a source-schema hash for long names. */
async function legacyGraphV1ArchiveSchemaName(
  schemaName = "public",
): Promise<string> {
  const schema = validateEventSchemaName(schemaName);
  const suffix = (await sha256(schema)).slice(
    "sha256:".length,
    "sha256:".length + 12,
  );
  const prefixLength = 63 - ARCHIVE_SUFFIX.length - suffix.length - 1;
  return `${schema.slice(0, prefixLength)}${ARCHIVE_SUFFIX}_${suffix}`;
}

function refusal(profile: LegacyProfile): Error {
  return new Error(
    `v4 migration refuses schema '${profile.schema}' classified as '${profile.kind}'; only exact legacy-graph-v1 is supported.`,
  );
}

async function rejectBusyLegacyGraph(
  executor: SqlExecutor,
  schema: string,
): Promise<void> {
  const events = await executor.query<
    { status: string; count: string | number }
  >(
    `SELECT status, count(*) AS count FROM ${q(schema, "events")}
      WHERE status IN ('pending', 'processing') GROUP BY status ORDER BY status`,
  );
  if (events.rows.length > 0) {
    throw new Error(
      `v4 migration refuses actionable legacy events: ${
        events.rows.map((row) => `${row.status}:${row.count}`).join(", ")
      }.`,
    );
  }
  const locks = await executor.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM ${q(schema, "threads")}
      WHERE "workerLockedBy" IS NOT NULL OR "workerLeaseExpiresAt" IS NOT NULL`,
  );
  if (Number(locks.rows[0]?.count ?? 0) > 0) {
    throw new Error(
      "v4 migration refuses legacy threads with worker locks or leases.",
    );
  }
  const orphans = await executor.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM ${q(schema, "edges")} edge
      LEFT JOIN ${q(schema, "nodes")} source ON source.id = edge.source_node_id
      LEFT JOIN ${q(schema, "nodes")} target ON target.id = edge.target_node_id
      WHERE source.id IS NULL OR target.id IS NULL`,
  );
  if (Number(orphans.rows[0]?.count ?? 0) > 0) {
    throw new Error("v4 migration refuses legacy graph with orphan edges.");
  }
}

// Released Asset IDs are URI-path-safe identifiers. Deliberately stop before
// Markdown/JSON punctuation so ``asset://id`.`` is read as `asset://id`.
const ASSET_REF = /asset:\/\/[A-Za-z0-9][A-Za-z0-9._~:@%+\/-]*/g;

function assetRefs(value: unknown, found: string[]): void {
  if (typeof value === "string") {
    for (const match of value.matchAll(ASSET_REF)) found.push(match[0]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assetRefs(item, found);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value as Record<string, unknown>)) {
      assetRefs(item, found);
    }
  }
}

/**
 * Reads the whole released graph in bounded pages. The chained digest covers
 * every physical row in a table/id order and is rechecked in the cut tx.
 */
async function preflightLegacyGraphV1(
  executor: SqlExecutor,
  options: Readonly<{
    schema?: string;
    sourceSchema?: string;
    resolveLegacyAsset: ResolveLegacyAsset;
    pageSize?: number;
  }>,
): Promise<LegacyGraphV1Preflight> {
  const schema = validateEventSchemaName(options.schema ?? "public");
  const sourceSchema = validateEventSchemaName(options.sourceSchema ?? schema);
  const profile = await detectLegacyGraphV1(executor, schema);
  if (profile.kind !== "legacy-graph-v1") throw refusal(profile);
  const limit = pageSize(options.pageSize);
  await rejectBusyLegacyGraph(executor, schema);
  const counts = { threads: 0, events: 0, nodes: 0, edges: 0, assetRefs: 0 };
  const references = new Set<string>();
  const assetNodes = new Map<string, LegacyAssetReference>();
  // The archive lives in another schema after the cut, so the physical schema
  // name deliberately does not participate in the immutable source digest.
  let digest = await sha256({ profile: "legacy-graph-v1" });
  for (const table of ["threads", "events", "nodes", "edges"] as const) {
    for (let offset = 0;; offset += limit) {
      const result = await executor.query<Record<string, unknown>>(
        `SELECT * FROM ${q(schema, table)} ORDER BY id LIMIT $1 OFFSET $2`,
        [limit, offset],
      );
      for (const row of result.rows) {
        counts[table] += 1;
        digest = await sha256({ digest, table, row: normalize(row) });
        const found: string[] = [];
        assetRefs(row, found);
        counts.assetRefs += found.length;
        for (const ref of found) references.add(ref);
        if (table !== "nodes" || row.type !== "asset") continue;
        const data = asRecord(row.data);
        const ref = data.ref;
        if (typeof ref !== "string" || !ref.startsWith("asset://")) continue;
        const asset = Object.freeze({
          sourceSchema,
          id: String(row.id),
          namespace: String(row.namespace),
          type: String(row.type),
          name: String(row.name),
          ref,
          data: Object.freeze(data),
          sourceType: typeof row.source_type === "string"
            ? row.source_type
            : null,
          sourceId: typeof row.source_id === "string" ? row.source_id : null,
        });
        if (assetNodes.has(ref)) {
          throw new Error(
            `v4 migration refuses duplicate legacy asset ref '${ref}'.`,
          );
        }
        assetNodes.set(ref, asset);
      }
      if (result.rows.length < limit) break;
    }
  }
  for (const ref of [...references].sort()) {
    const asset = assetNodes.get(ref);
    if (!asset) {
      throw new Error(`v4 migration refuses orphan legacy asset ref '${ref}'.`);
    }
    const resolved = await options.resolveLegacyAsset(asset);
    if (!(resolved?.bytes instanceof Uint8Array)) {
      throw new Error(
        `v4 migration resolver did not return bytes for '${ref}'.`,
      );
    }
    digest = await sha256({
      digest,
      asset: {
        ref,
        byteLength: resolved.bytes.byteLength,
        digest: await sha256Bytes(resolved.bytes),
        ...(typeof resolved.mediaType === "string"
          ? { mediaType: resolved.mediaType }
          : {}),
      },
    });
  }
  return Object.freeze({
    schema,
    profile: "legacy-graph-v1",
    counts: Object.freeze(counts),
    digest,
  });
}

async function stateRow(
  executor: SqlExecutor,
  schema: string,
): Promise<StateRow | null> {
  const exists = await executor.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_name = $2 AND table_type = 'BASE TABLE'`,
    [schema, STATE_TABLE],
  );
  if (!exists.rows[0]) return null;
  const state = await executor.query<StateRow>(
    `SELECT source_profile, archive_schema, baseline_digest, config_fingerprint, counts, stage
       FROM ${q(schema, STATE_TABLE)} WHERE singleton = TRUE LIMIT 1`,
  );
  return state.rows[0] ?? null;
}

async function archiveExists(
  executor: SqlExecutor,
  schema: string,
): Promise<boolean> {
  const result = await executor.query<{ schema_name: string }>(
    "SELECT schema_name FROM information_schema.schemata WHERE schema_name = $1",
    [schema],
  );
  return Boolean(result.rows[0]);
}

async function verifyExistingCut(
  executor: SqlExecutor,
  schema: string,
  configFingerprint: string,
  options: MigrateToV4Options,
): Promise<V4ArchiveCutResult> {
  const state = await stateRow(executor, schema);
  if (!state) throw new Error("v4 archive state disappeared during migration.");
  if (
    !([
      "archive-cut",
      "assets",
      "participants",
      "threads",
      "messages",
      "custom",
      "relations",
      "sources",
      "complete",
    ].includes(state.stage) || state.stage.startsWith("custom:")) ||
    state.source_profile !== "legacy-graph-v1"
  ) {
    throw new Error(
      "v4 migration found an unsupported or incomplete archive state.",
    );
  }
  if (state.config_fingerprint !== configFingerprint) {
    throw new Error(
      "v4 archive cut configuration does not match the existing immutable state.",
    );
  }
  const archive = validateEventSchemaName(state.archive_schema);
  if (!await archiveExists(executor, archive)) {
    throw new Error("v4 archive state references a missing archive schema.");
  }
  const baseline = await preflightLegacyGraphV1(executor, {
    schema: archive,
    sourceSchema: schema,
    resolveLegacyAsset: options.resolveLegacyAsset,
    pageSize: options.pageSize,
  });
  if (baseline.digest !== state.baseline_digest) {
    throw new Error(
      "v4 archive baseline digest no longer matches immutable archive data.",
    );
  }
  return Object.freeze({
    schema,
    archiveSchema: archive,
    sourceProfile: "legacy-graph-v1",
    baselineDigest: state.baseline_digest,
    configFingerprint,
    counts: numberCounts(state.counts),
    stage: "archive-cut",
    alreadyCut: true,
  });
}

function stateStatements(schema: string): readonly string[] {
  return [
    `CREATE TABLE ${q(schema, STATE_TABLE)} (
      singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
      source_profile TEXT NOT NULL,
      archive_schema TEXT NOT NULL,
      baseline_digest TEXT NOT NULL,
      config_fingerprint TEXT NOT NULL,
      counts JSONB NOT NULL,
      stage TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`,
  ];
}

/**
 * Performs only the atomic archive-state cut. It never writes a v4 ready
 * marker, so normal runtime provisioning continues to reject this checkpoint.
 */
async function ensureArchiveCut(
  options: MigrateToV4Options,
): Promise<V4ArchiveCutResult> {
  const schema = validateEventSchemaName(options.schema ?? "public");
  const limit = pageSize(options.pageSize);
  const configFingerprint = await fingerprintConfig(options.config ?? {});
  const existing = await stateRow(options.session, schema);
  if (existing) {
    return await verifyExistingCut(
      options.session,
      schema,
      configFingerprint,
      options,
    );
  }

  const profile = await detectLegacyGraphV1(options.session, schema);
  if (profile.kind !== "legacy-graph-v1") throw refusal(profile);
  const baseline = await preflightLegacyGraphV1(options.session, {
    schema,
    resolveLegacyAsset: options.resolveLegacyAsset,
    pageSize: limit,
  });
  const archiveSchema = await legacyGraphV1ArchiveSchemaName(schema);

  return await options.session.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [schema, "copilotz-v4-legacy-archive-cut"],
    );
    if (await stateRow(transaction, schema)) {
      return await verifyExistingCut(
        transaction,
        schema,
        configFingerprint,
        options,
      );
    }
    // This blocks writers before the digest recheck; the advisory lock only
    // coordinates migrators, while these relation locks freeze source rows.
    for (const table of ["threads", "events", "nodes", "edges"] as const) {
      await transaction.query(
        `LOCK TABLE ${q(schema, table)} IN SHARE ROW EXCLUSIVE MODE`,
      );
    }
    const rechecked = await preflightLegacyGraphV1(transaction, {
      schema,
      resolveLegacyAsset: options.resolveLegacyAsset,
      pageSize: limit,
    });
    if (rechecked.digest !== baseline.digest) {
      throw new Error(
        "v4 migration source changed between preflight and archive cut.",
      );
    }
    if (await archiveExists(transaction, archiveSchema)) {
      throw new Error(
        `v4 migration refuses pre-existing archive schema '${archiveSchema}'.`,
      );
    }
    await transaction.query(
      `CREATE SCHEMA ${quoteEventIdentifier(archiveSchema)}`,
    );
    for (const table of ["threads", "events", "nodes", "edges"] as const) {
      await transaction.query(
        `ALTER TABLE ${q(schema, table)} SET SCHEMA ${
          quoteEventIdentifier(archiveSchema)
        }`,
      );
    }
    for (
      const statement of createCoreSchemaStatements(schema, { marker: false })
    ) {
      await transaction.query(statement);
    }
    for (const statement of stateStatements(schema)) {
      await transaction.query(statement);
    }
    await transaction.query(
      `INSERT INTO ${q(schema, STATE_TABLE)}
        (singleton, source_profile, archive_schema, baseline_digest, config_fingerprint, counts, stage)
       VALUES (TRUE, 'legacy-graph-v1', $1, $2, $3, $4::jsonb, 'archive-cut')`,
      [
        archiveSchema,
        rechecked.digest,
        configFingerprint,
        JSON.stringify(rechecked.counts),
      ],
    );
    return Object.freeze({
      schema,
      archiveSchema,
      sourceProfile: "legacy-graph-v1" as const,
      baselineDigest: rechecked.digest,
      configFingerprint,
      counts: rechecked.counts,
      stage: "archive-cut" as const,
      alreadyCut: false,
    });
  });
}

function iso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Legacy record has an invalid timestamp.");
  }
  return date.toISOString();
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function strings(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => text(item) ? [text(item)!] : []);
  }
  if (typeof value !== "string") return [];
  try {
    return strings(JSON.parse(value));
  } catch {
    return value.trim() ? [value.trim()] : [];
  }
}

function sourceId(
  schema: string,
  namespace: string,
  kind: string,
  id: string,
): string {
  return `migration:v4:${
    [schema, namespace, kind, id].map((part) => encodeURIComponent(part)).join(
      ":",
    )
  }`;
}

function sourceBodyId(id: string): string {
  return `event-body:${id}`;
}

function pluginSnapshot(
  plugins: readonly AnyCopilotzPlugin[],
  definitions: readonly CollectionDefinition[],
): unknown {
  const snapshot = (definition: CollectionDefinition) => ({
    name: definition.name,
    schema: definition.schema,
    defaults: definition.defaults ?? {},
    timestamps: definition.timestamps ?? {},
    indexes: definition.indexes ?? [],
    relations: definition.relations ?? {},
    content: definition.content ?? {},
    identity: definition.identity ?? {},
    search: definition.search ?? {},
  });
  return {
    plugins: plugins.map((plugin) => ({
      id: plugin.id,
      version: plugin.version,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    collections: definitions.map(snapshot).sort((a, b) =>
      a.name.localeCompare(b.name)
    ),
  };
}

async function ensureSourceState(
  session: SqlSession,
  schema: string,
  fingerprint: string,
): Promise<StateRow> {
  return await session.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [schema, "copilotz-v4-sources"],
    );
    await transaction.query(
      `ALTER TABLE ${
        q(schema, STATE_TABLE)
      } ADD COLUMN IF NOT EXISTS plugin_fingerprint TEXT`,
    );
    await transaction.query(
      `ALTER TABLE ${
        q(schema, STATE_TABLE)
      } ADD COLUMN IF NOT EXISTS source_cursor JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
    await transaction.query(
      `ALTER TABLE ${
        q(schema, STATE_TABLE)
      } ADD COLUMN IF NOT EXISTS source_counts JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
    const result = await transaction.query<StateRow>(
      `SELECT source_profile, archive_schema, baseline_digest, config_fingerprint, counts, stage,
              plugin_fingerprint, source_cursor
         FROM ${q(schema, STATE_TABLE)} WHERE singleton = TRUE FOR UPDATE`,
    );
    const state = result.rows[0];
    if (!state) throw new Error("v4 migration state is missing.");
    if (state.plugin_fingerprint && state.plugin_fingerprint !== fingerprint) {
      throw new Error(
        "v4 migration final plugin graph does not match immutable source state.",
      );
    }
    if (!state.plugin_fingerprint) {
      await transaction.query(
        `UPDATE ${
          q(schema, STATE_TABLE)
        } SET plugin_fingerprint = $1 WHERE singleton = TRUE`,
        [fingerprint],
      );
      return { ...state, plugin_fingerprint: fingerprint };
    }
    return state;
  });
}

async function sourceState(
  executor: SqlExecutor,
  schema: string,
): Promise<StateRow | null> {
  const result = await executor.query<StateRow>(
    `SELECT source_profile, archive_schema, baseline_digest, config_fingerprint, counts, stage,
            plugin_fingerprint, source_cursor
       FROM ${q(schema, STATE_TABLE)} WHERE singleton = TRUE LIMIT 1`,
  );
  return result.rows[0] ?? null;
}

async function archiveNodeTypes(
  executor: SqlExecutor,
  archive: string,
): Promise<string[]> {
  const result = await executor.query<{ type: string }>(
    `SELECT DISTINCT type FROM ${q(archive, "nodes")} ORDER BY type`,
  );
  return result.rows.map((row) => row.type);
}

function requiredDefinitions(
  definitions: ReadonlyMap<string, CollectionDefinition>,
  types: readonly string[],
): void {
  for (const type of types) {
    if (type === "asset" || RETIRED_NODE_TYPES.has(type)) continue;
    if (!definitions.has(type)) {
      throw new Error(
        `v4 migration requires a final CollectionDefinition for retained legacy type '${type}'.`,
      );
    }
  }
}

function cursorFor(state: StateRow, stage: string): string {
  const cursor = asRecord(state.source_cursor);
  return cursor.stage === stage && typeof cursor.lastId === "string"
    ? cursor.lastId
    : "";
}

async function completeSourceStage(
  session: SqlSession,
  schema: string,
  stage: string,
  next: string,
): Promise<void> {
  await session.transaction(async (transaction) => {
    const updated = await transaction.query<{ stage: string }>(
      `UPDATE ${
        q(schema, STATE_TABLE)
      } SET stage = $1, source_cursor = $2::jsonb
        WHERE singleton = TRUE AND stage = $3 RETURNING stage`,
      [next, JSON.stringify({ stage: next, lastId: "" }), stage],
    );
    if (!updated.rows[0]) {
      throw new Error(
        `v4 migration could not advance source stage '${stage}'.`,
      );
    }
  });
}

async function commitSourceEvent(
  input: Readonly<{
    store: ReturnType<typeof createEventStore>;
    schema: string;
    stage: string;
    lastId: string;
    namespace: string;
    source: string;
    type: string;
    subject: Readonly<{ type: string; id: string }>;
    body: unknown;
    createdAt: string;
    threadId?: string;
    /** Auxiliary facts may be durable before their owning row without moving its cursor. */
    advanceCursor?: boolean;
  }>,
): Promise<void> {
  const bodyId = sourceBodyId(input.source);
  const deterministicStore = createEventStore({
    session: input.store.session,
    schema: input.schema,
    createId: () => input.source,
  });
  await deterministicStore.session.transaction(async (transaction) => {
    await deterministicStore.commitMutation({
      transaction,
      consumers: [],
      draft: {
        type: input.type,
        namespace: input.namespace,
        ...(input.threadId ? { threadId: input.threadId } : {}),
        subject: input.subject,
        payload: {
          dataRef: {
            eventBodyId: bodyId,
            schemaVersion: 1,
            mediaType: "application/json",
          },
        },
        metadata: { migration: { source: input.source } },
        correlationId: input.source,
        deduplicationId: input.source,
        createdAt: input.createdAt,
      },
      mutate: async (context) => {
        await writeEventBody(context, {
          namespace: input.namespace,
          id: bodyId,
          json: input.body,
        });
        await context.transaction.query(
          `UPDATE ${q(input.schema, STATE_TABLE)}
              SET source_cursor = CASE WHEN $3 THEN $1::jsonb ELSE source_cursor END,
                  source_counts = jsonb_set(COALESCE(source_counts, '{}'::jsonb), ARRAY[$2],
                    to_jsonb(COALESCE((source_counts ->> $2)::integer, 0) + 1))
            WHERE singleton = TRUE`,
          [
            JSON.stringify({ stage: input.stage, lastId: input.lastId }),
            input.stage,
            input.advanceCursor !== false,
          ],
        );
      },
      recoverDuplicate: async (event, context) => {
        const existing = await readEventBody<unknown>(
          context,
          event.namespace,
          eventDataRef(event.payload),
        );
        if (canonical(existing) !== canonical(input.body)) {
          throw new Error(
            `v4 migration source '${input.source}' conflicts with existing EventBody.`,
          );
        }
      },
    });
  });
}

function collectionSourceBody(
  record: Record<string, unknown>,
): CollectionEventBody<Record<string, unknown>> {
  return Object.freeze({
    operation: "create",
    intent: { operation: "create" as const, input: record },
    record,
    assets: [],
  });
}

async function putAssetBody(
  store: ReturnType<typeof createDatabaseBodyStore>,
  bodyId: string,
  bytes: Uint8Array,
  mediaType: string,
): Promise<{ digest: `sha256:${string}`; byteLength: number }> {
  const digest = await digestContent(bytes);
  await store.put({ bodyId, bytes, mediaType, digest });
  return { digest, byteLength: bytes.byteLength };
}

async function sourceAsset(
  input: Readonly<{
    store: ReturnType<typeof createEventStore>;
    bodyStore: ReturnType<typeof createDatabaseBodyStore>;
    schema: string;
    stage: string;
    lastId: string;
    namespace: string;
    assetId: string;
    bytes: Uint8Array;
    mediaType: string;
    createdAt: string;
    oldNodeId: string;
    owner?: string;
    advanceCursor?: boolean;
  }>,
): Promise<ContentRef> {
  const bodyId = assetBodyKey({
    databaseSchema: input.schema,
    namespace: input.namespace,
    assetId: input.assetId,
    origin: { type: "migration", id: input.owner ?? input.oldNodeId },
  });
  const body = await putAssetBody(
    input.bodyStore,
    bodyId,
    input.bytes,
    input.mediaType,
  );
  const asset: AssetRecord = {
    id: input.assetId,
    namespace: input.namespace,
    mediaType: input.mediaType,
    byteLength: body.byteLength,
    digest: body.digest,
    state: "ready",
    location: { kind: "database", key: bodyId },
    origin: { type: "migration", id: input.owner ?? input.oldNodeId },
    createdAt: input.createdAt,
    readyAt: input.createdAt,
    metadata: { migration: { legacyNodeId: input.oldNodeId } },
  };
  const source = sourceId(
    input.schema,
    input.namespace,
    "asset",
    input.assetId,
  );
  const eventBody: AssetEventBody = {
    operation: "create",
    asset,
    bodyId,
    idempotencyKey: source,
  };
  await commitSourceEvent({
    store: input.store,
    schema: input.schema,
    stage: input.stage,
    lastId: input.lastId,
    namespace: input.namespace,
    source,
    type: "asset.created",
    subject: { type: "asset", id: input.assetId },
    body: eventBody,
    createdAt: input.createdAt,
    advanceCursor: input.advanceCursor,
  });
  return Object.freeze({
    assetId: input.assetId,
    kind: input.mediaType.startsWith("text/") ? "text" : "file",
    role: "body",
    mediaType: input.mediaType,
  });
}

type LegacyNode = Record<string, unknown> & {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: unknown;
  source_type: string | null;
  source_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

async function stageNodes(
  input: Readonly<{
    session: SqlSession;
    archive: string;
    schema: string;
    stage: string;
    type: string;
    pageSize: number;
    work(row: LegacyNode, lastId: string): Promise<void>;
  }>,
): Promise<void> {
  const state = await stateRow(input.session, input.schema);
  if (!state) throw new Error("v4 source state is missing.");
  let after = cursorFor(state, input.stage);
  while (true) {
    const page = await input.session.query<LegacyNode>(
      `SELECT id, namespace, type, name, content, data, source_type, source_id, created_at, updated_at
         FROM ${q(input.archive, "nodes")}
        WHERE type = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [input.type, after, input.pageSize],
    );
    if (!page.rows.length) return;
    for (const row of page.rows) {
      await input.work(row, row.id);
      after = row.id;
    }
  }
}

function participantRecord(row: LegacyNode): Record<string, unknown> {
  const data = asRecord(row.data);
  const participantType = text(data.participantType) ?? text(data.type) ??
    text(row.source_type) ?? "human";
  if (!["human", "agent", "tool", "job"].includes(participantType)) {
    throw new Error(`Legacy participant '${row.id}' has invalid type.`);
  }
  return {
    id: row.id,
    namespace: row.namespace,
    externalId: text(data.externalId) ?? row.id,
    participantType,
    ...(text(data.name) ?? text(row.name)
      ? { name: text(data.name) ?? text(row.name) }
      : {}),
    ...(text(data.email) ? { email: text(data.email) } : {}),
    ...(text(data.agentId) ? { agentId: text(data.agentId) } : {}),
    metadata: asRecord(data.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

async function participantAliases(
  executor: SqlExecutor,
  archive: string,
): Promise<Map<string, string>> {
  const rows = await executor.query<LegacyNode>(
    `SELECT id, namespace, type, name, content, data, source_type, source_id, created_at, updated_at
       FROM ${q(archive, "nodes")} WHERE type = 'participant' ORDER BY id`,
  );
  const aliases = new Map<string, string>();
  const register = (key: string, id: string): void => {
    const previous = aliases.get(key);
    if (previous && previous !== id) {
      throw new Error(
        `Legacy participant alias '${
          key.slice(key.indexOf("\u0000") + 1)
        }' is ambiguous within namespace '${
          key.slice(0, key.indexOf("\u0000"))
        }'.`,
      );
    }
    aliases.set(key, id);
  };
  for (const row of rows.rows) {
    const record = participantRecord(row);
    register(`${row.namespace}\u0000${row.id}`, row.id);
    register(`${row.namespace}\u0000${String(record.externalId)}`, row.id);
  }
  return aliases;
}

function resolveAlias(
  aliases: ReadonlyMap<string, string>,
  namespace: string,
  value: unknown,
  label: string,
): string {
  const candidate = text(value);
  const resolved = candidate
    ? aliases.get(`${namespace}\u0000${candidate}`)
    : undefined;
  if (!resolved) {
    throw new Error(
      `Legacy ${label} '${candidate ?? ""}' has no retained participant.`,
    );
  }
  return resolved;
}

type SyntheticToolParticipant = Readonly<{
  id: string;
  namespace: string;
  externalId: string;
  threadIds: readonly string[];
  createdAt: string;
  updatedAt: string;
}>;

function toolAlias(data: Record<string, unknown>): string | undefined {
  const metadata = asRecord(data.metadata);
  const calls = Array.isArray(metadata.toolCalls) ? metadata.toolCalls : [];
  const callTool = asRecord(asRecord(calls[0]).tool);
  return text(asRecord(data.tool).id) ?? text(callTool.id) ?? text(data.toolId);
}

async function synthesizeToolParticipants(
  executor: SqlExecutor,
  archive: string,
  aliases: Map<string, string>,
): Promise<readonly SyntheticToolParticipant[]> {
  const rows = await executor.query<LegacyNode>(
    `SELECT id, namespace, type, name, content, data, source_type, source_id, created_at, updated_at
       FROM ${
      q(archive, "nodes")
    } WHERE type IN ('message', 'tool_execution') ORDER BY id`,
  );
  const synthetic = new Map<string, SyntheticToolParticipant>();
  for (const row of rows.rows) {
    const data = asRecord(row.data);
    if (
      row.type !== "tool_execution" && text(data.senderType) !== "tool" &&
      data.toolInvocation === undefined
    ) continue;
    const alias = toolAlias(data);
    const threadId = text(data.threadId) ??
      (row.source_type === "thread" ? text(row.source_id) : undefined);
    if (!alias || !threadId) {
      throw new Error(
        `Legacy tool message '${row.id}' has ambiguous tool identity.`,
      );
    }
    const key = `${row.namespace}\u0000${alias}`;
    const previous = synthetic.get(key);
    // An existing participant wins; a previously synthesized participant must
    // keep accumulating every thread in which its durable tool alias appears.
    if (aliases.has(key) && !previous) continue;
    const id = `migration-tool:${encodeURIComponent(row.namespace)}:${
      encodeURIComponent(alias)
    }`;
    const candidate = {
      id,
      namespace: row.namespace,
      externalId: alias,
      threadIds: [threadId],
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
    if (previous && previous.id !== candidate.id) {
      throw new Error(`Legacy tool alias '${alias}' is ambiguous.`);
    }
    synthetic.set(
      key,
      previous
        ? {
          ...previous,
          threadIds: [...new Set([...previous.threadIds, threadId])],
        }
        : candidate,
    );
    aliases.set(key, id);
    aliases.set(`${row.namespace}\u0000${id}`, id);
  }
  return Object.freeze(
    [...synthetic.values()].sort((a, b) => a.id.localeCompare(b.id)),
  );
}

async function toolMemberships(
  executor: SqlExecutor,
  archive: string,
  aliases: ReadonlyMap<string, string>,
): Promise<ReadonlyMap<string, readonly string[]>> {
  const rows = await executor.query<LegacyNode>(
    `SELECT id, namespace, type, name, content, data, source_type, source_id, created_at, updated_at
       FROM ${
      q(archive, "nodes")
    } WHERE type IN ('message', 'tool_execution') ORDER BY id`,
  );
  const memberships = new Map<string, Set<string>>();
  for (const row of rows.rows) {
    const data = asRecord(row.data);
    if (
      row.type !== "tool_execution" && text(data.senderType) !== "tool" &&
      data.toolInvocation === undefined
    ) continue;
    const alias = toolAlias(data);
    const threadId = text(data.threadId) ??
      (row.source_type === "thread" ? text(row.source_id) : undefined);
    const id = alias
      ? aliases.get(`${row.namespace}\u0000${alias}`)
      : undefined;
    if (!id || !threadId) {
      throw new Error(
        `Legacy tool message '${row.id}' has unresolved tool membership.`,
      );
    }
    const key = `${row.namespace}\u0000${threadId}`;
    const ids = memberships.get(key) ?? new Set<string>();
    ids.add(id);
    memberships.set(key, ids);
  }
  return new Map([...memberships].map(([key, ids]) => [key, [...ids]]));
}

function legacyAssetFinalId(ref: string, namespace: string): string {
  if (!ref.startsWith("asset://")) {
    throw new Error(`Legacy Asset ref '${ref}' is not an asset:// ref.`);
  }
  const raw = ref.slice("asset://".length);
  if (!raw) throw new Error(`Legacy Asset ref '${ref}' is empty.`);
  const parts = raw.split("/");
  if (parts.length === 1) return raw;
  const [encodedNamespace, ...idParts] = parts;
  const assetId = idParts.join("/");
  if (!encodedNamespace || !assetId) {
    throw new Error(`Legacy Asset ref '${ref}' has an ambiguous path.`);
  }
  let decodedNamespace = encodedNamespace;
  try {
    decodedNamespace = decodeURIComponent(encodedNamespace);
  } catch {
    // Released parsing retained malformed percent escapes literally.
  }
  if (decodedNamespace !== namespace) {
    throw new Error(`Legacy Asset ref '${ref}' crosses namespaces.`);
  }
  return assetId;
}

async function legacyAssetIds(
  executor: SqlExecutor,
  archive: string,
): Promise<Map<string, string>> {
  const rows = await executor.query<LegacyNode>(
    `SELECT id, namespace, type, name, content, data, source_type, source_id, created_at, updated_at
       FROM ${q(archive, "nodes")} WHERE type = 'asset' ORDER BY id`,
  );
  const ids = new Map<string, string>();
  const finalOwners = new Map<string, string>();
  for (const row of rows.rows) {
    const ref = text(asRecord(row.data).ref);
    if (!ref) throw new Error(`Legacy Asset '${row.id}' has ambiguous ref.`);
    const finalId = legacyAssetFinalId(ref, row.namespace);
    const ownerKey = `${row.namespace}\u0000${finalId}`;
    const previous = finalOwners.get(ownerKey);
    if (previous && previous !== row.id) {
      throw new Error(
        `Legacy Asset refs '${previous}' and '${row.id}' collapse to final id '${finalId}'.`,
      );
    }
    finalOwners.set(ownerKey, row.id);
    ids.set(`${row.namespace}\u0000${row.id}`, finalId);
    ids.set(`${row.namespace}\u0000${ref}`, finalId);
    ids.set(`${row.namespace}\u0000${finalId}`, finalId);
  }
  return ids;
}

async function importedAssetMedia(
  executor: SqlExecutor,
  store: ReturnType<typeof createEventStore>,
): Promise<ReadonlyMap<string, string>> {
  const events = await executor.query<{ namespace: string; payload: unknown }>(
    `SELECT namespace, payload FROM ${store.tables.events} WHERE type = 'asset.created' AND metadata -> 'migration' IS NOT NULL`,
  );
  const media = new Map<string, string>();
  for (const event of events.rows) {
    const body = await readEventBody<AssetEventBody>(
      { transaction: executor, tables: store.tables },
      event.namespace,
      eventDataRef(event.payload),
    );
    if (body.operation === "create") {
      media.set(
        `${event.namespace}\u0000${body.asset.id}`,
        body.asset.mediaType,
      );
    }
  }
  return media;
}

function translatedAssetId(
  assetIds: ReadonlyMap<string, string>,
  namespace: string,
  value: unknown,
): string {
  const ref = text(value);
  if (!ref) throw new Error("Legacy content Asset ref is missing.");
  const normalized = ref.startsWith("asset://")
    ? legacyAssetFinalId(ref, namespace)
    : ref;
  const finalId = assetIds.get(`${namespace}\u0000${ref}`) ??
    assetIds.get(`${namespace}\u0000${normalized}`);
  if (!finalId) {
    throw new Error(
      `Legacy content Asset ref '${ref ?? ""}' is missing or ambiguous.`,
    );
  }
  return finalId;
}

async function messageLegacyContent(
  executor: SqlExecutor,
  archive: string,
  row: LegacyNode,
  data: Record<string, unknown>,
  assetIds: ReadonlyMap<string, string>,
  assetMedia: ReadonlyMap<string, string>,
): Promise<Readonly<{ bodyText: string; attachments: ContentRef[] }>> {
  let bodyText = row.content ?? "";
  const attachmentsOutput: ContentRef[] = [];
  if (typeof data.content === "string") {
    if (row.content !== null && data.content !== row.content) {
      throw new Error(
        `Legacy message '${row.id}' has conflicting data.content and nodes.content.`,
      );
    }
    bodyText = data.content;
  } else if (data.content !== undefined && data.content !== null) {
    // 0.47/0.48 stores text here (or null); ContentRef arrays are not a
    // released legacy shape and accepting them would invent semantics.
    throw new Error(
      `Legacy message '${row.id}' has non-released data.content.`,
    );
  }
  const attachments = asRecord(data.metadata).attachments;
  if (attachments !== undefined && !Array.isArray(attachments)) {
    throw new Error(
      `Legacy message '${row.id}' has malformed metadata.attachments.`,
    );
  }
  for (const value of attachments ?? []) {
    const attachment = asRecord(value);
    const raw = attachment.assetRef ?? attachment.assetId;
    const assetId = translatedAssetId(assetIds, row.namespace, raw);
    const name = text(attachment.fileName) ?? text(attachment.name);
    if (
      !attachmentsOutput.some((ref) =>
        ref.role === "attachment" && ref.assetId === assetId &&
        (ref.name ?? undefined) === name
      )
    ) {
      const kind = text(attachment.kind);
      if (kind && !["image", "audio", "video", "file"].includes(kind)) {
        throw new Error(`Legacy attachment on '${row.id}' has invalid kind.`);
      }
      const mediaType = assetMedia.get(`${row.namespace}\u0000${assetId}`);
      if (!mediaType) {
        throw new Error(
          `Legacy attachment on '${row.id}' references an unimported Asset.`,
        );
      }
      if (
        text(attachment.mimeType) && text(attachment.mimeType) !== mediaType
      ) {
        throw new Error(
          `Legacy attachment on '${row.id}' media type conflicts with imported Asset.`,
        );
      }
      attachmentsOutput.push({
        assetId,
        kind: (kind ?? "file") as ContentRef["kind"],
        role: "attachment",
        mediaType,
        ...(name ? { name } : {}),
        metadata: {
          migration: {
            ref: text(raw) ?? null,
            format: text(attachment.format) ?? null,
          },
        },
      });
    }
  }
  const edges = await executor.query<{ target_node_id: string }>(
    `SELECT edge.target_node_id FROM ${q(archive, "edges")} edge
      JOIN ${
      q(archive, "nodes")
    } asset ON asset.id = edge.target_node_id AND asset.type = 'asset'
      WHERE edge.source_node_id = $1 AND edge.type = 'has_asset' ORDER BY edge.id`,
    [row.id],
  );
  for (const edge of edges.rows) {
    const assetId = translatedAssetId(
      assetIds,
      row.namespace,
      edge.target_node_id,
    );
    if (
      !attachmentsOutput.some((ref) =>
        ref.role === "attachment" && ref.assetId === assetId
      )
    ) {
      const mediaType = assetMedia.get(`${row.namespace}\u0000${assetId}`);
      if (!mediaType) {
        throw new Error(
          `Legacy has_asset on '${row.id}' references an unimported Asset.`,
        );
      }
      attachmentsOutput.push({
        assetId,
        kind: "file",
        role: "attachment",
        mediaType,
        metadata: { migration: { relation: "has_asset" } },
      });
    }
  }
  return { bodyText, attachments: attachmentsOutput };
}

function toolCalls(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.map((candidate) => {
    const call = asRecord(candidate);
    const tool = asRecord(call.tool);
    const id = text(call.id) ?? text(call.toolCallId);
    const action = text(tool.id) ?? text(call.toolId) ?? text(call.action) ??
      text(call.name);
    if (!id || !action) {
      throw new Error("Legacy assistant tool call is missing id or tool id.");
    }
    return {
      id,
      action,
      input: call.args ?? call.input ?? call.arguments ?? {},
    };
  });
}

async function threadPhysical(
  executor: SqlExecutor,
  archive: string,
  id: string,
): Promise<Record<string, unknown>> {
  const result = await executor.query<Record<string, unknown>>(
    `SELECT * FROM ${q(archive, "threads")} WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? {};
}

async function migrateSources(
  options: MigrateToV4Options,
  archiveCut: V4ArchiveCutResult,
  definitions: ReadonlyMap<string, CollectionDefinition>,
  pluginFingerprint: string,
): Promise<V4SourceResult> {
  const schema = archiveCut.schema;
  const archive = archiveCut.archiveSchema;
  let state = await ensureSourceState(
    options.session,
    schema,
    pluginFingerprint,
  );
  const store = createEventStore({ session: options.session, schema });
  const bodyStore = createDatabaseBodyStore({
    session: options.session,
    schema,
  });
  const aliases = await participantAliases(options.session, archive);
  const syntheticTools = await synthesizeToolParticipants(
    options.session,
    archive,
    aliases,
  );
  const toolMembers = await toolMemberships(options.session, archive, aliases);
  const assetIds = await legacyAssetIds(options.session, archive);
  const sourceRecord = async (
    stage: string,
    row: LegacyNode,
    type: string,
    record: Record<string, unknown>,
    lastId: string,
    threadId?: string,
  ) => {
    const definition = definitions.get(type);
    if (!definition) {
      throw new Error(
        `v4 migration requires a final CollectionDefinition for '${type}'.`,
      );
    }
    if (!definition.schema || typeof definition.schema !== "object") {
      throw new TypeError(
        `Collection '${type}' has no object schema for migration validation.`,
      );
    }
    validateCollectionRecord(
      definition.schema,
      record,
      `Migrated ${type} '${row.id}'`,
    );
    const source = sourceId(schema, row.namespace, type, row.id);
    await commitSourceEvent({
      store,
      schema,
      stage,
      lastId,
      namespace: row.namespace,
      source,
      type: `${type}.created`,
      subject: { type, id: row.id },
      body: collectionSourceBody(record),
      createdAt: iso(row.created_at),
      ...(threadId ? { threadId } : {}),
    });
  };

  if (state.stage === "archive-cut") {
    await completeSourceStage(
      options.session,
      schema,
      "archive-cut",
      "assets",
    );
    state = (await stateRow(options.session, schema))!;
  }
  if (state.stage === "assets") {
    await stageNodes({
      session: options.session,
      archive,
      schema,
      stage: "assets",
      type: "asset",
      pageSize: pageSize(options.pageSize),
      work: async (row, lastId) => {
        const data = asRecord(row.data);
        const ref = text(data.ref);
        if (!ref?.startsWith("asset://")) {
          throw new Error(`Legacy Asset '${row.id}' has no asset:// ref.`);
        }
        const assetId = legacyAssetFinalId(ref, row.namespace);
        const resolved = await options.resolveLegacyAsset({
          sourceSchema: schema,
          id: row.id,
          namespace: row.namespace,
          type: row.type,
          name: row.name,
          ref,
          data,
          sourceType: row.source_type,
          sourceId: row.source_id,
        });
        const mediaType = text(resolved.mediaType) ?? text(data.mediaType) ??
          text(data.mimeType) ?? text(data.mime) ?? "application/octet-stream";
        await sourceAsset({
          store,
          bodyStore,
          schema,
          stage: "assets",
          lastId,
          namespace: row.namespace,
          assetId,
          bytes: resolved.bytes,
          mediaType,
          createdAt: iso(row.created_at),
          oldNodeId: row.id,
        });
      },
    });
    await completeSourceStage(
      options.session,
      schema,
      "assets",
      "participants",
    );
    state = (await stateRow(options.session, schema))!;
  }
  if (state.stage === "participants") {
    await stageNodes({
      session: options.session,
      archive,
      schema,
      stage: "participants",
      type: "participant",
      pageSize: pageSize(options.pageSize),
      work: (row, lastId) =>
        sourceRecord(
          "participants",
          row,
          "participant",
          participantRecord(row),
          lastId,
        ),
    });
    for (const tool of syntheticTools) {
      const row: LegacyNode = {
        id: tool.id,
        namespace: tool.namespace,
        type: "participant",
        name: tool.externalId,
        content: null,
        data: {},
        source_type: null,
        source_id: null,
        created_at: tool.createdAt,
        updated_at: tool.updatedAt,
      };
      await sourceRecord("participants", row, "participant", {
        id: tool.id,
        namespace: tool.namespace,
        externalId: tool.externalId,
        participantType: "tool",
        name: tool.externalId,
        metadata: { migration: { synthesizedToolParticipant: true } },
        createdAt: tool.createdAt,
        updatedAt: tool.updatedAt,
      }, row.id);
    }
    await completeSourceStage(
      options.session,
      schema,
      "participants",
      "threads",
    );
    state = (await stateRow(options.session, schema))!;
  }
  if (state.stage === "threads") {
    await stageNodes({
      session: options.session,
      archive,
      schema,
      stage: "threads",
      type: "thread",
      pageSize: pageSize(options.pageSize),
      work: async (row, lastId) => {
        const node = asRecord(row.data);
        const physical = await threadPhysical(options.session, archive, row.id);
        const participantIds = strings(
          physical.participants ?? node.participants,
        ).map((value) =>
          resolveAlias(aliases, row.namespace, value, "thread participant")
        );
        const record: Record<string, unknown> = {
          id: row.id,
          namespace: row.namespace,
          ...(text(physical.externalId ?? node.externalId)
            ? { externalId: text(physical.externalId ?? node.externalId) }
            : {}),
          ...(text(physical.name ?? node.name ?? row.name)
            ? { name: text(physical.name ?? node.name ?? row.name) }
            : {}),
          ...(text(physical.description ?? node.description)
            ? { description: text(physical.description ?? node.description) }
            : {}),
          status: text(physical.status ?? node.status) ?? "active",
          ...(text(physical.parentThreadId ?? node.parentThreadId)
            ? {
              parentThreadId: text(
                physical.parentThreadId ?? node.parentThreadId,
              ),
            }
            : {}),
          participantIds: [
            ...new Set([
              ...participantIds,
              ...(toolMembers.get(`${row.namespace}\u0000${row.id}`) ?? []),
            ]),
          ],
          metadata: asRecord(node.metadata),
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        };
        await sourceRecord("threads", row, "thread", record, lastId, row.id);
      },
    });
    await completeSourceStage(options.session, schema, "threads", "messages");
    state = (await stateRow(options.session, schema))!;
  }
  if (state.stage === "messages") {
    // Attachment ContentRefs use the canonical media type of the imported
    // final Asset, not a possibly absent or stale legacy attachment hint.
    const assetMedia = await importedAssetMedia(options.session, store);
    await stageNodes({
      session: options.session,
      archive,
      schema,
      stage: "messages",
      type: "message",
      pageSize: pageSize(options.pageSize),
      work: async (row, lastId) => {
        const data = asRecord(row.data);
        const threadId = text(data.threadId) ??
          (row.source_type === "thread" ? text(row.source_id) : undefined);
        if (!threadId) {
          throw new Error(`Legacy message '${row.id}' has no thread.`);
        }
        const isTool = text(data.senderType) === "tool" ||
          data.toolInvocation !== undefined;
        let senderId: string;
        const oldMetadata = asRecord(data.metadata);
        const metadata: Record<string, unknown> = {
          migration: {
            legacyMetadata: oldMetadata,
            senderType: text(data.senderType) ?? null,
            senderId: text(data.senderId) ?? null,
            toolCallId: text(data.toolCallId) ?? null,
          },
        };
        const calls = toolCalls(data.toolCalls);
        if (calls.length) metadata.llmToolCalls = calls;
        if (isTool) {
          const tool = asRecord(data.tool);
          const metadataCalls = Array.isArray(oldMetadata.toolCalls)
            ? oldMetadata.toolCalls
            : [];
          const metadataTool = asRecord(asRecord(metadataCalls[0]).tool);
          const toolAlias = text(tool.id) ?? text(metadataTool.id) ??
            text(data.toolId) ?? text(data.senderId);
          senderId = resolveAlias(
            aliases,
            row.namespace,
            toolAlias,
            "tool message sender",
          );
          const requester = text(data.requesterId) ?? text(data.senderId) ??
            text(data.agentId) ?? text(data.senderUserId);
          if (requester) {
            metadata.requesterId = resolveAlias(
              aliases,
              row.namespace,
              requester,
              "tool requester",
            );
          }
          const invocationId = text(asRecord(data.toolInvocation).id) ??
            text(data.toolCallId);
          if (invocationId) metadata.toolInvocation = { id: invocationId };
          const historyVisibility = text(data.historyVisibility) ??
            text(asRecord(metadataCalls[0]).historyVisibility) ??
            text(asRecord(metadataCalls[0]).visibility);
          if (historyVisibility) metadata.historyVisibility = historyVisibility;
        } else {
          senderId = resolveAlias(
            aliases,
            row.namespace,
            data.senderId ?? data.senderUserId,
            "message sender",
          );
        }
        const contentId = `migration-content:${row.id}`;
        const legacyContent = await messageLegacyContent(
          options.session,
          archive,
          row,
          data,
          assetIds,
          assetMedia,
        );
        const content = await sourceAsset({
          store,
          bodyStore,
          schema,
          stage: "messages",
          lastId,
          namespace: row.namespace,
          assetId: contentId,
          bytes: new TextEncoder().encode(legacyContent.bodyText),
          mediaType: "text/plain; charset=utf-8",
          createdAt: iso(row.created_at),
          oldNodeId: row.id,
          owner: row.id,
          advanceCursor: false,
        });
        const record = {
          id: row.id,
          namespace: row.namespace,
          threadId,
          senderId,
          recipientIds: strings(data.recipientIds ?? oldMetadata.recipientIds)
            .map((value) =>
              resolveAlias(aliases, row.namespace, value, "message recipient")
            ),
          content: [content, ...legacyContent.attachments],
          metadata,
          createdAt: iso(row.created_at),
          updatedAt: iso(row.updated_at),
        };
        await sourceRecord(
          "messages",
          row,
          "message",
          record,
          lastId,
          threadId,
        );
      },
    });
    await completeSourceStage(options.session, schema, "messages", "custom");
    state = (await stateRow(options.session, schema))!;
  }
  if (state.stage === "custom" || state.stage.startsWith("custom:")) {
    const types = (await archiveNodeTypes(options.session, archive)).filter((
      type,
    ) =>
      !["asset", "participant", "thread", "message"].includes(type) &&
      !RETIRED_NODE_TYPES.has(type)
    );
    for (const type of types) {
      await stageNodes({
        session: options.session,
        archive,
        schema,
        stage: `custom:${type}`,
        type,
        pageSize: pageSize(options.pageSize),
        work: async (row, lastId) => {
          const data = asRecord(row.data);
          const record = {
            ...data,
            id: row.id,
            namespace: row.namespace,
            createdAt: iso(row.created_at),
            updatedAt: iso(row.updated_at),
          };
          await sourceRecord(`custom:${type}`, row, type, record, lastId);
        },
      });
    }
    await completeSourceStage(options.session, schema, "custom", "relations");
    state = (await stateRow(options.session, schema))!;
  }
  if (state.stage === "sources") {
    const expected = await options.session.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM ${q(archive, "edges")} edge
        JOIN ${
        q(archive, "nodes")
      } source ON source.id = edge.source_node_id AND source.type = 'message'
        JOIN ${
        q(archive, "nodes")
      } target ON target.id = edge.target_node_id AND target.type = 'message'
        WHERE edge.type = 'derived_from'`,
    );
    const actual = await options.session.query<{ count: string | number }>(
      `SELECT count(*) AS count FROM ${store.tables.events}
        WHERE type = 'relation.upserted' AND metadata -> 'migration' IS NOT NULL`,
    );
    if (
      Number(actual.rows[0]?.count ?? 0) < Number(expected.rows[0]?.count ?? 0)
    ) {
      await completeSourceStage(
        options.session,
        schema,
        "sources",
        "relations",
      );
      state = (await stateRow(options.session, schema))!;
    }
  }
  if (state.stage === "relations") {
    let after = cursorFor(state, "relations");
    while (true) {
      const page = await options.session.query<Record<string, unknown>>(
        `SELECT edge.id, source.namespace, edge.source_node_id, edge.target_node_id, edge.type, edge.data, edge.weight, edge.created_at
           FROM ${q(archive, "edges")} edge
           JOIN ${
          q(archive, "nodes")
        } source ON source.id = edge.source_node_id AND source.type = 'message'
           JOIN ${
          q(archive, "nodes")
        } target ON target.id = edge.target_node_id AND target.type = 'message'
          WHERE edge.type = 'derived_from' AND edge.id > $1 ORDER BY edge.id LIMIT $2`,
        [after, pageSize(options.pageSize)],
      );
      if (!page.rows.length) break;
      for (const edge of page.rows) {
        const intent = {
          id: String(edge.id),
          type: "derived_from",
          source: { type: "message", id: String(edge.source_node_id) },
          target: { type: "message", id: String(edge.target_node_id) },
          metadata: asRecord(edge.data),
          weight: Number(edge.weight ?? 1),
        };
        const relation = {
          id: String(edge.id),
          namespace: String(edge.namespace),
          type: "derived_from",
          source: intent.source,
          target: intent.target,
          metadata: intent.metadata,
          weight: intent.weight,
          createdAt: iso(edge.created_at),
        };
        const body: GraphRelationEventBody = {
          operation: "upsert",
          intent,
          relation,
        };
        const source = sourceId(
          schema,
          String(edge.namespace),
          "relation",
          String(edge.id),
        );
        await commitSourceEvent({
          store,
          schema,
          stage: "relations",
          lastId: String(edge.id),
          namespace: String(edge.namespace),
          source,
          type: "relation.upserted",
          subject: { type: "relation", id: String(edge.id) },
          body,
          createdAt: iso(edge.created_at),
        });
        after = String(edge.id);
      }
    }
    await completeSourceStage(options.session, schema, "relations", "sources");
  }
  const counts = await options.session.query<
    { assets: string | number; records: string | number }
  >(
    `SELECT count(*) FILTER (WHERE type = 'asset.created') AS assets,
            count(*) FILTER (WHERE type <> 'asset.created') AS records
       FROM ${store.tables.events} WHERE metadata -> 'migration' IS NOT NULL`,
  );
  return Object.freeze({
    schema,
    archiveSchema: archive,
    baselineDigest: archiveCut.baselineDigest,
    pluginFingerprint,
    stage: "sources",
    counts: {
      assets: Number(counts.rows[0]?.assets ?? 0),
      records: Number(counts.rows[0]?.records ?? 0),
    },
  });
}

async function finalCounts(
  executor: SqlExecutor,
  schema: string,
  archive: string,
): Promise<V4MigrationResult["counts"]> {
  const finalTables = createCoreTableNames(schema);
  const values = await executor.query<
    {
      retained: string | number;
      retired: string | number;
      source_events: string | number;
      assets: string | number;
    }
  >(
    `SELECT
       (SELECT count(*) FROM ${finalTables.nodes} WHERE type <> 'asset') AS retained,
       (SELECT count(*) FROM ${
      q(archive, "nodes")
    } WHERE type = ANY($1::text[])) AS retired,
       (SELECT count(*) FROM ${finalTables.events} WHERE metadata -> 'migration' IS NOT NULL) AS source_events,
       (SELECT count(*) FROM ${finalTables.nodes} WHERE type = 'asset') AS assets`,
    [[...RETIRED_NODE_TYPES]],
  );
  const row = values.rows[0];
  return Object.freeze({
    retained: Number(row?.retained ?? 0),
    retired: Number(row?.retired ?? 0),
    sourceEvents: Number(row?.source_events ?? 0),
    assets: Number(row?.assets ?? 0),
  });
}

async function projectionSnapshot(
  executor: SqlExecutor,
  schema: string,
): Promise<string> {
  const tables = createCoreTableNames(schema);
  const [nodes, edges] = await Promise.all([
    executor.query<Record<string, unknown>>(
      `SELECT id, namespace, type, name, content, data, embedding, source_type, source_id FROM ${tables.nodes} ORDER BY namespace, type, id`,
    ),
    executor.query<Record<string, unknown>>(
      `SELECT id, namespace, source_node_id, target_node_id, type, data, weight FROM ${tables.edges} ORDER BY namespace, type, id`,
    ),
  ]);
  return canonical({ nodes: nodes.rows, edges: edges.rows });
}

async function verifyRebuiltSources(
  transaction: SqlExecutor,
  options: MigrateToV4Options,
  archiveCut: V4ArchiveCutResult,
  definitions: readonly CollectionDefinition[],
  rebuild = true,
): Promise<void> {
  const tables = createCoreTableNames(archiveCut.schema);
  const store = createEventStore({
    session: options.session,
    schema: archiveCut.schema,
  });
  const bodyStore = createDatabaseBodyStore({
    session: options.session,
    schema: archiveCut.schema,
  });
  const baseline = await preflightLegacyGraphV1(transaction, {
    schema: archiveCut.archiveSchema,
    sourceSchema: archiveCut.schema,
    resolveLegacyAsset: options.resolveLegacyAsset,
    pageSize: options.pageSize,
  });
  if (baseline.digest !== archiveCut.baselineDigest) {
    throw new Error(
      "v4 final verification found an altered legacy archive baseline.",
    );
  }
  const namespaces = await transaction.query<{ namespace: string }>(
    `SELECT DISTINCT namespace FROM ${tables.events} WHERE metadata -> 'migration' IS NOT NULL ORDER BY namespace`,
  );
  if (rebuild) {
    for (const row of namespaces.rows) {
      await rebuildNamespaceProjections(
        transaction,
        store,
        definitions,
        row.namespace,
      );
    }
    const first = await projectionSnapshot(transaction, archiveCut.schema);
    for (const row of namespaces.rows) {
      await rebuildNamespaceProjections(
        transaction,
        store,
        definitions,
        row.namespace,
      );
    }
    if (first !== await projectionSnapshot(transaction, archiveCut.schema)) {
      throw new Error(
        "v4 final verification found non-idempotent projection replay.",
      );
    }
  }
  for (const { namespace } of namespaces.rows) {
    for (const definition of definitions) {
      const verified = await verifyCollectionProjections(
        transaction,
        store,
        definition,
        namespace,
      );
      if (!verified.ok) {
        throw new Error(
          `v4 final verification failed for '${definition.name}': ${verified.reason}`,
        );
      }
    }
  }
  const expected = await transaction.query<
    { retained: string | number; assets: string | number }
  >(
    `SELECT
       (SELECT count(*) FROM ${q(archiveCut.archiveSchema, "nodes")}
         WHERE type <> 'asset' AND type <> ALL($1::text[])) AS retained,
       (SELECT count(*) FROM ${
      q(archiveCut.archiveSchema, "nodes")
    } WHERE type = 'asset') +
       (SELECT count(*) FROM ${
      q(archiveCut.archiveSchema, "nodes")
    } WHERE type = 'message') AS assets`,
    [[...RETIRED_NODE_TYPES]],
  );
  // Tool-result messages can name a durable tool alias without a retained
  // participant node. Those aliases are deliberately materialized as final
  // participants, so account for the exact deterministic additions.
  const aliases = await participantAliases(
    transaction,
    archiveCut.archiveSchema,
  );
  const syntheticTools = await synthesizeToolParticipants(
    transaction,
    archiveCut.archiveSchema,
    aliases,
  );
  const actual = await transaction.query<
    { retained: string | number; assets: string | number }
  >(
    `SELECT count(*) FILTER (WHERE type <> 'asset') AS retained,
            count(*) FILTER (WHERE type = 'asset') AS assets FROM ${tables.nodes}`,
  );
  if (
    Number(expected.rows[0]?.retained) + syntheticTools.length !==
      Number(actual.rows[0]?.retained) ||
    Number(expected.rows[0]?.assets) !== Number(actual.rows[0]?.assets)
  ) {
    throw new Error(
      "v4 final verification found retained record or Asset count mismatch.",
    );
  }
  const orphanEdges = await transaction.query<{ count: string | number }>(
    `SELECT count(*) AS count FROM ${tables.edges} edge
      LEFT JOIN ${tables.nodes} source ON source.id = edge.source_node_id
      LEFT JOIN ${tables.nodes} target ON target.id = edge.target_node_id
      WHERE source.id IS NULL OR target.id IS NULL`,
  );
  if (Number(orphanEdges.rows[0]?.count ?? 0)) {
    throw new Error("v4 final verification found orphan projection edges.");
  }
  const sourceAssets = await transaction.query<
    { namespace: string; payload: unknown }
  >(
    `SELECT namespace, payload FROM ${tables.events}
      WHERE type = 'asset.created' AND metadata -> 'migration' IS NOT NULL ORDER BY namespace, id`,
  );
  const knownAssets = new Set<string>();
  for (const event of sourceAssets.rows) {
    const eventBody = await readEventBody<AssetEventBody>(
      { transaction, tables },
      event.namespace,
      eventDataRef(event.payload),
    );
    if (eventBody.operation !== "create") {
      throw new Error("v4 final verification found a non-create Asset source.");
    }
    knownAssets.add(`${event.namespace}:${eventBody.asset.id}`);
    const bytes = await readBodyBytes(bodyStore, { bodyId: eventBody.bodyId });
    if (
      bytes.byteLength !== eventBody.asset.byteLength ||
      await digestContent(bytes) !== eventBody.asset.digest
    ) {
      throw new Error(
        `v4 final verification found corrupt Asset '${eventBody.asset.id}'.`,
      );
    }
    const legacy = asRecord(eventBody.asset.metadata).migration;
    const legacyNodeId = text(asRecord(legacy).legacyNodeId);
    if (!legacyNodeId) {
      throw new Error(
        `v4 final verification Asset '${eventBody.asset.id}' lacks legacy provenance.`,
      );
    }
    if (eventBody.asset.id.startsWith("migration-content:")) {
      const source = await transaction.query<
        { content: string | null; data: unknown }
      >(
        `SELECT content, data FROM ${
          q(archiveCut.archiveSchema, "nodes")
        } WHERE id = $1 AND type = 'message'`,
        [legacyNodeId],
      );
      const archived = source.rows[0];
      const legacyContent = asRecord(archived?.data).content;
      if (
        legacyContent !== undefined && legacyContent !== null &&
        typeof legacyContent !== "string"
      ) {
        throw new Error(
          `v4 final verification Message '${legacyNodeId}' has non-released archived data.content.`,
        );
      }
      if (
        typeof legacyContent === "string" && archived?.content !== null &&
        archived?.content !== legacyContent
      ) {
        throw new Error(
          `v4 final verification Message '${legacyNodeId}' has conflicting archived content.`,
        );
      }
      const expectedBytes = new TextEncoder().encode(
        typeof legacyContent === "string"
          ? legacyContent
          : archived?.content ?? "",
      );
      if (canonical([...bytes]) !== canonical([...expectedBytes])) {
        throw new Error(
          `v4 final verification Message '${legacyNodeId}' content bytes differ from archive.`,
        );
      }
    } else {
      const source = await transaction.query<LegacyNode>(
        `SELECT id, namespace, type, name, content, data, source_type, source_id, created_at, updated_at
           FROM ${
          q(archiveCut.archiveSchema, "nodes")
        } WHERE id = $1 AND type = 'asset'`,
        [legacyNodeId],
      );
      const node = source.rows[0];
      const data = asRecord(node?.data);
      const ref = text(data.ref);
      if (!node || !ref) {
        throw new Error(
          `v4 final verification Asset '${eventBody.asset.id}' has no archived source.`,
        );
      }
      const resolved = await options.resolveLegacyAsset({
        sourceSchema: archiveCut.schema,
        id: node.id,
        namespace: node.namespace,
        type: node.type,
        name: node.name,
        ref,
        data,
        sourceType: node.source_type,
        sourceId: node.source_id,
      });
      if (canonical([...bytes]) !== canonical([...resolved.bytes])) {
        throw new Error(
          `v4 final verification original Asset '${eventBody.asset.id}' bytes differ from resolver.`,
        );
      }
    }
  }
  const messages = await transaction.query<
    { namespace: string; data: unknown }
  >(
    `SELECT namespace, data FROM ${tables.nodes} WHERE type = 'message' ORDER BY namespace, id`,
  );
  for (const row of messages.rows) {
    const content = asRecord(row.data).content;
    if (
      !Array.isArray(content) || !content.length ||
      content.some((ref) =>
        typeof asRecord(ref).assetId !== "string" ||
        !knownAssets.has(`${row.namespace}:${asRecord(ref).assetId}`)
      )
    ) {
      throw new Error(
        "v4 final verification found an orphan Message content Asset reference.",
      );
    }
  }
  const customs = await transaction.query<LegacyNode>(
    `SELECT id, namespace, type, name, content, data, source_type, source_id, created_at, updated_at
       FROM ${q(archiveCut.archiveSchema, "nodes")}
      WHERE type <> ALL($1::text[]) AND type <> ALL($2::text[]) ORDER BY type, id`,
    [["asset", "participant", "thread", "message"], [...RETIRED_NODE_TYPES]],
  );
  for (const row of customs.rows) {
    const expectedRecord = {
      ...asRecord(row.data),
      id: row.id,
      namespace: row.namespace,
      createdAt: iso(row.created_at),
      updatedAt: iso(row.updated_at),
    };
    const actualRecord = await transaction.query<{ data: unknown }>(
      `SELECT data FROM ${tables.nodes} WHERE id = $1 AND namespace = $2 AND type = $3`,
      [row.id, row.namespace, row.type],
    );
    if (
      canonical(asRecord(actualRecord.rows[0]?.data)) !==
        canonical(expectedRecord)
    ) {
      throw new Error(
        `v4 final verification custom '${row.type}/${row.id}' differs from source.`,
      );
    }
  }
  const archivedRelations = await transaction.query<Record<string, unknown>>(
    `SELECT edge.id, source.namespace, edge.source_node_id, edge.target_node_id,
            COALESCE(edge.weight, 1) AS weight, edge.data AS metadata,
            edge.created_at
       FROM ${q(archiveCut.archiveSchema, "edges")} edge
       JOIN ${q(archiveCut.archiveSchema, "nodes")} source
         ON source.id = edge.source_node_id AND source.type = 'message'
       JOIN ${q(archiveCut.archiveSchema, "nodes")} target
         ON target.id = edge.target_node_id AND target.type = 'message'
      WHERE edge.type = 'derived_from'
      ORDER BY source.namespace, edge.id`,
  );
  const projectedRelations = await transaction.query<Record<string, unknown>>(
    `SELECT id, namespace, source_node_id, target_node_id, weight,
            data -> 'metadata' AS metadata, created_at
       FROM ${tables.edges}
      WHERE type = 'derived_from'
      ORDER BY namespace, id`,
  );
  if (
    canonical(archivedRelations.rows) !== canonical(projectedRelations.rows)
  ) {
    throw new Error(
      "v4 final verification derived_from relations differ from archive.",
    );
  }
}

async function rebuildForVerification(
  session: SqlSession,
  schema: string,
  definitions: readonly CollectionDefinition[],
): Promise<void> {
  const tables = createCoreTableNames(schema);
  const store = createEventStore({ session, schema });
  const namespaces = await session.query<{ namespace: string }>(
    `SELECT DISTINCT namespace FROM ${tables.events} WHERE metadata -> 'migration' IS NOT NULL ORDER BY namespace`,
  );
  for (const row of namespaces.rows) {
    await session.transaction((transaction) =>
      rebuildNamespaceProjections(
        transaction,
        store,
        definitions,
        row.namespace,
      )
    );
  }
  const first = await projectionSnapshot(session, schema);
  for (const row of namespaces.rows) {
    await session.transaction((transaction) =>
      rebuildNamespaceProjections(
        transaction,
        store,
        definitions,
        row.namespace,
      )
    );
  }
  if (first !== await projectionSnapshot(session, schema)) {
    throw new Error(
      "v4 final verification found non-idempotent projection replay.",
    );
  }
}

async function completeMigration(
  options: MigrateToV4Options,
  archiveCut: V4ArchiveCutResult,
  definitions: readonly CollectionDefinition[],
  pluginFingerprint: string,
): Promise<V4MigrationResult> {
  const schema = archiveCut.schema;
  // Replay can perform body reads through its configured session. Keep that
  // verification outside the tiny marker transaction; no ready marker exists
  // until every replay/verification pass has completed successfully.
  await rebuildForVerification(options.session, schema, definitions);
  await verifyRebuiltSources(
    options.session,
    options,
    archiveCut,
    definitions,
    false,
  );
  return await options.session.transaction(async (transaction) => {
    await transaction.query(
      "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
      [schema, "copilotz-v4-complete"],
    );
    const state = await sourceState(transaction, schema);
    if (!state || state.stage !== "sources") {
      throw new Error("v4 migration cannot complete before source stage.");
    }
    if (state.plugin_fingerprint !== pluginFingerprint) {
      throw new Error(
        "v4 migration final plugin graph does not match immutable source state.",
      );
    }
    await transaction.query(
      `UPDATE ${
        q(schema, STATE_TABLE)
      } SET stage = 'complete', source_cursor = $1::jsonb WHERE singleton = TRUE`,
      [JSON.stringify({ stage: "complete", lastId: "" })],
    );
    await transaction.query(
      `INSERT INTO ${
        createCoreTableNames(schema).copilotz_schema_metadata
      } (singleton, version)
       VALUES (TRUE, $1) ON CONFLICT (singleton) DO UPDATE SET version = EXCLUDED.version`,
      [EVENT_SCHEMA_VERSION],
    );
    return Object.freeze({
      schema,
      archiveSchema: archiveCut.archiveSchema,
      baselineDigest: archiveCut.baselineDigest,
      pluginFingerprint,
      stage: "complete" as const,
      counts: await finalCounts(transaction, schema, archiveCut.archiveSchema),
    });
  });
}

async function verifyComplete(
  options: MigrateToV4Options,
  archiveCut: V4ArchiveCutResult,
  pluginFingerprint: string,
  definitions: readonly CollectionDefinition[],
): Promise<V4MigrationResult> {
  const schema = archiveCut.schema;
  const state = await sourceState(options.session, schema);
  if (
    !state || state.stage !== "complete" ||
    state.plugin_fingerprint !== pluginFingerprint
  ) throw new Error("v4 migration complete state is inconsistent.");
  const marker = await options.session.query<{ version: string | number }>(
    `SELECT version FROM ${
      createCoreTableNames(schema).copilotz_schema_metadata
    } WHERE singleton = TRUE`,
  );
  if (Number(marker.rows[0]?.version) !== EVENT_SCHEMA_VERSION) {
    throw new Error(
      "v4 migration complete state is missing its schema marker.",
    );
  }
  const baseline = await preflightLegacyGraphV1(options.session, {
    schema: archiveCut.archiveSchema,
    sourceSchema: schema,
    resolveLegacyAsset: options.resolveLegacyAsset,
    pageSize: options.pageSize,
  });
  if (baseline.digest !== archiveCut.baselineDigest) {
    throw new Error("v4 migration complete archive baseline changed.");
  }
  await verifyRebuiltSources(
    options.session,
    options,
    archiveCut,
    definitions,
    false,
  );
  return Object.freeze({
    schema,
    archiveSchema: archiveCut.archiveSchema,
    baselineDigest: archiveCut.baselineDigest,
    pluginFingerprint,
    stage: "complete",
    counts: await finalCounts(
      options.session,
      schema,
      archiveCut.archiveSchema,
    ),
  });
}

/** Replays and verifies final source facts, then atomically marks the v4 schema ready. */
export async function migrateToV4(
  options: MigrateToV4Options,
): Promise<V4MigrationResult> {
  const registry = createPluginRegistry({ plugins: options.plugins });
  const definitions = new Map(
    Object.values(registry.collections).map((
      definition,
    ) => [definition.name, definition]),
  );
  const pluginFingerprint = await sha256(
    pluginSnapshot(registry.plugins, [...definitions.values()]),
  );
  const sourceSchema = validateEventSchemaName(options.schema ?? "public");
  if (!await stateRow(options.session, sourceSchema)) {
    requiredDefinitions(
      definitions,
      await archiveNodeTypes(options.session, sourceSchema),
    );
  }
  const archiveCut = await ensureArchiveCut(options);
  requiredDefinitions(
    definitions,
    await archiveNodeTypes(options.session, archiveCut.archiveSchema),
  );
  const existing = await stateRow(options.session, archiveCut.schema);
  if (existing?.stage === "complete") {
    return await verifyComplete(options, archiveCut, pluginFingerprint, [
      ...definitions.values(),
    ]);
  }
  await migrateSources(options, archiveCut, definitions, pluginFingerprint);
  return await completeMigration(
    options,
    archiveCut,
    [...definitions.values()],
    pluginFingerprint,
  );
}
