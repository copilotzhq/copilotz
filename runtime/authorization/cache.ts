/** Private owner memory. SQL authority and the owner's epoch fence remain in commands. */
import {
  afterSqlCommit,
  bindSqlTransactionAlias,
  type SqlExecutor,
} from "../events/session.ts";
import type { AuthorityDependency } from "./authority.ts";

type Stamp = readonly (readonly [string, number])[];
export type AuthorizationCacheEntry<T> = { value: T; stamp: Stamp };
export class OwnerAuthorizationCache {
  private versions = new Map<string, number>();
  private generation = 0;
  readonly pending = new Map<string, number>();
  observe?: (cache: string, result: string) => void;
  readonly grants = new Map<
    object,
    Map<string, AuthorizationCacheEntry<unknown>>
  >();
  stamp(keys: readonly string[]): Stamp {
    return [
      ["*", this.generation],
      ...keys.map((key) => [key, this.versions.get(key) ?? 0] as const),
    ];
  }
  valid(stamp: Stamp): boolean {
    return stamp.every(([key, version]) =>
      !this.pending.has(key) &&
      version === (key === "*" ? this.generation : this.versions.get(key) ?? 0)
    );
  }
  invalidate(keys: readonly string[]) {
    for (const key of keys) {
      this.versions.set(key, (this.versions.get(key) ?? 0) + 1);
    }
    if (this.versions.size > 8192) this.clear();
  }
  clear() {
    this.generation++;
    this.versions.clear();
    this.grants.clear();
  }
}
type Context = {
  owner: OwnerAuthorizationCache;
  changes?: readonly AuthorityDependency[];
  rowChanges?: Map<
    string,
    readonly string[] | ((rows: Record<string, unknown>[]) => readonly string[])
  >;
  epoch?: number;
  reads: Map<string, AuthorizationCacheEntry<Promise<unknown>>>;
  grants: Map<object, Map<string, AuthorizationCacheEntry<unknown>>>;
};
const contexts = new WeakMap<SqlExecutor, Context>();
const tableKey = (schema: string, table: string) =>
  JSON.stringify([schema, table]);
const recordKey = (
  schema: string,
  dependency: AuthorityDependency,
  set = false,
) =>
  JSON.stringify([
    schema,
    "record",
    dependency.namespace,
    dependency.collection,
    set ? null : dependency.id ?? null,
  ]);
export function authorizationDependencyKeys(
  schema: string,
  dependencies: readonly AuthorityDependency[],
): string[] {
  return dependencies.flatMap((dependency) => {
    const table = dependency.collection.startsWith("@authorization/")
      ? dependency.collection === "@authorization/session"
        ? "authorization_sessions"
        : "authorization_effects"
      : "nodes";
    return [
      tableKey(schema, table),
      ...(table === "nodes" ? [recordKey(schema, dependency)] : []),
    ];
  });
}
export const authorizationTableKey = tableKey;

/** The table key is only a fallback fence for unclassified writes. */
export function authorizationRowKeys(
  schema: string,
  table: string,
  id: string,
): string[] {
  return [tableKey(schema, table), JSON.stringify([schema, table, id])];
}
export function authorizationOwnerEpoch(
  transaction: SqlExecutor,
): number | undefined {
  return contexts.get(transaction)?.epoch;
}
/** Classify the next SQL statement from the command that owns its write set. */
export function hintAuthorizationRows(
  transaction: SqlExecutor,
  schema: string,
  table: string,
  ids:
    | readonly string[]
    | ((rows: Record<string, unknown>[]) => readonly string[]),
): void {
  const context = contexts.get(transaction);
  if (context) {
    (context.rowChanges ??= new Map()).set(tableKey(schema, table), ids);
  }
}

