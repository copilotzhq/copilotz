/** Offline retained-history pruning. No runtime activation or schema migration. */
import { digestContent } from "../runtime/content/digest.ts";
import { unterminatedInvocationsSql } from "../runtime/actions/upgrade-history.ts";
import { quoteEventIdentifier as quote } from "../runtime/events/schema.ts";
import type { SqlExecutor, SqlSession } from "../runtime/events/session.ts";
import { openManagedOminipgDatabase } from "../runtime/persistence/ominipg.ts";

type Data = Record<string, unknown>;
type Row = {
  table: string;
  tid: string;
  hash: string;
  bytes: number;
  data: Data;
  refs: string[];
  pairs: Record<string, string | undefined>;
};
type ForeignKey = {
  source_schema: string;
  source_table: string;
  target_table: string;
  source_columns: string[];
  target_columns: string[];
  definition: string;
};
export type UnterminatedListing = {
  schema: string;
  version: number;
  invocations: {
    namespace: string;
    bodyId: string;
    actionId: string | null;
    runId: string;
    time: unknown;
    events: { eventId: string; time: unknown }[];
    closure: { table: string; tid: string; hash: string; identity: Data }[];
    retainedReference: boolean;
    refusals: string[];
  }[];
  digest: string;
  /** Optional reviewed subset; omit to select every listed body. */
  bodyIds?: string[];
};
export type PruneOptions = {
  schema: string;
  eventTypes: readonly string[];
  listUnterminated?: boolean;
  abandoned?: UnterminatedListing;
  actionIds?: readonly string[];
  apply?: boolean;
  writersStopped?: boolean;
  /** Target rows per transaction; an indivisible closure can exceed this. */
  batchSize?: number;
  progress?: (message: string) => void;
  /** Called after COMMIT. Throw here to stop safely between batches. */
  afterBatch?: (committedBatches: number) => void | Promise<void>;
};
export type PruneReport = {
  schema: string;
  version: number;
  mode: "dry-run" | "apply";
  before: Record<string, number>;
  after: Record<string, number>;
  deleteCounts: Record<string, number>;
  typesBefore: Record<string, number>;
  typesAfter: Record<string, number>;
  remainingFamilies: { type: string; count: number }[];
  refusals: { eventId: string; reasons: string[] }[];
  references: string[];
  /** Tuple bytes, not filesystem space returned by ordinary VACUUM. */
  tupleBytesDeleted: number;
  relationBytesBefore: number;
  relationBytesAfter: number;
  filesystemBytesReclaimed: number;
  vacuumCommands: string[];
  committedBatches: number;
  elapsedMs: number;
  unterminated?: UnterminatedListing;
};
const terminal = new Set(["completed", "failed", "cancelled"]);
function object(value: unknown): Data {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Data
    : {};
}
/** Includes nested JSON keys and encoded JSON used by alarm/deadline keys. */
function strings(
  value: unknown,
  visit: (value: string) => void,
  depth = 0,
): void {
  if (typeof value === "string") {
    visit(value);
    if (depth < 8 && /^[\[{]/.test(value)) {
      try {
        strings(JSON.parse(value), visit, depth + 1);
      } catch { /* plain text */ }
    }
  } else if (Array.isArray(value)) {
    for (const item of value) strings(item, visit, depth + 1);
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      visit(key);
      strings(item, visit, depth + 1);
    }
  }
}
function count(rows: Row[], indices?: Set<number>): Record<string, number> {
  const result: Record<string, number> = {};
  rows.forEach((row, i) => {
    result[row.table] ??= 0;
    if (!indices || indices.has(i)) result[row.table]++;
  });
  return result;
}
function types(
  rows: Row[],
  removed = new Set<number>(),
): Record<string, number> {
  const result: Record<string, number> = {};
  rows.forEach((row, i) => {
    if (row.table === "events" && !removed.has(i)) {
      const type = String(row.data.type);
      result[type] = (result[type] ?? 0) + 1;
    }
  });
  return result;
}

/**
 * Uses a repeatable inventory, catalog FK discovery, and conservative semantic
 * reference discovery. Writers must remain stopped for the entire apply run.
 * Supply a dedicated session with a long/no driver request timeout.
 */
export async function pruneRetainedHistory(
  session: SqlSession,
  options: PruneOptions,
): Promise<PruneReport> {
  const start = performance.now();
  const schema = quote(options.schema);
  const table = (name: string) => `${schema}.${quote(name)}`;
  if (
    (!options.eventTypes.length && !options.listUnterminated &&
      !options.abandoned) ||
    options.eventTypes.some((p) =>
      !p || p === "*" || p.slice(0, -1).includes("*")
    )
  ) throw new Error("Specify exact event types or nonempty trailing prefixes.");
  if (options.apply && !options.writersStopped) {
    throw new Error("Apply requires --writers-stopped.");
  }
  const batchSize = options.batchSize ?? 5000;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) {
    throw new Error("batchSize must be a positive integer.");
  }
  const progress = options.progress ?? ((message) => console.error(message));
  if (options.listUnterminated && options.abandoned) {
    throw new Error("Choose listing or retirement, not both.");
  }
  if (options.listUnterminated && options.apply) {
    throw new Error("Listing is read-only.");
  }
  if (
    (options.listUnterminated || options.abandoned) && options.eventTypes.length
  ) {
    throw new Error("Retirement and event-type pruning are separate reviews.");
  }
  const listingDigest = (listing: Omit<UnterminatedListing, "digest">) =>
    digestContent(new TextEncoder().encode(JSON.stringify({
      schema: listing.schema,
      version: listing.version,
      invocations: listing.invocations,
    })));
  if (
    options.abandoned && (options.abandoned.schema !== options.schema ||
      !Array.isArray(options.abandoned.invocations) ||
      await listingDigest(options.abandoned) !== options.abandoned.digest)
  ) {
    throw new Error("Abandoned listing digest or schema does not match.");
  }
  const rows: Row[] = [];
  const runBodyCounts = new Map<string, number>();
  let incomplete: {
    namespace: string;
    event_body_id: string;
    run_id: string;
    action_id: string | null;
  }[] = [];
  const byTable = new Map<string, number[]>();
  let version = 0;
  let fks: ForeignKey[] = [];
  let relationBytesBefore = 0;
  let localTables: string[] = [];
  const size = async (tx: SqlExecutor) =>
    Number(
      (await tx.query<{ bytes: string }>(
        `SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::text AS bytes
     FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
     WHERE n.nspname=$1 AND c.relkind='r'`,
        [options.schema],
      )).rows[0].bytes,
    );
  await session.transaction(async (tx) => {
    await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await tx.query("SET LOCAL statement_timeout=0");
    const marker = (await tx.query<{ version: number }>(
      `SELECT version FROM ${
        table("copilotz_schema_metadata")
      } WHERE singleton`,
    )).rows;
    version = Number(marker[0]?.version);
    if (marker.length !== 1 || ![7, 11].includes(version)) {
      throw new Error(
        `Unsupported retained schema version ${version}; expected v7 or v11.`,
      );
    }
    const relations = (await tx.query<{ name: string; unsafe: boolean }>(
      `SELECT c.relname AS name, (c.relkind<>'r' OR c.relrowsecurity OR
        EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal
          AND t.tgenabled<>'D' AND (t.tgtype::int & 8)<>0) OR
        EXISTS(SELECT 1 FROM pg_rewrite r WHERE r.ev_class=c.oid AND r.ev_type='4') OR
        EXISTS(SELECT 1 FROM pg_inherits h WHERE h.inhrelid=c.oid OR h.inhparent=c.oid)) AS unsafe
       FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname=$1 AND c.relkind IN ('r','p','f','m') ORDER BY c.relname`,
      [options.schema],
    )).rows;
    if (relations.some((r) => r.unsafe)) {
      throw new Error(
        "Unsupported partition, foreign table, row security, DELETE trigger or DELETE rule.",
      );
    }
    localTables = relations.map((r) => r.name);
    for (
      const required of [
        "events",
        "event_bodies",
        "event_deliveries",
        "open_actions",
        "copilotz_operations",
        "copilotz_operation_events",
        "copilotz_operation_streams",
      ]
    ) {
      if (!localTables.includes(required)) {
        throw new Error(`Missing required table ${required}.`);
      }
    }
    fks = (await tx.query<ForeignKey>(
      `SELECT sn.nspname AS source_schema, s.relname AS source_table,
        d.relname AS target_table, pg_get_constraintdef(k.oid) AS definition,
        ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY x(num,ord)
          JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num ORDER BY x.ord) AS source_columns,
        ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY x(num,ord)
          JOIN pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num ORDER BY x.ord) AS target_columns
       FROM pg_constraint k JOIN pg_class s ON s.oid=k.conrelid
       JOIN pg_namespace sn ON sn.oid=s.relnamespace
       JOIN pg_class d ON d.oid=k.confrelid JOIN pg_namespace dn ON dn.oid=d.relnamespace
       WHERE k.contype='f' AND dn.nspname=$1`,
      [options.schema],
    )).rows;
    relationBytesBefore = await size(tx);
    if (options.listUnterminated || options.abandoned) {
      incomplete = (await tx.query<typeof incomplete[number]>(
        unterminatedInvocationsSql(options.schema),
      )).rows;
    }
    const sources = new Map(localTables.map((name) => [name, table(name)]));
    for (const fk of fks) {
      if (fk.source_schema !== options.schema) {
        const source = `${quote(fk.source_schema)}.${quote(fk.source_table)}`;
        const hidden = (await tx.query<{ unsafe: boolean }>(
          `SELECT (relrowsecurity OR relkind<>'r' OR EXISTS(
            SELECT 1 FROM pg_inherits WHERE inhrelid=c.oid OR inhparent=c.oid
          )) AS unsafe FROM pg_class c WHERE oid=$1::regclass`,
          [source],
        )).rows[0];
        if (!hidden || hidden.unsafe) {
          throw new Error(
            `Cannot inventory incoming references from ${source}.`,
          );
        }
        sources.set(
          `${fk.source_schema}.${fk.source_table}`,
          source,
        );
      }
    }
    // First gather the identity universe, then discard all other strings while
    // streaming full rows. Large bodies and arbitrary graph payloads never survive a page.
    const universe = new Set<string>();
    const identityColumns: Record<string, string[]> = {
      events: ["id", "subject_id"],
      event_bodies: ["namespace", "event_body_id"],
      copilotz_operations: ["operation_id"],
      event_deliveries: ["id"],
      copilotz_operation_streams: ["stream_id"],
      owner_receipts: ["key"],
      authorization_effects: ["effect_key"],
      authorization_invocations: ["run_id"],
      copilotz_operation_selection_heads: ["selection_key"],
    };
    for (const [name, columns] of Object.entries(identityColumns)) {
      if (!localTables.includes(name)) continue;
      const extra = name === "event_bodies"
        ? ",body->>'actionRunId' AS run"
        : "";
      await tx.query(
        `DECLARE prune_ids NO SCROLL CURSOR FOR SELECT ${
          columns.map(quote).join(",")
        }${extra} FROM ${table(name)}`,
      );
      while (true) {
        const page = (await tx.query<Data>("FETCH 5000 FROM prune_ids")).rows;
        for (const row of page) {
          if (
            name === "event_bodies" && row.run != null &&
            (options.listUnterminated || options.abandoned)
          ) {
            const k = JSON.stringify([row.namespace, row.run]);
            runBodyCounts.set(k, (runBodyCounts.get(k) ?? 0) + 1);
          }
          for (const value of Object.values(row)) {
            if (typeof value === "string" && value) universe.add(value);
          }
        }
        if (page.length < 5000) break;
      }
      await tx.query("CLOSE prune_ids");
    }
    const ownedTables = new Set([
      "events",
      "event_bodies",
      "copilotz_operations",
      "event_deliveries",
      "copilotz_operation_events",
      "copilotz_operation_streams",
      "copilotz_operation_selections",
      "copilotz_operation_selection_heads",
      "owner_receipts",
      "action_effects",
      "authorization_effects",
      "authorization_invocations",
    ]);
    const emptyData: Data = {},
      emptyRefs: string[] = [],
      emptyPairs: Row["pairs"] = {};
    const fields = [
      "namespace",
      "id",
      "type",
      "subject_id",
      "event_body_id",
      "operation_id",
      "root_event_id",
      "event_id",
      "stream_id",
      "state",
      "status",
      "operation_id",
      "accepted_operation",
      "consumed_run",
      "run_id",
      "action_run_id",
      "selection_key",
      "key",
      "effect_key",
      "created_at",
      "step",
      "owner",
      "domain",
    ];
    for (const [name, qualified] of sources) {
      progress(`Inventory ${name}`);
      const indices: number[] = [];
      const ownable = ownedTables.has(name);
      byTable.set(name, indices);
      // A cursor keeps transfer bounded without OFFSET scans or dependence on a PK.
      await tx.query(`DECLARE prune_inventory NO SCROLL CURSOR FOR
        SELECT ctid::text AS tid, md5(to_jsonb(t)::text) AS hash,
          pg_column_size(t) AS bytes, to_jsonb(t) AS data FROM ${qualified} t`);
      while (true) {
        const page = (await tx.query<
          { tid: string; hash: string; bytes: number; data: Data }
        >(
          "FETCH 1000 FROM prune_inventory",
        )).rows;
        for (const row of page) {
          indices.push(rows.length);
          const refs = new Set<string>();
          strings(row.data, (value) => {
            if (universe.has(value)) refs.add(value);
          });
          const pairs: Row["pairs"] = {};
          for (let f = 0; f < fks.length; f++) {
            const fk = fks[f];
            if (!ownedTables.has(fk.target_table)) continue;
            const source = fk.source_schema === options.schema
              ? fk.source_table
              : `${fk.source_schema}.${fk.source_table}`;
            for (
              const [side, columns] of [[
                "source",
                source === name ? fk.source_columns : [],
              ], [
                "target",
                fk.target_table === name ? fk.target_columns : [],
              ]] as const
            ) {
              if (!columns.length) continue;
              const values = columns.map((c) => row.data[c]);
              pairs[`${f}:${side}`] = values.some((v) => v == null)
                ? undefined
                : JSON.stringify(values);
            }
          }
          const data: Data = ownable ? {} : emptyData;
          for (const field of ownable ? fields : []) {
            if (field in row.data) data[field] = row.data[field];
          }
          if (name === "events") {
            const meta = object(row.data.metadata);
            data.metadata = {
              actionId: meta.actionId,
              actionStatus: meta.actionStatus,
            };
            data.payload = { dataRef: object(row.data.payload).dataRef };
          }
          if (name === "event_bodies") {
            const body = object(row.data.body), input = object(body.input);
            data.body = {
              actionId: body.actionId,
              actionRunId: body.actionRunId,
              status: body.status,
              parentActionRunId: body.parentActionRunId,
              requestId: body.requestId,
              input: { requestId: input.requestId, actionId: input.actionId },
            };
          }
          rows.push({
            tid: row.tid,
            hash: ownable ? row.hash : "",
            bytes: ownable ? Number(row.bytes) : 0,
            table: name,
            data,
            refs: refs.size ? [...refs] : emptyRefs,
            pairs: Object.keys(pairs).length ? pairs : emptyPairs,
          });
        }
        if (page.length < 1000) break;
      }
      await tx.query("CLOSE prune_inventory");
    }
  });
  progress(`Planning closure for ${rows.length} retained rows`);
  const indices = (name: string) => byTable.get(name) ?? [];
  const key = (ns: unknown, id: unknown) => JSON.stringify([ns, id]);
  const events = new Map(
    indices("events").map((
      i,
    ) => [key(rows[i].data.namespace, rows[i].data.id), i]),
  );
  const eventsById = new Map(
    indices("events").map((i) => [rows[i].data.id, i]),
  );
  const bodies = new Map(
    indices("event_bodies").map((
      i,
    ) => [key(rows[i].data.namespace, rows[i].data.event_body_id), i]),
  );
  const operations = new Map(
    indices("copilotz_operations").map((
      i,
    ) => [key(rows[i].data.namespace, rows[i].data.operation_id), i]),
  );
  const bodyFor = (i: number) => {
    const id = object(object(rows[i].data.payload).dataRef).eventBodyId;
    return typeof id === "string" && id.trim()
      ? bodies.get(key(rows[i].data.namespace, id.trim()))
      : undefined;
  };
  const eventsByBody = new Map<number, number[]>();
  for (const i of indices("events")) {
    const b = bodyFor(i);
    if (b === undefined) continue;
    const list = eventsByBody.get(b) ?? [];
    list.push(i);
    eventsByBody.set(b, list);
  }
  const action = (i: number) => {
    const row = rows[i].data;
    const body = object(rows[bodyFor(i) ?? -1]?.data.body);
    const metadata = object(row.metadata);
    return {
      id: body.actionId ?? metadata.actionId,
      run: body.actionRunId ?? (metadata.actionId ? row.subject_id : undefined),
      status: body.status ?? metadata.actionStatus,
      body,
    };
  };
  // Resolve server wrappers through captured child Action identities, never aliases.
  const childActions = new Map<string, Set<string>>();
  for (const i of indices("events")) {
    const a = action(i);
    if (a.body.parentActionRunId && typeof a.id === "string") {
      const k = key(rows[i].data.namespace, a.body.parentActionRunId);
      const ids = childActions.get(k) ?? new Set<string>();
      ids.add(a.id);
      childActions.set(k, ids);
    }
  }
  const requestActions = new Map<string, Set<string>>();
  for (const i of indices("events")) {
    const a = action(i), request = object(a.body.input).requestId;
    const ids = childActions.get(key(rows[i].data.namespace, a.run));
    if (request && ids) {
      const k = key(rows[i].data.namespace, request);
      const merged = requestActions.get(k) ?? new Set<string>();
      for (const id of ids) merged.add(id);
      requestActions.set(k, merged);
    }
  }
  const selected = new Set<number>();
  for (const i of indices("events")) {
    const type = String(rows[i].data.type);
    if (
      !options.eventTypes.some((p) =>
        p.endsWith("*") ? type.startsWith(p.slice(0, -1)) : type === p
      )
    ) continue;
    const identity = action(i);
    if (options.actionIds?.length && type.startsWith("copilotz.server.")) {
      const direct = identity.id === "copilotz.server.internal.invoke"
        ? object(identity.body.input).actionId
        : identity.body.actionId ?? identity.id;
      const ids = childActions.get(key(rows[i].data.namespace, identity.run)) ??
        requestActions.get(
          key(rows[i].data.namespace, identity.body.requestId),
        ) ??
        new Set(typeof direct === "string" ? [direct] : []);
      if (
        !ids.size || ![...ids].every((id) => options.actionIds!.includes(id))
      ) continue;
    }
    selected.add(i);
  }
  const abandonedBodies = new Set<number>();
  const abandonedRuns = new Map<number, string>();
  const requested = options.abandoned?.bodyIds;
  if (
    requested &&
    (!Array.isArray(requested) ||
      requested.some((id) =>
        !options.abandoned!.invocations.some((entry) => entry.bodyId === id)
      ))
  ) {
    throw new Error("Reviewed body IDs must belong to the bound listing.");
  }
  if (options.abandoned && options.abandoned.version !== version) {
    throw new Error("Listing version changed.");
  }
  const reviewed = options.abandoned?.invocations.filter((entry) =>
    !requested || requested.includes(entry.bodyId)
  );
  const liveIncomplete = new Set(
    incomplete.map((entry) => key(entry.namespace, entry.event_body_id)),
  );
  for (const entry of reviewed ?? []) {
    const b = bodies.get(key(entry.namespace, entry.bodyId));
    if (
      b !== undefined && !liveIncomplete.has(key(entry.namespace, entry.bodyId))
    ) {
      throw new Error(
        `Reviewed invocation is no longer unterminated: ${entry.bodyId}`,
      );
    }
  }
  for (const entry of incomplete) {
    if (
      reviewed &&
      !reviewed.some((r) =>
        r.namespace === entry.namespace && r.bodyId === entry.event_body_id
      )
    ) continue;
    const b = bodies.get(key(entry.namespace, entry.event_body_id))!;
    abandonedBodies.add(b);
    abandonedRuns.set(b, entry.run_id);
    for (const i of eventsByBody.get(b) ?? []) selected.add(i);
  }
  const candidate = new Set([...selected, ...abandonedBodies]);
  const parents = rows.map((_, i) => i);
  const root = (i: number): number => {
    while (parents[i] !== i) {
      parents[i] = parents[parents[i]];
      i = parents[i];
    }
    return i;
  };
  const union = (a: number, b: number) => {
    parents[root(b)] = root(a);
  };
  const reasons = new Map<number, Set<string>>();
  const refuse = (i: number, reason: string) => {
    const set = reasons.get(i) ?? new Set<string>();
    set.add(reason);
    reasons.set(i, set);
  };
  const own = (child: number, parent: number) => {
    candidate.add(child);
    union(child, parent);
  };
  for (const i of selected) {
    const b = bodyFor(i);
    if (b !== undefined) own(b, i);
    else if (object(rows[i].data.payload).dataRef) {
      refuse(i, "missing event body");
    }
  }
  const runs = new Map<string, number[]>();
  for (const i of indices("events")) {
    const a = action(i);
    if (a.run && a.id) {
      const k = key(rows[i].data.namespace, [a.id, a.run]);
      const members = runs.get(k) ?? [];
      members.push(i);
      runs.set(k, members);
    } else if (
      !abandonedBodies.has(bodyFor(i) ?? -1) && selected.has(i) &&
      /\.(invoked|completed|failed|cancelled)$/.test(String(rows[i].data.type))
    ) {
      refuse(i, "invocation identity unavailable; cannot prove terminal pair");
    }
  }
  for (const members of runs.values()) {
    const chosen = members.filter((i) => selected.has(i));
    if (!chosen.length) continue;
    const statuses = members.map((i) => String(action(i).status));
    for (const i of chosen) {
      union(i, chosen[0]);
      if (
        !abandonedBodies.has(bodyFor(i) ?? -1) && (
          chosen.length !== members.length || !statuses.includes("invoked") ||
          !statuses.some((s) => terminal.has(s))
        )
      ) {
        refuse(i, "invocation and terminal must both be selected and present");
      }
    }
  }
  for (const b of abandonedBodies) {
    if (!abandonedRuns.get(b) || !rows[b].data.event_body_id) {
      refuse(b, "retirement requires nonempty body and run identities");
    }
    if (
      runBodyCounts.get(key(rows[b].data.namespace, abandonedRuns.get(b))) !== 1
    ) {
      refuse(
        b,
        "retirement requires exactly one body for the run, with no terminal or other body",
      );
    }
  }
  for (const i of indices("copilotz_operations")) {
    const r = rows[i].data;
    const e = events.get(key(r.namespace, r.root_event_id));
    if (e !== undefined && selected.has(e)) own(i, e);
  }
  for (
    const name of [
      "event_deliveries",
      "copilotz_operation_events",
      "copilotz_operation_streams",
      "copilotz_operation_selections",
    ]
  ) {
    for (const i of indices(name)) {
      const r = rows[i].data;
      const owner = name === "event_deliveries"
        ? eventsById.get(r.event_id)
        : operations.get(key(r.namespace, r.operation_id));
      if (owner !== undefined && candidate.has(owner)) {
        own(i, owner);
        if (name === "copilotz_operation_events") {
          const e = events.get(key(r.namespace, r.event_id));
          if (e === undefined || !selected.has(e)) {
            refuse(owner, "operation contains unselected semantic history");
          } else union(i, e);
        }
      }
    }
  }
  const identities = new Map<string, number[]>();
  const addIdentity = (value: unknown, i: number) => {
    if (typeof value !== "string" || !value) return;
    const entries = identities.get(value) ?? [];
    entries.push(i);
    identities.set(value, entries);
  };
  for (const i of candidate) {
    const r = rows[i];
    if (r.table === "events") {
      addIdentity(r.data.id, i);
      addIdentity(action(i).run, i);
    }
    if (r.table === "event_bodies") {
      addIdentity(r.data.event_body_id, i);
      if (abandonedBodies.has(i)) {
        addIdentity(abandonedRuns.get(i), i);
      }
    }
    if (r.table === "copilotz_operations") addIdentity(r.data.operation_id, i);
    if (r.table === "event_deliveries") addIdentity(r.data.id, i);
    if (r.table === "copilotz_operation_streams") {
      addIdentity(r.data.stream_id, i);
    }
  }
  const targets = (i: number): Set<number> => {
    const found = new Set<number>();
    const r = rows[i];
    for (const v of r.refs) {
      for (const t of identities.get(v) ?? []) {
        if (
          t !== i
        ) found.add(t);
      }
    }
    return found;
  };
  const retainedIdentities = new Map<string, Set<unknown>>();
  for (const name of ["events", "event_bodies", "copilotz_operations"]) {
    for (const i of indices(name)) {
      if (candidate.has(i)) continue;
      const r = rows[i].data;
      const values = name === "events"
        ? [r.id, action(i).run]
        : name === "event_bodies"
        ? [r.event_body_id]
        : [r.operation_id];
      for (const v of values) {
        if (typeof v === "string") {
          const namespaces = retainedIdentities.get(v) ?? new Set<unknown>();
          namespaces.add(r.namespace);
          retainedIdentities.set(v, namespaces);
        }
      }
    }
  }
  for (
    const name of [
      "owner_receipts",
      "action_effects",
      "authorization_effects",
      "authorization_invocations",
    ]
  ) {
    for (const i of indices(name)) {
      const refs = targets(i);
      const owners = [...refs].filter((t) =>
        rows[t].table === "copilotz_operations" ||
        (rows[t].table === "events" && action(t).run) || abandonedBodies.has(t)
      );
      if (!owners.length) continue;
      // An explicit operation/run identity outside the candidate set is shared.
      const r = rows[i].data;
      if (
        [
          r.operation_id,
          r.accepted_operation,
          r.consumed_run,
          r.run_id,
          r.action_run_id,
        ].some((v) => typeof v === "string" && !identities.has(v))
      ) continue;
      let shared = false;
      for (const v of rows[i].refs) {
        const namespaces = retainedIdentities.get(v);
        if (namespaces) shared = true;
      }
      if (shared) continue;
      for (const owner of owners) own(i, owner);
    }
  }
  const selections = new Map<string, number[]>();
  for (const i of indices("copilotz_operation_selections")) {
    const r = rows[i].data, k = key(r.namespace, r.selection_key);
    const group = selections.get(k) ?? [];
    group.push(i);
    selections.set(k, group);
  }
  for (const i of indices("copilotz_operation_selection_heads")) {
    const r = rows[i].data;
    const group = selections.get(key(r.namespace, r.selection_key)) ?? [];
    if (group.length && group.every((s) => candidate.has(s))) {
      for (const s of group) own(i, s);
    }
  }
  // Owned rows have identities of their own. A retained extension/graph record
  // can refer to a receipt, authorization effect or head without mentioning its
  // operation. Add these after ownership selection, before scanning references.
  for (const i of candidate) {
    const r = rows[i];
    if (r.table === "owner_receipts") addIdentity(r.data.key, i);
    if (r.table === "authorization_effects") addIdentity(r.data.effect_key, i);
    if (r.table === "authorization_invocations") addIdentity(r.data.run_id, i);
    if (r.table === "copilotz_operation_selection_heads") {
      addIdentity(r.data.selection_key, i);
    }
  }
  for (const i of candidate) {
    const r = rows[i];
    if (
      r.table === "event_deliveries" &&
      !["succeeded", "cancelled", "dead_letter"].includes(String(r.data.status))
    ) refuse(i, `non-terminal delivery: ${r.data.status}`);
    if (
      r.table === "copilotz_operations" && !terminal.has(String(r.data.state))
    ) refuse(i, `open or unknown operation: ${r.data.state}`);
    if (
      r.table === "copilotz_operation_streams" && r.data.state !== "terminal"
    ) refuse(i, `non-terminal stream: ${r.data.state}`);
    if (
      r.table === "action_effects" &&
      !["confirmed", "not_started"].includes(String(r.data.status))
    ) refuse(i, `unconfirmed effect: ${r.data.status}`);
  }
  const references = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    for (const target of targets(i)) {
      references.add(
        `${rows[i].table} -> ${
          rows[target].table
        } (retained identity in text/JSON)`,
      );
      if (candidate.has(i)) union(i, target);
      else {refuse(
          target,
          `retained reference from ${rows[i].table} ${rows[i].tid}`,
        );}
    }
  }
  // Discover even nonstandard/composite FKs, including incoming cross-schema FKs.
  for (const [f, fk] of fks.entries()) {
    const source = fk.source_schema === options.schema
      ? fk.source_table
      : `${fk.source_schema}.${fk.source_table}`;
    references.add(`${source} -> ${fk.target_table}: ${fk.definition}`);
    const referenced = new Map<string, number>();
    for (const i of indices(fk.target_table)) {
      if (candidate.has(i)) {
        referenced.set(
          rows[i].pairs[`${f}:target`]!,
          i,
        );
      }
    }
    for (const i of indices(source)) {
      const pair = rows[i].pairs[`${f}:source`];
      if (pair === undefined) continue;
      const target = referenced.get(pair);
      if (target === undefined) continue;
      if (candidate.has(i)) union(i, target);
      else refuse(target, `foreign key from retained ${source} ${rows[i].tid}`);
    }
  }
  const blocked = new Map<number, Set<string>>();
  for (const [i, messages] of reasons) {
    const k = root(i), set = blocked.get(k) ?? new Set<string>();
    for (const message of messages) set.add(message);
    blocked.set(k, set);
  }
  let unterminated: UnterminatedListing | undefined;
  if (options.listUnterminated || options.abandoned) {
    const closures = new Map<
      number,
      UnterminatedListing["invocations"][number]["closure"]
    >();
    for (const i of candidate) {
      const k = root(i), group = closures.get(k) ?? [];
      group.push({
        table: rows[i].table,
        tid: rows[i].tid,
        hash: rows[i].hash,
        identity: Object.fromEntries(
          Object.entries(rows[i].data).filter(([name]) =>
            !["body", "payload", "metadata"].includes(name)
          ),
        ),
      });
      closures.set(k, group);
    }
    for (const group of closures.values()) {
      group.sort((a, b) =>
        a.table.localeCompare(b.table) || a.tid.localeCompare(b.tid)
      );
    }
    const invocations = incomplete.filter((entry) =>
      abandonedBodies.has(
        bodies.get(key(entry.namespace, entry.event_body_id))!,
      )
    ).map((entry) => {
      const b = bodies.get(key(entry.namespace, entry.event_body_id))!;
      const refusals = [...(blocked.get(root(b)) ?? [])].sort();
      return {
        namespace: entry.namespace,
        bodyId: entry.event_body_id,
        actionId: entry.action_id,
        runId: entry.run_id,
        time: rows[b].data.created_at ?? null,
        events: (eventsByBody.get(b) ?? []).map((i) => ({
          eventId: String(rows[i].data.id),
          time: rows[i].data.created_at,
        })).sort((a, b) => a.eventId.localeCompare(b.eventId)),
        closure: closures.get(root(b))!,
        retainedReference: refusals.some((r) =>
          r.startsWith("retained reference") || r.startsWith("foreign key")
        ),
        refusals,
      };
    }).sort((a, b) =>
      a.namespace.localeCompare(b.namespace) || a.bodyId.localeCompare(b.bodyId)
    );
    const listing = { schema: options.schema, version, invocations };
    unterminated = { ...listing, digest: await listingDigest(listing) };
    for (const current of invocations) {
      const previous = reviewed?.find((entry) =>
        entry.namespace === current.namespace && entry.bodyId === current.bodyId
      );
      if (reviewed && JSON.stringify(previous) !== JSON.stringify(current)) {
        throw new Error(
          `Reviewed invocation closure changed: ${current.bodyId}. List and review again.`,
        );
      }
    }
  }
  const removed = new Set([...candidate].filter((i) => !blocked.has(root(i))));
  const groups = new Map<number, number[]>();
  for (const i of removed) {
    const k = root(i), group = groups.get(k) ?? [];
    group.push(i);
    groups.set(k, group);
  }
  const deleteCounts = count(rows, removed);
  for (const name of byTable.keys()) deleteCounts[name] ??= 0;
  const touched = localTables.filter((t) => deleteCounts[t]);
  // Child first, regardless of CASCADE. Fail closed for cyclic delete dependencies.
  const order: string[] = [], visiting = new Set<string>();
  const orderTable = (name: string) => {
    if (order.includes(name)) return;
    if (visiting.has(name)) {
      throw new Error(
        "Cyclic foreign keys in deletion closure are unsupported.",
      );
    }
    visiting.add(name);
    for (const fk of fks) {
      if (
        fk.target_table === name && fk.source_schema === options.schema &&
        touched.includes(fk.source_table)
      ) orderTable(fk.source_table);
    }
    visiting.delete(name);
    order.push(name);
  };
  for (const name of touched) orderTable(name);
  let committedBatches = 0;
  if (options.apply) {
    let batch: number[] = [];
    const flush = async () => {
      if (!batch.length) return;
      const current = batch;
      batch = [];
      await session.transaction(async (tx) => {
        await tx.query("SET LOCAL statement_timeout=0");
        await tx.query(
          `LOCK TABLE ${
            localTables.map(table).join(",")
          } IN ACCESS EXCLUSIVE MODE`,
        );
        const marker = (await tx.query<{ version: number }>(
          `SELECT version FROM ${
            table("copilotz_schema_metadata")
          } WHERE singleton`,
        )).rows;
        if (marker.length !== 1 || Number(marker[0].version) !== version) {
          throw new Error("Schema version changed during pruning.");
        }
        for (const name of order) {
          const selectedRows = current.filter((i) => rows[i].table === name);
          // Each statement stays bounded even when a connected closure is huge.
          for (
            let offset = 0;
            offset < selectedRows.length;
            offset += batchSize
          ) {
            const chunk = selectedRows.slice(offset, offset + batchSize);
            const planned = JSON.stringify(
              chunk.map((i) => ({ tid: rows[i].tid, hash: rows[i].hash })),
            );
            const result = await tx.query<{ count: string }>(
              `WITH deleted AS (DELETE FROM ${table(name)} t USING
                 jsonb_to_recordset($1::jsonb) AS p(tid text,hash text)
                 WHERE t.ctid=p.tid::tid AND md5(to_jsonb(t)::text)=p.hash RETURNING 1)
               SELECT count(*)::text AS count FROM deleted`,
              [planned],
            );
            if (Number(result.rows[0].count) !== chunk.length) {
              throw new Error(
                "Inventory changed; batch rolled back. Stop writers and rerun.",
              );
            }
          }
        }
      });
      committedBatches++;
      progress(`Committed batch ${committedBatches}: ${current.length} rows`);
      await options.afterBatch?.(committedBatches);
    };
    for (const group of groups.values()) {
      if (batch.length && batch.length + group.length > batchSize) {
        await flush();
      }
      for (const i of group) batch.push(i);
    }
    await flush();
  }
  const before = count(rows);
  for (const name of byTable.keys()) before[name] ??= 0;
  const after = { ...before };
  for (const [name, n] of Object.entries(deleteCounts)) after[name] -= n;
  if (options.apply) {
    for (const name of localTables) {
      const actual = Number(
        (await session.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM ${table(name)}`,
        )).rows[0].count,
      );
      if (actual !== after[name]) {
        throw new Error(
          `Unexpected after count for ${name}; keep writers stopped and inspect.`,
        );
      }
      after[name] = actual;
    }
  }
  const typesAfter = types(rows, removed);
  const relationBytesAfter = options.apply
    ? await size(session)
    : relationBytesBefore;
  progress(
    `${
      options.apply ? "Pruned" : "Would prune"
    } ${removed.size} rows; ${selected.size} matched events`,
  );
  return {
    schema: options.schema,
    version,
    mode: options.apply ? "apply" : "dry-run",
    before,
    after,
    deleteCounts,
    typesBefore: types(rows),
    typesAfter,
    remainingFamilies: Object.entries(typesAfter).map(([type, count]) => ({
      type,
      count,
    })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type)),
    refusals: [
      ...new Set([
        ...selected,
        ...[...abandonedBodies].filter((b) => !eventsByBody.has(b)),
      ]),
    ].filter((i) => blocked.has(root(i))).map((i) => ({
      eventId: String(rows[i].data.id ?? rows[i].data.event_body_id),
      reasons: [...blocked.get(root(i))!].sort(),
    })),
    references: [...references].sort(),
    tupleBytesDeleted: [...removed].reduce((sum, i) => sum + rows[i].bytes, 0),
    relationBytesBefore,
    relationBytesAfter,
    filesystemBytesReclaimed: Math.max(
      0,
      relationBytesBefore - relationBytesAfter,
    ),
    vacuumCommands: touched.map((name) => `VACUUM (ANALYZE) ${table(name)};`),
    committedBatches,
    elapsedMs: Math.round(performance.now() - start),
    ...(unterminated ? { unterminated } : {}),
  };
}

if (import.meta.main) {
  const values = (name: string) =>
    Deno.args.filter((a) => a.startsWith(`--${name}=`)).map((a) =>
      a.slice(name.length + 3)
    );
  const schema = values("schema");
  if (
    schema.length !== 1 || values("abandoned").length > 1 ||
    Deno.args.some((a) =>
      !["--apply", "--dry-run", "--writers-stopped", "--list-unterminated"]
        .includes(a) &&
      !["schema", "event-type", "action-id", "abandoned"].some((n) =>
        a.startsWith(`--${n}=`)
      )
    ) || (Deno.args.includes("--apply") && Deno.args.includes("--dry-run"))
  ) {
    throw new Error(
      "Usage: --schema=S (--event-type=TYPE|PREFIX* [--action-id=ID] | --list-unterminated | --abandoned=FILE.json) [--dry-run | --apply --writers-stopped]",
    );
  }
  const url = Deno.env.get("COPILOTZ_MIGRATION_DATABASE_URL");
  if (!url) {
    throw new Error("COPILOTZ_MIGRATION_DATABASE_URL is required.");
  }
  const db = await openManagedOminipgDatabase({
    url,
    pgPoolMax: 1,
    requestTimeoutMs: 86_400_000,
  });
  try {
    const report = await pruneRetainedHistory(db.session, {
      schema: schema[0],
      eventTypes: values("event-type"),
      actionIds: values("action-id"),
      listUnterminated: Deno.args.includes("--list-unterminated"),
      abandoned: values("abandoned")[0]
        ? JSON.parse(await Deno.readTextFile(values("abandoned")[0]))
        : undefined,
      apply: Deno.args.includes("--apply"),
      writersStopped: Deno.args.includes("--writers-stopped"),
    });
    console.log(JSON.stringify(
      Deno.args.includes("--list-unterminated") ? report.unterminated : report,
      null,
      2,
    ));
  } finally {
    await db.close();
  }
}
