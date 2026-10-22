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
export function observeAuthorizationWrites(
  transaction: SqlExecutor,
  owner: OwnerAuthorizationCache,
  defaultSchema: string,
): SqlExecutor {
  if (contexts.get(transaction)?.owner === owner) return transaction;
  const context: Context = { owner, reads: new Map(), grants: new Map() };
  const observed: SqlExecutor = {
    query(sql, params) {
      const changes = context.changes;
      context.changes = undefined;
      const keys: string[] = [];
      // Maintenance/DDL can affect several tables or invoke opaque mutations.
      if (/^\s*(?:TRUNCATE|ALTER|DROP|MERGE|CALL|DO)\b/i.test(sql)) {
        owner.clear();
      }
      // Observe both direct mutations and writable CTEs. Unqualified tables
      // belong to this owner; manifest projections may change additional nodes.
      for (
        const match of sql.matchAll(
          /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM|TRUNCATE(?:\s+TABLE)?)\s+(?:ONLY\s+)?(?:"?(\w+)"?\.)?"?(\w+)"?/gi,
        )
      ) {
        const schema = match[1] ?? defaultSchema, table = match[2];
        if (
          table === "nodes" && changes &&
          !sql.includes("projection_manifest_inserted")
        ) {
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
      return transaction.query(sql, params);
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
  return entry && context!.owner.valid(entry.stamp)
    ? entry.value as T
    : undefined;
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
