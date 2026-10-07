import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  provisionCopilotzSchema,
  quoteEventIdentifier,
  type SqlSession,
} from "../runtime/events/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import {
  parseHistoryProvisionArgs,
  runHistoryProvision,
} from "./provision-core-history.ts";

const POSTGRES_URL = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")?.trim();

Deno.test({
  name:
    "native history provisioning applies concurrently, retains records, and is repeatable",
  ignore: !POSTGRES_URL,
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    const schema = `history_cli_${crypto.randomUUID().replaceAll("-", "")}`;
    const database = await createTestDatabase({ url: POSTGRES_URL! });
    try {
      await provisionCopilotzSchema(database, schema);
      const nodes = `${quoteEventIdentifier(schema)}.nodes`;
      await database.query(
        `INSERT INTO ${nodes} (id, namespace, type, name, data)
        VALUES ('message', 'tenant', 'message', '', '{"threadId":"thread"}')`,
      );
      const before = await database.query(`SELECT * FROM ${nodes}`);
      const options = { apply: true, schemas: [schema] };
      const report = {
        mode: "apply" as const,
        schemas: [{ schema, indexPresent: true, indexValid: true }],
      };
      assertEquals(await runHistoryProvision(database, options), report);
      assertEquals(await runHistoryProvision(database, options), report);
      assertEquals(await database.query(`SELECT * FROM ${nodes}`), before);
    } finally {
      await database.query(
        `DROP SCHEMA IF EXISTS ${quoteEventIdentifier(schema)} CASCADE`,
      );
      await database.close();
    }
  },
});

Deno.test("history provisioning selects explicit schemas and requires --apply for mutation", () => {
  assertEquals(
    parseHistoryProvisionArgs([
      "--schema",
      "tenant_b",
      "--schema",
      "tenant_a",
      "--schema",
      "tenant_b",
    ]),
    { apply: false, schemas: ["tenant_a", "tenant_b"], help: false },
  );
  assertEquals(
    parseHistoryProvisionArgs(["--schema", "tenant_a", "--apply"]).apply,
    true,
  );
  for (
    const args of [[], ["--apply"], ["--schema"], ["--schema", "tenant;DROP"], [
      "--schema",
      "tenant",
      "--apply",
      "--apply",
    ]]
  ) {
    assertThrows(() => parseHistoryProvisionArgs(args), TypeError);
  }
});

Deno.test("history provisioning preview is read-only and validates every schema before applying", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    await provisionCopilotzSchema(db, "history_preview");
    const mutations: string[] = [];
    const session: SqlSession = {
      query(sql, params) {
        if (/^(CREATE|ALTER|ANALYZE)/.test(sql)) mutations.push(sql);
        return db.query(sql, params);
      },
      transaction: db.transaction,
    };
    assertEquals(
      await runHistoryProvision(session, {
        apply: false,
        schemas: ["history_preview"],
      }),
      {
        mode: "preview",
        schemas: [{
          schema: "history_preview",
          indexPresent: false,
          indexValid: false,
        }],
      },
    );
    await assertRejects(
      () =>
        runHistoryProvision(session, {
          apply: true,
          schemas: ["history_preview", "missing_history"],
        }),
      Error,
      "not provisioned",
    );
    assertEquals(mutations, []);
  } finally {
    await db.close();
  }
});