/** Known Collection projections supply exact point/set invalidation; raw writes fall back to the table. */
export function hintAuthorizationChanges(
  transaction: SqlExecutor,
  changes: readonly AuthorityDependency[],
) {
  const context = contexts.get(transaction);
  if (context) context.changes = changes;
}
export function bindAuthorizationCacheAlias(
  alias: SqlExecutor,
  source: SqlExecutor,
) {
  const context = contexts.get(source);
  if (context) contexts.set(alias, context);
}
/** Mutation targets, including writable CTEs; row identities come from owning commands. */
export function authorizationSqlWrites(
  sql: string,
  defaultSchema: string,
): { schema: string; table: string }[] {
  const writes: { schema: string; table: string }[] = [];
  for (
    const match of sql.matchAll(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:("\w+"|\w+)\s*\.\s*)?("\w+"|\w+)/gi,
    )
  ) {
    // ON CONFLICT ... DO UPDATE SET belongs to the INSERT target.
    if (/^UPDATE\s+SET\b/i.test(match[0])) continue;
    const identifier = (value: string) =>
      value.startsWith('"') ? value.slice(1, -1) : value.toLowerCase();
    writes.push({
      schema: match[1] ? identifier(match[1]) : defaultSchema,
      table: identifier(match[2]),
    });
  }
  return writes;
}

export function observeAuthorizationWrites(
  transaction: SqlExecutor,
  owner: OwnerAuthorizationCache,
  defaultSchema: string,
  epoch?: number,
): SqlExecutor {
  if (contexts.get(transaction)?.owner === owner) return transaction;
  const context: Context = {
    owner,
    epoch,
    reads: new Map(),
    grants: new Map(),
  };
  const observed: SqlExecutor = {
    async query<TRow extends Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) {
      const changes = context.changes;
      context.changes = undefined;
      const rowChanges = context.rowChanges;
      context.rowChanges = undefined;
      const pending = new Map<
        string,
        (rows: Record<string, unknown>[]) => readonly string[]
      >();
      const keys: string[] = [];
      // Maintenance/DDL can affect several tables or invoke opaque mutations.
      if (/^\s*(?:TRUNCATE|ALTER|DROP|MERGE|CALL|DO)\b/i.test(sql)) {
        owner.clear();
      }
      // Observe both direct mutations and writable CTEs. Unqualified tables
      // belong to this owner; manifest projections may change additional nodes.
      for (
        const { schema, table } of authorizationSqlWrites(sql, defaultSchema)
      ) {
        const fallback = tableKey(schema, table);
        const rows = rowChanges?.get(fallback);
        if (rows !== undefined) {
          if (typeof rows === "function") pending.set(fallback, rows);
          else {
            for (const id of rows) {
              keys.push(JSON.stringify([schema, table, id]));
            }
          }
          continue;
        }
        // An opaque event deletion can cascade to its delivery rows. Known
        // event appends use row hints and do not disturb existing leases.
        if (table === "events" && /\bDELETE\s+FROM\b/i.test(sql)) {
          keys.push(tableKey(schema, "event_deliveries"));
        }
        if (table === "nodes" && changes) {
          for (const change of changes) {
            keys.push(
              recordKey(schema, change),
              recordKey(schema, change, true),
            );
          }
        } else keys.push(tableKey(schema, table));
      }
      // Invalidate before issuing SQL, including failed/rolled-back mutations.
      // This also prevents a concurrent read in this command from reusing stale data.
      owner.invalidate(keys);
      // Returned write sets (e.g. scope cancellation) are unknown until SQL
      // completes. Fence reuse while pending, then invalidate only those rows.
      for (const key of pending.keys()) {
        owner.pending.set(key, (owner.pending.get(key) ?? 0) + 1);
      }
      try {
        const result = await transaction.query<TRow>(sql, params);
        for (const [key, ids] of pending) {
          const [schema, table] = JSON.parse(key) as [string, string];
          owner.invalidate(
            ids(result.rows).map((id) => JSON.stringify([schema, table, id])),
          );
        }
        return result;
      } catch (error) {
        owner.invalidate([...pending.keys()]);
        throw error;
      } finally {
        for (const key of pending.keys()) {
          const count = owner.pending.get(key)! - 1;
          if (count) owner.pending.set(key, count);
          else owner.pending.delete(key);
        }
      }
    },
  };
  bindSqlTransactionAlias(observed, transaction);
  contexts.set(observed, context);
  return observed;
}

