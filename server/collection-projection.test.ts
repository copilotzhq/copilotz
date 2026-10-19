import { assertEquals, assertRejects } from "@std/assert";
import { createCopilotz } from "../create-copilotz.ts";
import { createCopilotzClient } from "../client/index.ts";
import { ActionError } from "../runtime/actions/index.ts";
import { defineCollection } from "../runtime/collections/definition.ts";
import type { CollectionProjectionContext } from "../runtime/collections/projection-types.ts";
import { validateCollectionProjections } from "../runtime/collections/projection-registration.ts";
import { definePlugin } from "../runtime/plugins/index.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { serverPlugin } from "../plugins/server/plugin.ts";
import { defineServerFacade } from "../plugins/server/resources/facade/index.ts";
import { until } from "../runtime/testing/effect-commit-proxy.ts";

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
  const app = await createCopilotz({
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
    hostCommands: {
      seed: {
        namespace: "space",
        principal: "fixture",
        authorize() {},
        async execute(_input, context) {
          await context.query(
            `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('one','space','projectedEntry','original','{"value":"safe summary"}'::jsonb)`,
          );
          await context.query(
            `CREATE FUNCTION "${schema}".view_attempt_write() RETURNS text LANGUAGE plpgsql AS $$ BEGIN UPDATE "${schema}".nodes SET name='changed' WHERE id='one'; RETURN 'changed'; END $$`,
          );
          return true;
        },
      },
    },
    plugins: [definePlugin({
      ...serverPlugin,
      resources: {
        server: {
          default: defineServerFacade({
            expose: {
              actions: false,
              collections: {
                include: ["projectedEntry"],
                operations: { include: ["query:public", "observe"] },
              },
              channels: false,
            },
            authenticate() {
              return {
                namespace: "space",
                databaseSchema: schema,
                actor: { id: "member" },
                context: {
                  viewer: {
                    kind: "session",
                    subject: "member",
                    expiresAt: 9999999999,
                  },
                },
              };
            },
            authorize() {
              return {};
            },
          }),
        },
      },
    })],
  });
  const command: () => Promise<unknown> = () =>
    app.collections.entry.commands.rename({ id: "one" });
  const client = createCopilotzClient({
    baseUrl: "http://fixture.test/api",
    fetch: (input, init) => app.fetch(new Request(input, init)),
  });
  const abort = new AbortController();
  let observed: unknown;
  let observationError: unknown;
  let done: Promise<unknown> = Promise.resolve();
  try {
    await app.hostCommands.invoke("seed", null);
    assertEquals(
      await client.collections.query("projectedEntry", "public", {
        mode: "read",
      }),
      { data: [{ summary: "safe summary" }] },
    );
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
      await assertRejects(() =>
        client.collections.query("projectedEntry", "public", { mode })
      );
    }
    assertEquals(
      (await db.query(`SELECT name FROM "${schema}".nodes WHERE id='one'`))
        .rows,
      [{ name: "original" }],
    );
    done = client.collections.observe("projectedEntry", {
      queryName: "public",
      input: { mode: "read" },
    }, {
      signal: abort.signal,
      onSnapshot(value) {
        observed = value.value;
      },
    }).catch((error) => {
      observationError = error;
    });
    await until(() => observed || observationError, "named query snapshot");
    if (observationError) throw observationError;
    assertEquals(observed, [{ summary: "safe summary" }]);
    permitted = false;
    await until(() => observationError, "named projection idle revocation");
    assertEquals((observationError as { code: string }).code, "revoked");
  } finally {
    abort.abort();
    await done;
    await app.close();
    await db.close();
  }
});
