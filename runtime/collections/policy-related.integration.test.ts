import { assertEquals, assertRejects } from "@std/assert";
import { createFixtureCopilotz as createCopilotz } from "../testing/fixture-commands.test.ts";
import {
  type ActionContext,
  ActionError,
  defineAction,
} from "../actions/index.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { bounded } from "../testing/effect-commit-proxy.ts";
import { defineCollection, relation } from "./definition.ts";

// Host result reconstruction preserves safe name/code/message, not HTTP status
// or the original Error prototype.
async function assertActionForbidden(run: () => Promise<unknown>) {
  const error = await assertRejects(run, Error);
  assertEquals(error.name, "ActionError");
  assertEquals(error.message, "Forbidden");
  assertEquals((error as { code?: unknown }).code, "forbidden");
  return error;
}

Deno.test("unprotected root reads recheck every protected related disclosure after hydration", async () => {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 4,
  });
  const schema = `policy_related_${crypto.randomUUID().replaceAll("-", "")}`;
  let opened = Promise.withResolvers<void>();
  let proceed = Promise.withResolvers<void>();
  let gate = false;
  const secret = defineCollection({
    name: "relatedSecret",
    ownerPolicy: "required",
    schema: {
      type: "object",
      properties: { value: { type: "string" } },
    } as const,
  });
  const root = defineCollection({
    name: "relatedRoot",
    schema: {
      type: "object",
      properties: { secretId: { type: "string" } },
    } as const,
    relations: {
      secret: relation.belongsTo("relatedSecret", "secretId", "linked"),
    },
    queries: {
      selected: {
        async select({ read }) {
          const row = await read.get("relatedSecret", "secret");
          return row ? [row] : [];
        },
      },
    },
  });
  const app = await createCopilotz({
    database: db,
    databaseSchema: schema,
    namespace: "space",
    collections: { root, secret },
    actions: {
      read: defineAction({
        id: "fixture.related",
        async execute(input: unknown, context: ActionContext) {
          if (input === "relations") {
            return await context.collections.root.relations.list({
              id: "root",
            });
          }
          if (input === "named") {
            return await context.collections.root.queries.selected({});
          }
          return await context.collections.root.list({ include: ["secret"] });
        },
      }),
    },
    collectionPolicies: {
      secret: {
        async authorize(intent, context) {
          const current = await context.query(
            `SELECT allowed FROM "${schema}".grants`,
          );
          if (current.rows[0]?.allowed !== true) {
            throw new ActionError("private refusal", {
              code: "forbidden",
              status: 403,
            });
          }
          if (
            gate && intent.phase === "result" &&
            (intent.result as { id?: string })?.id === "secret"
          ) {
            gate = false;
            opened.resolve();
            await proceed.promise;
          }
        },
      },
    },
    hostCommands: {
      grant: {
        namespace: "space",
        principal: "fixture",
        authorize() {},
        async execute(input: { allowed: boolean }, context) {
          await context.query(
            `CREATE TABLE IF NOT EXISTS "${schema}".grants (id text PRIMARY KEY, allowed boolean)`,
          );
          await context.query(
            `INSERT INTO "${schema}".grants VALUES('one',$1) ON CONFLICT(id) DO UPDATE SET allowed=$1`,
            [input.allowed],
          );
          await context.query(
            `INSERT INTO "${schema}".nodes(id,namespace,type,name,data) VALUES('secret','space','relatedSecret','secret','{"value":"private"}'::jsonb),('root','space','relatedRoot','root','{"secretId":"secret"}'::jsonb) ON CONFLICT(id) DO NOTHING`,
          );
          await context.query(
            `INSERT INTO "${schema}".edges(id,namespace,source_node_id,target_node_id,type,data,weight) VALUES('related','space','root','secret','linked','{"sourceType":"relatedRoot","targetType":"relatedSecret","metadata":{}}'::jsonb,1) ON CONFLICT(id) DO NOTHING`,
          );
          return true;
        },
      },
    },
  });
  try {
    for (const method of ["include", "named", "relations"]) {
      await app.hostCommands.invoke("grant", { allowed: true });
      assertEquals((await app.actions.read(method) as unknown[]).length, 1);
      opened = Promise.withResolvers<void>();
      proceed = Promise.withResolvers<void>();
      gate = true;
      const read = bounded(app.actions.read(method), `${method} disclosure`);
      void read.catch(() => undefined);
      await bounded(opened.promise, `${method} hydration gate`);
      // Queue revocation while hydration holds the owner, before its fresh gate.
      const revoked = app.hostCommands.invoke("grant", { allowed: false });
      proceed.resolve();
      await revoked;
      await assertActionForbidden(() => read);
    }
  } finally {
    proceed.resolve();
    await app.close();
    await db.close();
  }
});
