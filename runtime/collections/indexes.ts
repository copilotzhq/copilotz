import type { SqlExecutor, SqlSession } from "../events/index.ts";
import {
  createCoreTableNames,
  quoteEventIdentifier,
  validateEventSchemaName,
} from "../events/schema.ts";
import type { CollectionDefinition, CollectionIndex } from "./definition.ts";
import { collectionField, declaredCollectionJsonField } from "./field.ts";

type IndexPlan = Readonly<{
  name: string;
  method: string;
  unique: boolean;
  keys: readonly string[];
  predicate: string;
}>;
type StoredIndex = {
  name: string;
  method: string;
  unique: boolean;
  nulls_not_distinct: boolean;
  valid: boolean;
  ready: boolean;
  keys: string[];
  predicate: string;
};

function literal(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

async function plans(
  definitions: readonly CollectionDefinition[],
): Promise<readonly IndexPlan[]> {
  const result = new Map<string, IndexPlan>();
  for (const definition of definitions) {
    for (const declaration of definition.indexes ?? []) {
      const spec = typeof declaration === "string" || Array.isArray(declaration)
        ? { fields: declaration as string | readonly string[] }
        : declaration as Exclude<CollectionIndex, string | readonly string[]>;
      const fields = typeof spec.fields === "string"
        ? [spec.fields]
        : spec.fields;
      const method = spec.type ?? "btree";
      if (
        !Array.isArray(fields) || !fields.length ||
        new Set(fields).size !== fields.length
      ) {
        throw new TypeError(
          `Collection '${definition.name}' index requires distinct fields.`,
        );
      }
      if (
        !["btree", "gin", "brin"].includes(method) ||
        (spec.unique && method !== "btree")
      ) {
        throw new TypeError(
          `Unsupported Collection index method/uniqueness '${method}'.`,
        );
      }
      const unique = spec.unique === true;
      const keys = method === "gin"
        ? fields.map((field) => declaredCollectionJsonField(definition, field))
        : [
          "namespace",
          ...fields.filter((field) => field !== "namespace")
            .map((field) => collectionField(definition, field).expression),
        ];
      // The tie-breaker lets a backwards scan satisfy descending field + id order.
      // It must not weaken a declared uniqueness constraint.
      if (!unique && method === "btree" && !fields.includes("id")) {
        keys.push("id");
      }
      const predicate = `type = ${literal(definition.name)}`;
      const signature = JSON.stringify({ method, unique, keys, predicate });
      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(signature),
        ),
      );
      const name = "collection_idx_" +
        Array.from(digest.slice(0, 16), (b) => b.toString(16).padStart(2, "0"))
          .join("");
      result.set(name, { name, method, unique, keys, predicate });
    }
  }
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// pg_get_indexdef adds redundant parentheses and text casts. Compare the tokens
// of our restricted generated expressions, preserving quoted literal contents.
function normalized(expression: string): string {
  return (expression.match(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|::text\b(?:\[\])?|[()]|[^\s()]+/g,
  ) ?? [])
    .filter((token) =>
      token !== "(" && token !== ")" && token !== "::text" &&
      token !== "::text[]"
    )
    .map((token) => token.startsWith('"') ? token.slice(1, -1) : token)
    .join("");
}

async function existing(
  executor: SqlExecutor,
  schema: string,
  expected: readonly IndexPlan[],
): Promise<Map<string, StoredIndex>> {
  const rows = (await executor.query<StoredIndex>(
    `SELECT idx.relname AS name, am.amname AS method, i.indisunique AS unique,
            i.indisvalid AS valid, i.indisready AS ready, i.indnullsnotdistinct AS nulls_not_distinct,
            ARRAY(SELECT pg_get_indexdef(i.indexrelid, n, true)
                  FROM generate_series(1, i.indnkeyatts) n ORDER BY n) AS keys,
            pg_get_expr(i.indpred, i.indrelid) AS predicate
       FROM pg_index i JOIN pg_class idx ON idx.oid = i.indexrelid
       JOIN pg_class tab ON tab.oid = i.indrelid
       JOIN pg_namespace ns ON ns.oid = tab.relnamespace
       JOIN pg_am am ON am.oid = idx.relam
      WHERE ns.nspname = $1 AND tab.relname = 'nodes'`,
    [schema],
  )).rows;
  const byName = new Map(rows.map((row) => [row.name, row]));
  const same = (stored: StoredIndex, plan: IndexPlan) =>
    stored.valid && stored.ready && !stored.nulls_not_distinct &&
    stored.unique === plan.unique &&
    stored.method === plan.method &&
    normalized(stored.predicate ?? "") === normalized(plan.predicate) &&
    JSON.stringify(stored.keys.map(normalized)) ===
      JSON.stringify(plan.keys.map(normalized));
  const matched = new Map<string, StoredIndex>();
  for (const plan of expected) {
    const named = byName.get(plan.name);
    if (named && !same(named, plan)) {
      throw new Error(
        `Collection index '${schema}.${plan.name}' is invalid or differs from its declaration; repair it explicitly before provisioning.`,
      );
    }
    // Reuse an equivalent operator-provisioned index even under another name.
    const stored = named ?? rows.find((row) => same(row, plan));
    if (stored) matched.set(plan.name, stored);
  }
  return matched;
}

/** Read-only readiness check; request-path schema selection never performs DDL. */
export async function validateCollectionIndexes(
  executor: SqlExecutor,
  schemaName: string,
  definitions: readonly CollectionDefinition[],
): Promise<void> {
  const schema = validateEventSchemaName(schemaName);
  const expected = await plans(definitions);
  if (!expected.length) return;
  const stored = await existing(executor, schema, expected);
  const missing = expected.filter((index) => !stored.has(index.name));
  if (missing.length) {
    throw Object.assign(
      new Error(
        `Collection indexes missing in '${schema}': ${
          missing.map((i) => i.name).join(", ")
        }. Run provisionCollectionIndexes during database provisioning before serving this schema.`,
      ),
      {
        code: "copilotz_collection_indexes_not_provisioned",
        schema,
        missing: missing.map((index) => index.name),
      },
    );
  }
}

/** Add declared indexes without dropping old indexes or changing stored records. */
export async function provisionCollectionIndexes(
  session: SqlSession,
  schemaName: string,
  definitions: readonly CollectionDefinition[],
  options: Readonly<{ concurrently?: boolean }> = {},
): Promise<void> {
  const schema = validateEventSchemaName(schemaName);
  const expected = await plans(definitions);
  if (!expected.length) return;
  const table = createCoreTableNames(schema).nodes;
  const apply = async (executor: SqlExecutor) => {
    const stored = await existing(executor, schema, expected);
    for (const plan of expected) {
      if (stored.has(plan.name)) continue;
      await executor.query(
        `CREATE ${plan.unique ? "UNIQUE " : ""}INDEX ${
          options.concurrently ? "CONCURRENTLY " : ""
        }${quoteEventIdentifier(plan.name)} ON ${table} USING ${plan.method} (${
          plan.keys.map((key) => `(${key})`).join(", ")
        }) WHERE ${plan.predicate}`,
      );
    }
    await existing(executor, schema, expected);
  };
  if (options.concurrently) {
    // PostgreSQL requires concurrent builds outside a transaction. The host
    // runs one explicit provisioning operation; failures may leave an invalid
    // index, which validation reports for explicit operator repair.
    await apply(session);
  } else {
    await session.transaction(async (transaction) => {
      await transaction.query(
        "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
        [schema, "copilotz-collection-indexes"],
      );
      await apply(transaction);
    });
  }
}