/** No memoization outside a managed owner command. Each caller gets a detached row. */
export async function memoAuthorizationRead<T>(
  transaction: SqlExecutor,
  key: string,
  keys: readonly string[],
  read: () => Promise<T>,
): Promise<T> {
  const context = contexts.get(transaction);
  if (!context) return await read();
  let entry = context.reads.get(key);
  if (!entry || !context.owner.valid(entry.stamp)) {
    entry = {
      stamp: context.owner.stamp(keys),
      value: Promise.resolve().then(read),
    };
    context.reads.set(key, entry);
  }
  return structuredClone(await entry.value) as T;
}
export function cachedAuthorization<T>(
  transaction: SqlExecutor,
  scope: object,
  key: string,
): T | undefined {
  const context = contexts.get(transaction);
  const entry = context?.grants.get(scope)?.get(key) ??
    context?.owner.grants.get(scope)?.get(key);
  const valid = entry && context!.owner.valid(entry.stamp);
  context?.owner.observe?.(
    (scope as { cache?: string }).cache ?? "other",
    !entry ? "absent" : valid ? "hit" : "stale",
  );
  return valid ? entry.value as T : undefined;
}
export function rememberAuthorization<T>(
  transaction: SqlExecutor,
  scope: object,
  key: string,
  value: T,
  keys: readonly string[],
) {
  const context = contexts.get(transaction);
  if (!context) return;
  const entry = { value, stamp: context.owner.stamp(keys) };
  let local = context.grants.get(scope);
  if (!local) context.grants.set(scope, local = new Map());
  local.set(key, entry);
  // Speculative grants are private to this command. Savepoint/outer rollback
  // discards them; only confirmed commits can publish into owner memory.
  afterSqlCommit(transaction, () => {
    if (!context.owner.valid(entry.stamp)) return;
    let shared = context.owner.grants.get(scope);
    if (!shared) context.owner.grants.set(scope, shared = new Map());
    if (shared.size >= 1024) shared.delete(shared.keys().next().value!);
    if (context.owner.grants.size > 1024) context.owner.clear();
    shared.set(key, entry);
  });
}

/** Package-only diagnostic seam; observation grants no SQL or authorization authority. */
export function observeAuthorizationCache(
  transaction: SqlExecutor,
  observer: (cache: string, result: string) => void,
): () => void {
  const owner = contexts.get(transaction)?.owner;
  if (!owner) throw new Error("An owner command is required.");
  const previous = owner.observe;
  owner.observe = observer;
  return () => {
    owner.observe = previous;
  };
}
export function reportAuthorizationCache(
  transaction: SqlExecutor,
  cache: string,
  result: string,
): void {
  contexts.get(transaction)?.owner.observe?.(cache, result);
}

/** Immutable owner-observed facts, invalidated by the same writes as decisions. */
const recordReads = { cache: "authorization-record" };
export async function readAuthorizationRecord<T>(
  transaction: SqlExecutor,
  schema: string,
  dependency: AuthorityDependency,
  read: () => Promise<T>,
): Promise<T> {
  const key = JSON.stringify([schema, dependency]);
  const saved = cachedAuthorization<{ value: T }>(
    transaction,
    recordReads,
    key,
  );
  if (saved) return structuredClone(saved.value);
  const context = contexts.get(transaction);
  const keys = authorizationDependencyKeys(schema, [dependency]);
  const stamp = context?.owner.stamp(keys);
  const value = await memoAuthorizationRead(transaction, key, keys, read);
  if (stamp && context?.owner.valid(stamp)) {
    rememberAuthorization(transaction, recordReads, key, {
      value: structuredClone(value),
    }, keys);
  }
  return value;
}
