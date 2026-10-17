import assert from "node:assert/strict";
import { defineCollection } from "../collections/definition.ts";
import { provisionCollectionIndexes } from "../collections/indexes.ts";
import {
  provisionCopilotzSchema,
  quoteEventIdentifier,
} from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { localPostgresUrl } from "../testing/owner-postgres-fixture.ts";
import { validateOwnerGraphSchema } from "./startup-graph-schema.ts";

// Actual storage tests, not part of the isolated pure suite. Set the existing
// disposable PostgreSQL URL to run these same retained cases on PostgreSQL;
// otherwise they use one low-memory PGlite database. Never use a product DB.
const postgres = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();
Deno.test({
  name: `actual ${
    postgres ? "PostgreSQL" : "PGlite"
  } graph catalog baseline and refused mutations`,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn(t) {
    const db = await createTestDatabase(
      postgres
        ? { url: localPostgresUrl(postgres), pgPoolMax: 1 }
        : { url: ":memory:", pgliteMemoryProfile: "low-memory" },
    );
    const schema = `graph_catalog_${crypto.randomUUID().replaceAll("-", "")}`;
    const q = quoteEventIdentifier(schema);
    const restored = new Error("Rollback this disposable catalog mutation.");
    const rejectMutation = async (
      mutate: (tx: SqlExecutor) => Promise<void>,
    ) => {
      try {
        await db.transaction(async (tx) => {
          await mutate(tx);
          await assert.rejects(
            () => validateOwnerGraphSchema(tx, schema, []),
            /Owner graph schema is incompatible/,
          );
          throw restored;
        });
      } catch (error) {
        if (error !== restored) throw error;
      }
      await validateOwnerGraphSchema(db, schema, []);
    };
    try {
      await provisionCopilotzSchema(db, schema);
      const baseline = await t.step(
        "actual provisioned graph baseline passes",
        async () => {
          await validateOwnerGraphSchema(db, schema, []);
        },
      );
      if (!baseline) return;
      await t.step("weakened source-identity predicate refuses", async () => {
        await rejectMutation(async (tx) => {
          await tx.query(`DROP INDEX ${q}."nodes_identity_unique_idx"`);
          await tx.query(
            `CREATE UNIQUE INDEX "nodes_identity_unique_idx" ON ${q}.nodes(namespace,type,source_type,source_id) WHERE source_type IS NOT NULL`,
          );
        });
      });
      await t.step("deceptively named predicate function refuses", async () => {
        await rejectMutation(async (tx) => {
          await tx.query(
            `CREATE FUNCTION ${q}."source_typeISNOTNULLANDsource_idISNOTNULL"() RETURNS boolean LANGUAGE sql IMMUTABLE AS 'SELECT true'`,
          );
          await tx.query(`SET LOCAL search_path TO ${q},pg_catalog`);
          await tx.query(`DROP INDEX ${q}."nodes_identity_unique_idx"`);
          await tx.query(
            `CREATE UNIQUE INDEX "nodes_identity_unique_idx" ON ${q}.nodes(namespace,type,source_type,source_id) WHERE "source_typeISNOTNULLANDsource_idISNOTNULL"()`,
          );
        });
      });
      await t.step("source-identity INCLUDE attributes refuse", async () => {
        await rejectMutation(async (tx) => {
          await tx.query(`DROP INDEX ${q}."nodes_identity_unique_idx"`);
          await tx.query(
            `CREATE UNIQUE INDEX "nodes_identity_unique_idx" ON ${q}.nodes(namespace,type,source_type,source_id) INCLUDE(id) WHERE source_type IS NOT NULL AND source_id IS NOT NULL`,
          );
        });
      });
      await t.step("nonbaseline column collation refuses", async () => {
        await rejectMutation(async (tx) => {
          await tx.query(
            `ALTER TABLE ${q}.nodes ALTER COLUMN namespace TYPE text COLLATE "C"`,
          );
        });
      });
      await t.step("inheritance from an empty parent refuses", async () => {
        await rejectMutation(async (tx) => {
          await tx.query(`CREATE TABLE ${q}.empty_parent()`);
          await tx.query(`ALTER TABLE ${q}.nodes INHERIT ${q}.empty_parent`);
        });
      });
      await t.step(
        "missing or shadowed timestamp default refuses",
        async () => {
          await rejectMutation(async (tx) => {
            await tx.query(
              `ALTER TABLE ${q}.nodes ALTER COLUMN created_at DROP DEFAULT`,
            );
          });
          await rejectMutation(async (tx) => {
            await tx.query(
              `CREATE FUNCTION ${q}.now() RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$SELECT '2026-10-17T00:00:00Z'::timestamptz$$`,
            );
            await tx.query(`SET LOCAL search_path TO ${q},pg_catalog`);
            await tx.query(
              `ALTER TABLE ${q}.nodes ALTER COLUMN created_at SET DEFAULT now()`,
            );
          });
        },
      );
      await t.step(
        "declared indexes refuse until explicitly provisioned",
        async () => {
          const definition = defineCollection({
            name: "note",
            schema: {
              type: "object",
              properties: { title: { type: "string" } },
            },
            indexes: ["title"],
          });
          await assert.rejects(
            () => validateOwnerGraphSchema(db, schema, [definition]),
            /Collection indexes missing/,
          );
          await provisionCollectionIndexes(db, schema, [definition]);
          await validateOwnerGraphSchema(db, schema, [definition]);
        },
      );
    } finally {
      await db.query(`DROP SCHEMA IF EXISTS ${q} CASCADE`);
      await db.close();
    }
  },
});
