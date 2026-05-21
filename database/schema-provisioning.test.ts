import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  clearSchemaCache,
  ensureSchemaProvisioned,
  isSchemaInCache,
  schemaIsProvisioned,
  warmSchemaCache,
} from "./schema-provisioning.ts";

type QueryCall = { sql: string; params?: unknown[] };

class FakeDb {
  calls: QueryCall[] = [];
  readySchemas = new Set<string>();
  schemas = ["public", "tenant_empty", "tenant_ready"];

  constructor(readySchemas: string[] = []) {
    this.readySchemas = new Set(readySchemas);
  }

  async query<T extends Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[]; rowCount?: number }> {
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

Deno.test("warmSchemaCache does not cache empty tenant schemas", async () => {
  clearSchemaCache();
  const db = new FakeDb(["tenant_ready"]);

  await warmSchemaCache(db as never);

  assertEquals(isSchemaInCache("tenant_empty"), false);
  assertEquals(isSchemaInCache("tenant_ready"), true);
});
