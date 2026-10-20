import { assertEquals } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { createCoreTableNames, provisionCopilotzSchema } from "./schema.ts";
import { writeEventBody } from "./body-store.ts";
Deno.test("event body writes canonicalize hydrated content refs", async () => {
  const db = await createTestDatabase();
  const schema = "event_body_canonicalization";
  const tables = createCoreTableNames(schema);
  try {
    await provisionCopilotzSchema(db, schema);
    await createSchemaCommandRunner(db, schema)(
      "test.body",
      {},
      (_input, { transaction }) =>
        writeEventBody({ transaction, tables }, {
          namespace: "space",
          id: "body-a",
          json: {
            ref: {
              assetId: "asset-a",
              kind: "text",
              role: "body",
              mediaType: "text/plain",
              value: "hydrated body",
              resolve: true,
              extra: "not durable",
            },
            metadata: {
              nested: {
                assetId: "asset-b",
                kind: "json",
                role: "attachment",
                mediaType: "application/json",
                value: { hydrated: true },
              },
            },
            ordinary: { label: "kept" },
          },
        }),
    );

    assertEquals(
      (await db.query(`SELECT body FROM ${tables.event_bodies}`)).rows[0].body,
      {
        ref: {
          assetId: "asset-a",
          kind: "text",
          role: "body",
          mediaType: "text/plain",
        },
        metadata: {
          nested: {
            assetId: "asset-b",
            kind: "json",
            role: "attachment",
            mediaType: "application/json",
          },
        },
        ordinary: { label: "kept" },
      },
    );
  } finally {
    await db.close();
  }
});
