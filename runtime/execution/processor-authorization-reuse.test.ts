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

for (
  const { selective, writes } of [{ selective: false, writes: false }, {
    selective: true,
    writes: false,
  }, { selective: true, writes: true }]
) {
  Deno.test(`native Processor session turns and concurrent UI reads: ${selective ? "selective forwarding across requests" : "descriptor forwarding"}${writes ? " with content writes" : ""}`, async () => {
    const db = await createOwnerTestDatabase();
    const calls = 24;
    const turns = selective ? 2 : 1;
    const total = calls * turns;
    let nextCall = 0;
    let nextTurn = 0;
    const ready = Array.from(
      { length: total },
      () => Promise.withResolvers<void>(),
    );
    const read = Array.from(
      { length: total },
      () => Promise.withResolvers<void>(),
    );
    const completed = Array.from(
      { length: turns },
      () => Promise.withResolvers<void>(),
    );
    const counts: Record<string, number> = {};
    const evaluations: Record<string, number> = {};
    const seen = new Set<string>();
    const records = defineCollection({
      name: "record",
      ownerPolicy: "required",
      schema: { type: "object" },
    });
    const facts = defineCollection({
      name: "fact",
      schema: { type: "object" },
    });
    const messages = defineCollection({
      name: "message",
      schema: { type: "object" },
      content: { fields: ["content"] },
    });
    const threads = defineCollection({
      name: "thread",
      schema: { type: "object" },
      commands: {
        recordMessage: {
          mutate: ({ input }) => ({
            set: { lastMessageId: (input as { messageId: string }).messageId },
          }),
        },
      },
    });
    const perTurn: Record<string, number>[] = [];
    const model = defineAction({
      id: "agent.model",
      async execute(_input: unknown, ctx: ActionContext) {
        for (let count = 0; count < calls; count++) {
          const i = nextCall++;
          if (writes && count % 4 === 0) {
            await ctx.collections.messages.create({
              id: `message-${i}`,
              content: `message ${i}`,
            });
            await ctx.transaction(async ({ collections }) => {
              await collections.threads.commands.recordMessage({
                id: "writing-thread",
                messageId: `message-${i}`,
              });
            }, { operationKey: `record-message-${i}` });
            await ctx.content.publish({
              id: `standalone-${i}`,
              mediaType: "text/plain",
              body: new TextEncoder().encode(`body ${i}`),
            }, { operationKey: `asset-${i}` });
          }
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
      on: [{ eventType: "record.created" }],
      async handle(_event, ctx) {
        const turn = nextTurn++;
        try {
          assertEquals(await ctx.actions.model({ prompt: "hello" }), "done");
          completed[turn].resolve();
        } catch (error) {
          completed[turn].reject(error);
          throw error;
        }
      },
    });
    const baseline = Deno.env.get("AUTHZ_REUSE_BASELINE") === "1";
    // Broad reflection deliberately observes all fields. Selective forwarding
    // passes the context directly, preserving the policy's narrower read set.
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
        collections: { records: {}, messages: {}, threads: {} },
        collectionMutations: {
          records: { create: {} },
          messages: { create: {} },
          threads: { commands: { recordMessage: {} } },
        },
      };
    };
    const app = await createCopilotz({
      namespace: "space",
      database: db,
      collections: { records, facts, messages, threads },
      actions: { model },
      processors: { agent: processor },
      authorization: {
        policies: {
          fixture: {
            revision: "1",
            sources: ["facts"],
            evaluate: (context) =>
              policy(
                baseline ? { ...context } : selective ? context : Object.create(
                  Object.getPrototypeOf(context),
                  Object.getOwnPropertyDescriptors(context),
                ),
              ),
          },
        },
        collections: {
          records: { id: "fixture", revision: "1" },
          messages: { id: "fixture", revision: "1" },
          threads: { id: "fixture", revision: "1" },
        },
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
        await c.transaction.query(
          `INSERT INTO public.nodes(id,namespace,type,name,data) VALUES('writing-thread','space','thread','thread','{"createdAt":"2026-01-01T00:00:00.000Z","updatedAt":"2026-01-01T00:00:00.000Z"}')`,
        );
        observeAuthorizationCache(c.transaction, (scope, outcome) => {
          const key = `${scope}.${outcome}`;
          counts[key] = (counts[key] ?? 0) + 1;
        });
      });
      for (let turn = 0; turn < turns; turn++) {
        const startCounts = { ...counts };
        const request = (nonce: string) =>
          bindTestActions(app.collections, {
            ...authority,
            requestFacts: { ...authority.requestFacts, input: { nonce } },
          });
        await (selective ? request(`trigger-${turn}`) : client).records.create({
          id: `trigger-${turn}`,
          value: 0,
        });
        await Promise.all([
          completed[turn].promise,
          (async () => {
            for (let call = 0; call < calls; call++) {
              const i = turn * calls + call;
              await ready[i].promise;
              const ui = selective ? request(`ui-${i}`) : client;
              assertEquals((await ui.records.get({ id: "record" }))?.value, 1);
              read[i].resolve();
            }
          })(),
        ]);
        perTurn.push(
          Object.fromEntries(
            Object.entries(counts).map((
              [key, count],
            ) => [key, count - (startCounts[key] ?? 0)]),
          ),
        );
      }
      console.log(
        JSON.stringify({
          nativeTurn: {
            selective,
            writes,
            perTurn,
            turns,
            calls,
            evaluations,
            counts,
            authorities: [...seen],
          },
        }),
      );
      if (
        Deno.env.get("AUTHZ_REUSE_BASELINE") !== "1" &&
        Deno.env.get("AUTHZ_READSET_BASELINE") !== "1" &&
        Deno.env.get("AUTHZ_WRITESET_BASELINE") !== "1"
      ) {
        assertEquals(evaluations["action|model|capture|"], turns);
        assertEquals(evaluations["action|model|authorize|"] ?? 0, 0);
        assertEquals(
          evaluations["collection|records|get|read"],
          db.concurrentReads ? total * 2 : 2,
        );
        assertEquals(
          evaluations["collection|records|get|result"],
          db.concurrentReads ? total * 2 : 2,
        );
        // Reader transactions evaluate their own view; writer decisions still
        // reuse exact dependency proofs under the serialized owner command.
        if (!db.concurrentReads) {
          assert((counts["evaluation.hit"] ?? 0) >= 4 * (total - 1));
        }
        for (const scope of ["action", "authorization-record", "evaluation"]) {
          assertEquals(counts[`${scope}.stale`] ?? 0, 0, scope);
        }
      }
    } finally {
      for (const gate of read) gate.resolve();
      await app.close();
      await db.close();
    }
  });
}
