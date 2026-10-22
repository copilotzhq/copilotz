import { assert, assertEquals } from "@std/assert";
import { createCopilotz } from "../application/copilotz.ts";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { defineCollection } from "../collections/definition.ts";
import {
  defineProcessor,
  type ProcessorContext,
} from "../plugins/processor.ts";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { bindTestActions, testAuthority } from "../testing/authority.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { observeAuthorizationCache } from "../authorization/cache.ts";
import {
  authorizationRefused,
  type OwnerPolicy,
} from "../authorization/evaluator.ts";

Deno.test("native Processor session turn and concurrent UI reads retain authorization", async () => {
  const db = await createOwnerTestDatabase();
  const calls = 24;
  const ready = Array.from(
    { length: calls },
    () => Promise.withResolvers<void>(),
  );
  const read = Array.from(
    { length: calls },
    () => Promise.withResolvers<void>(),
  );
  const completed = Promise.withResolvers<void>();
  const counts: Record<string, number> = {};
  const evaluations: Record<string, number> = {};
  const seen = new Set<string>();
  const records = defineCollection({
    name: "record",
    ownerPolicy: "required",
    schema: { type: "object" },
  });
  const facts = defineCollection({ name: "fact", schema: { type: "object" } });
  const model = defineAction({
    id: "agent.model",
    async execute(_input: unknown, ctx: ActionContext) {
      for (let i = 0; i < calls; i++) {
        ready[i].resolve();
        assertEquals(
          (await ctx.collections.records.get({ id: "record" }))?.value,
          1,
        );
        await read[i].promise;
      }
      return "done";
    },
  });
  const processor = defineProcessor<
    ProcessorContext<
      Record<string, never>,
      Record<string, never>,
      { model: (input: { prompt: string }) => Promise<unknown> }
    >
  >({
    id: "agent.turn",
    on: [{ eventType: "record.created", data: { record: { id: "trigger" } } }],
    async handle(_event, ctx) {
      try {
        assertEquals(await ctx.actions.model({ prompt: "hello" }), "done");
        completed.resolve();
      } catch (error) {
        completed.reject(error);
        throw error;
      }
    },
  });
  const baseline = Deno.env.get("AUTHZ_REUSE_BASELINE") === "1";
  // Model the product policy adapter; preserve lazy dependencies when forwarding.
  const policy: OwnerPolicy["evaluate"] = async (
    context,
  ) => {
    const { authority, intent, read } = context;
    if (baseline) void context.commandTime;
    seen.add(
      `${authority.principal.kind}|${authority.authorityBasis.kind}|${authority.validity.kind}`,
    );
    const phase = (intent.input as { phase?: string })?.phase ?? "";
    const key = [intent.kind, intent.resource, intent.operation, phase].join(
      "|",
    );
    evaluations[key] = (evaluations[key] ?? 0) + 1;
    for (let i = 0; i < 10; i++) {
      if (!(await read.get("facts", `fact-${i}`))?.allowed) {
        authorizationRefused();
      }
    }
    return {
      actions: { model: {} },
      collections: { records: {} },
      collectionMutations: { records: { create: {} } },
    };
  };
  const app = await createCopilotz({
    namespace: "space",
    database: db,
    collections: { records, facts },
    actions: { model },
    processors: { agent: processor },
    authorization: {
      policies: {
        fixture: {
          revision: "1",
          sources: ["facts"],
          evaluate: (context) =>
            policy(
              baseline ? { ...context } : Object.create(
                Object.getPrototypeOf(context),
                Object.getOwnPropertyDescriptors(context),
              ),
            ),
        },
      },
      collections: { records: { id: "fixture", revision: "1" } },
      actions: { model: { id: "fixture", revision: "1" } },
    },
  });
  const authority = {
    ...testAuthority("public"),
    principal: { kind: "session" as const, id: "member" },
    authorityBasis: { kind: "session" as const, id: "session" },
  };
  const client = bindTestActions(app.collections, authority);
  const run = createSchemaCommandRunner(db, "public");
  try {
    await run("seed", {}, async (_, c) => {
      for (let i = 0; i < 10; i++) {
        await c.transaction.query(
          `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES($1,'space','fact',$1,'{"allowed":true}')`,
          [`fact-${i}`],
        );
      }
      await c.transaction.query(
        `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES('record','space','record','record','{"value":1}')`,
      );
      await c.transaction.query(
        `INSERT INTO public.authorization_sessions(namespace,tenant,id,principal,expires_at) VALUES('space','fixture','session','member',$1)`,
        [new Date(Date.now() + 600_000).toISOString()],
      );
      observeAuthorizationCache(c.transaction, (scope, outcome) => {
        const key = `${scope}.${outcome}`;
        counts[key] = (counts[key] ?? 0) + 1;
      });
    });
    await client.records.create({ id: "trigger", value: 0 });
    await Promise.all([
      completed.promise,
      (async () => {
        for (let i = 0; i < calls; i++) {
          await ready[i].promise;
          assertEquals((await client.records.get({ id: "record" }))?.value, 1);
          read[i].resolve();
        }
      })(),
    ]);
    console.log(
      JSON.stringify({
        nativeTurn: { calls, evaluations, counts, authorities: [...seen] },
      }),
    );
    if (Deno.env.get("AUTHZ_REUSE_BASELINE") !== "1") {
      assertEquals(evaluations["action|model|capture|"], 1);
      assertEquals(evaluations["action|model|authorize|"] ?? 0, 0);
      assertEquals(evaluations["collection|records|get|read"], 2);
      assertEquals(evaluations["collection|records|get|result"], 2);
      assert((counts["evaluation.hit"] ?? 0) >= 4 * (calls - 1));
    }
  } finally {
    for (const gate of read) gate.resolve();
    await app.close();
    await db.close();
  }
});
