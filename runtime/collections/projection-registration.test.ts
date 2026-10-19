import { assertEquals, assertRejects } from "@std/assert";
import { createCopilotzApplication } from "../application/index.ts";
import { ActionError } from "../actions/index.ts";
import { defineCollection } from "./definition.ts";
import type { CollectionProjectionContext } from "./projection-types.ts";
import { validateCollectionProjections } from "./projection-registration.ts";
import { withOwnerCollectionInvocation } from "./policy-invocation.ts";
import { createTestDatabase } from "../testing/ominipg.ts";

const declaration = () =>
  defineCollection({
    name: "projectedEntry",
    ownerPolicy: "required",
    schema: {
      type: "object",
      properties: { value: { type: "string" } },
      required: ["value"],
    } as const,
    commands: { rename: { mutate: () => ({ set: { value: "changed" } }) } },
    queries: {
      public: {
        ownerProjection: true,
        inputSchema: {
          type: "object",
          properties: {
            mode: {
              type: "string",
              enum: [
                "read",
                "write",
                "cte",
                "function-write",
                "collection-command",
                "oversized",
                "bad-schema",
              ],
            },
          },
          required: ["mode"],
          additionalProperties: false,
        },
        outputSchema: {
          type: "array",
          items: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
            additionalProperties: false,
          },
        },
      },
    },
  });
Deno.test("owner projection registration rejects missing and undeclared callbacks", () => {
  const entry = declaration();
  for (
    const supplied of [undefined, { entry: { other: { select: () => [] } } }]
  ) {
    let failed = false;
    try {
      validateCollectionProjections(supplied, { entry });
    } catch {
      failed = true;
    }
    assertEquals(failed, true);
  }
  assertEquals(
    validateCollectionProjections({ entry: { public: { select: () => [] } } }, {
      entry,
    }).get("projectedEntry")?.size,
    1,
  );
});

Deno.test("owner named projections share readonly snapshot, current viewer policy and revoked query lifetime", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 4,
  });
  const schema = `view_projection_${crypto.randomUUID().replaceAll("-", "")}`;
  let retained: CollectionProjectionContext | undefined;
  let permitted = true;
  const app = await createCopilotzApplication({
    database: db,
    databaseSchema: schema,
    namespace: "space",
    collections: { entry: declaration() },
    collectionPolicies: {
      entry: {
        authorize(intent, context) {
          if (
            context.invocation.kind !== "viewer" ||
            context.invocation.actor.id !== "member" ||
            intent.method !== "query" || !permitted
          ) throw new ActionError("Denied", { code: "forbidden", status: 403 });
        },
      },
    },
    collectionProjections: {
      entry: {
        public: {
          async select(input, context) {
            retained = context;
            assertEquals(Object.isFrozen(input), true);
            assertEquals(Object.isFrozen(context.viewer), true);
            assertEquals(context.viewer.actor.id, "member");
            if (input.mode === "write") {
              await context.query(
                `UPDATE "${schema}".nodes SET name='changed' WHERE id='one' RETURNING name`,
              );
            }
            if (input.mode === "cte") {
              await context.query(
                `WITH changed AS (UPDATE "${schema}".nodes SET name='changed' WHERE id='one' RETURNING name) SELECT name FROM changed`,
              );
            }
            if (input.mode === "function-write") {
              await context.query(
                `SELECT "${schema}".view_attempt_write() AS summary`,
              );
            }
            if (input.mode === "collection-command") {
              await command();
            }
            if (input.mode === "oversized") {
              return [{ summary: "x".repeat(1024 * 1024 + 1) }];
            }
            if (input.mode === "bad-schema") {
              return [{ summary: "safe", secret: "must not disclose" }];
            }
            const rows = (await context.query<{ summary: string }>(
              `SELECT data->>'value' AS summary FROM "${schema}".nodes WHERE namespace=$1 AND id='one'`,
              [context.scope.namespace],
            )).rows;
            return rows;
          },
        },
      },
    },
  });
  const command = () =>
    app.collections.withScope({ namespace: "space" }).projectedEntry.commands
      .rename({ id: "one" });
  const read = (mode: string) =>
    withOwnerCollectionInvocation({
      scope: { databaseSchema: schema, namespace: "space" },
      invocation: {
        kind: "viewer",
        id: "member",
        runId: "read",
        actor: { id: "member" },
        claims: {},
      },
      signal: new AbortController().signal,
      check() {},
      resolveSource(): Promise<never> {
        throw new Error("unused");
      },
    }, () =>
      app.collections.readSnapshot({ namespace: "space" }, ({ collections }) =>
        collections.projectedEntry.queries.public({ mode })));
  try {
    await db.query(
      `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('one','space','projectedEntry','original','{"value":"safe summary"}'::jsonb)`,
    );
    await db.query(
      `CREATE FUNCTION "${schema}".view_attempt_write() RETURNS text LANGUAGE plpgsql AS $$ BEGIN UPDATE "${schema}".nodes SET name='changed' WHERE id='one'; RETURN 'changed'; END $$`,
    );
    assertEquals<unknown>(await read("read"), [{ summary: "safe summary" }]);
    await assertRejects(() => retained!.query("SELECT 1"), Error, "closed");
    for (
      const mode of [
        "write",
        "cte",
        "function-write",
        "collection-command",
        "oversized",
        "bad-schema",
      ]
    ) {
      await assertRejects(() => read(mode));
    }
    assertEquals(
      (await db.query(`SELECT name FROM "${schema}".nodes WHERE id='one'`))
        .rows,
      [{ name: "original" }],
    );
    permitted = false;
    const denied = await assertRejects(() => read("read"), ActionError);
    assertEquals(denied.code, "forbidden");
  } finally {
    await app.close();
    await db.close();
  }
});
