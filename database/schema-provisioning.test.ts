import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  clearSchemaCache,
  ensureSchemaProvisioned,
  isSchemaInCache,
  migrateAllSchemas,
  schemaIsProvisioned,
  warmSchemaCache,
} from "./schema-provisioning.ts";

type QueryCall = { sql: string; params?: unknown[] };

class FakeDb {
  calls: QueryCall[] = [];
  currentSchemas = new Set<string>();
  readySchemas = new Set<string>();
  schemas = ["public", "tenant_empty", "tenant_ready"];
  queryDelayMs = 0;

  constructor(
    readySchemas: string[] = [],
    currentSchemas: string[] = [],
  ) {
    this.readySchemas = new Set(readySchemas);
    this.currentSchemas = new Set(currentSchemas);
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }> {
    if (this.queryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.queryDelayMs));
    }
    this.calls.push({ sql, params });
    if (sql.includes("information_schema.schemata")) {
      if (sql.includes("schema_name = $1")) {
        return {
          rows: [{
            exists: this.schemas.includes(String(params?.[0])),
          }] as unknown as T[],
        };
      }
      return {
        rows: this.schemas.map((schema_name) => ({
          schema_name,
        })) as unknown as T[],
      };
    }
    if (sql.includes("information_schema.tables")) {
      const schema = String(params?.[0]);
      return {
        rows: [{
          table_count: this.readySchemas.has(schema) ? 4 : 0,
        }] as unknown as T[],
      };
    }
    if (sql.includes("information_schema.columns")) {
      const schema = String(params?.[0]);
      return {
        rows: [{
          exists: this.currentSchemas.has(schema),
        }] as unknown as T[],
      };
    }
    return { rows: [] };
  }
}

Deno.test("schemaIsProvisioned requires core Copilotz tables", async () => {
  const db = new FakeDb(["tenant_ready"]);
  assertEquals(await schemaIsProvisioned(db as never, "tenant_empty"), false);
  assertEquals(await schemaIsProvisioned(db as never, "tenant_ready"), true);
});

Deno.test("ensureSchemaProvisioned migrates an existing empty schema", async () => {
  clearSchemaCache();
  const db = new FakeDb();

  await ensureSchemaProvisioned(db as never, "tenant_empty");

  assert(
    db.calls.some((call) =>
      call.sql.includes('CREATE SCHEMA IF NOT EXISTS "tenant_empty"')
    ),
  );
  assert(
    db.calls.some((call) =>
      call.sql.includes('SET LOCAL search_path TO "tenant_empty", public')
    ),
  );
  assertEquals(isSchemaInCache("tenant_empty"), true);
});

Deno.test("ensureSchemaProvisioned repairs runtime columns on an existing ready schema", async () => {
  clearSchemaCache();
  const db = new FakeDb(["tenant_ready"]);

  await ensureSchemaProvisioned(db as never, "tenant_ready");

  assert(
    db.calls.some((call) =>
      call.sql.includes('SET LOCAL search_path TO "tenant_ready", public')
    ),
  );
  assertEquals(isSchemaInCache("tenant_ready"), true);
});

Deno.test("ensureSchemaProvisioned does not run DDL for a current schema", async () => {
  clearSchemaCache();
  const db = new FakeDb(["tenant_ready"], ["tenant_ready"]);

  await ensureSchemaProvisioned(db as never, "tenant_ready");

  assertEquals(
    db.calls.some((call) => call.sql.includes("ALTER TABLE")),
    false,
  );
  assertEquals(isSchemaInCache("tenant_ready"), true);
});

Deno.test("ensureSchemaProvisioned runs runtime index DDL on existing schemas", async () => {
  clearSchemaCache();
  const db = new FakeDb(["tenant_ready"], ["tenant_ready"]);

  await ensureSchemaProvisioned(db as never, "tenant_ready");

  assertEquals(
    db.calls.some((call) =>
      call.sql.includes("CREATE INDEX") &&
      call.sql.includes("idx_nodes_admin_llm_attempt_time")
    ),
    true,
  );
  assertEquals(isSchemaInCache("tenant_ready"), true);
});

Deno.test("ensureSchemaProvisioned coalesces concurrent provisioning per schema", async () => {
  clearSchemaCache();
  const db = new FakeDb(["tenant_ready"]);
  db.queryDelayMs = 1;

  await Promise.all([
    ensureSchemaProvisioned(db as never, "tenant_ready"),
    ensureSchemaProvisioned(db as never, "tenant_ready"),
  ]);

  const tableChecks = db.calls.filter((call) =>
    call.sql.includes("information_schema.tables") &&
    call.params?.[0] === "tenant_ready"
  );
  assertEquals(tableChecks.length, 1);
  assertEquals(isSchemaInCache("tenant_ready"), true);
});

Deno.test("ensureSchemaProvisioned repairs public before caching it", async () => {
  clearSchemaCache();
  const db = new FakeDb(["public"]);

  assertEquals(isSchemaInCache("public"), false);
  await ensureSchemaProvisioned(db as never, "public");

  assert(
    db.calls.some((call) =>
      call.sql.includes('SET LOCAL search_path TO "public", public')
    ),
  );
  assertEquals(isSchemaInCache("public"), true);
});

Deno.test("warmSchemaCache migrates and caches existing non-system schemas", async () => {
  clearSchemaCache();
  const db = new FakeDb(
    ["public", "tenant_ready"],
    ["public", "tenant_ready"],
  );

  await warmSchemaCache(db as never);

  assertEquals(isSchemaInCache("public"), true);
  assertEquals(isSchemaInCache("tenant_empty"), true);
  assertEquals(isSchemaInCache("tenant_ready"), true);
});

Deno.test("migrateAllSchemas migrates all listed schemas", async () => {
  clearSchemaCache();
  const db = new FakeDb(["tenant_ready"]);

  const result = await migrateAllSchemas(db as never);

  assertEquals(result.schemas, ["public", "tenant_empty", "tenant_ready"]);
  assert(
    db.calls.some((call) =>
      call.sql.includes('SET LOCAL search_path TO "public", public')
    ),
  );
  assert(
    db.calls.some((call) =>
      call.sql.includes('SET LOCAL search_path TO "tenant_empty", public')
    ),
  );
  assert(
    db.calls.some((call) =>
      call.sql.includes('SET LOCAL search_path TO "tenant_ready", public')
    ),
  );
});
