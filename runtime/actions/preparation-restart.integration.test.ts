import { assertEquals, assertRejects } from "@std/assert";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { createCopilotz } from "../application/copilotz.ts";
import { defineAction } from "./define.ts";
import type { ActionContext } from "./types.ts";
import { defineCollection } from "../collections/definition.ts";
import { defineView } from "../views/definition.ts";
import type { ActionPreparations } from "./preparation.ts";
const enabled = Boolean(Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL"));
Deno.test({
  name:
    "embedded restart retains named Event Body input, reauthorizes parent result and rejects corrupt provenance",
  ignore: !enabled,
  async fn() {
    const database = await createOwnerTestDatabase();
    let renders = 0, executions = 0, allowed = true, prefix = "original";
    const records = defineCollection({
      name: "restart_record",
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          namespace: { type: "string" },
          text: { type: "string" },
        },
        required: ["id", "namespace", "text"],
      } as const,
    });
    const child = defineAction({
      id: "restart.child",
      execute: (input: { text: string }) => {
        executions++;
        return input.text;
      },
    });
    const run = defineAction({
      id: "restart.parent",
      execute: (_input: unknown, ctx: ActionContext) =>
        ctx.actions.child.prepareNamed({
          preparation: "note",
          recordId: "record",
          mode: "context",
        }, { operationKey: "prompt" }),
    });
    const preparations: ActionPreparations = {
      registrations: {
        note: {
          source: "records",
          actionAlias: "child",
          shows: "note",
          modes: ["context"],
          resources: [{ namespace: "presentation", alias: "style" }],
          mapInput: (text) => ({ text }),
        },
      },
      source: {
        sources: { records: { collectionAlias: "records", fields: ["/text"] } },
        authorize: () => ({ namespace: "restart", audience: "member" }),
        projectRecord: (record) => record,
        authorizeOriginal: () => allowed,
      },
      projectResource: (_tx, { value }) => value as { prefix: string },
      authorizeResource: () => allowed,
      authorizeView: () => allowed,
    };
    const build = () =>
      createCopilotz({
        namespace: "restart",
        database,
        actions: { run, child },
        collections: { records },
        resources: { presentation: { style: { prefix } } },
        views: {
          note: defineView({
            id: "restart.note",
            shows: "note",
            renderer: "text",
            modes: ["context"],
            render: (value: unknown, ctx) => {
              renders++;
              return `${
                (ctx.resources.presentation.style as { prefix: string }).prefix
              }:${(value as { record: { text: string } }).record.text}`;
            },
          }),
        },
        engine: { preparations, retryBaseMs: 0 },
      });
    let app: Awaited<ReturnType<typeof build>> | undefined;
    try {
      app = await build();
      await app.collections.records.create({ id: "record", text: "first" });
      assertEquals(
        await app.actions.run({}, { idempotencyKey: "stable" }),
        "original:first",
      );
      await app.collections.records.update({
        id: "record",
        set: { text: "changed" },
      });
      await app.close();
      app = undefined;
      prefix = "replacement";
      app = await build();
      assertEquals(
        await app.actions.run({}, { idempotencyKey: "stable" }),
        "original:first",
      );
      assertEquals({ renders, executions }, { renders: 1, executions: 1 });
      allowed = false;
      await assertRejects(
        () => app!.actions.run({}, { idempotencyKey: "stable" }),
        Error,
        "preparation_reference_forbidden",
      );
      // Refused disclosure does not misreport the earlier committed operation.
      assertEquals(
        (await database.query(
          "SELECT count(*)::int AS n FROM public.owner_receipts WHERE kind='actions.prepareNamed'",
        )).rows[0].n,
        1,
      );
      allowed = true;
      await app.close();
      app = undefined;
      const original = (await database.query<{ key: string; result: unknown }>(
        "SELECT key,result FROM public.owner_receipts WHERE kind='actions.prepareNamed'",
      )).rows[0];
      await database.query(
        "UPDATE public.owner_receipts SET result=jsonb_set(result,'{capture,source,source,digest}','\"sha256:2222222222222222222222222222222222222222222222222222222222222222\"') WHERE key=$1",
        [original.key],
      );
      await assertRejects(() => build(), Error, "preparation_capture_invalid");
      await database.query(
        "UPDATE public.owner_receipts SET result=$1::jsonb WHERE key=$2",
        [JSON.stringify(original.result), original.key],
      );
      app = await build();
      assertEquals(
        await app.actions.run({}, { idempotencyKey: "stable" }),
        "original:first",
      );
      assertEquals(renders, 1);
    } finally {
      allowed = true;
      await app?.close();
      await database.close();
    }
  },
});

Deno.test({
  name:
    "named input resumes through an actual child operation with retained original authorization",
  ignore: !enabled,
  async fn() {
    const database = await createOwnerTestDatabase();
    let renders = 0, executions = 0, resumptions = 0;
    const phases: string[] = [];
    const records = defineCollection({
      name: "resume_record",
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          namespace: { type: "string" },
          text: { type: "string" },
        },
        required: ["id", "namespace", "text"],
      } as const,
    });
    const leaf = defineAction({
      id: "resume.leaf",
      async execute(_input: unknown, ctx: ActionContext) {
        await ctx.collections.records.update({
          id: "record",
          set: { text: "replacement" },
        });
        return "leaf";
      },
    });
    const child = defineAction({
      id: "resume.child",
      execute: (input: { text: string }, ctx: ActionContext) => {
        executions++;
        return ctx.awaitOperation({
          start: { action: "leaf", input: {} },
          handoff: { text: input.text },
        });
      },
      resume: (handoff, outcome) => {
        resumptions++;
        assertEquals(outcome.status, "completed");
        return handoff;
      },
    });
    const run = defineAction({
      id: "resume.parent",
      async execute(_input: unknown, ctx: ActionContext) {
        await ctx.actions.child.prepareNamed({
          preparation: "note",
          recordId: "record",
          mode: "context",
        }, { operationKey: "prompt" });
        return "admitted";
      },
    });
    const preparations: ActionPreparations = {
      registrations: {
        note: {
          source: "records",
          actionAlias: "child",
          shows: "note",
          modes: ["context"],
          mapInput: (text) => ({ text }),
        },
      },
      source: {
        sources: { records: { collectionAlias: "records", fields: ["/text"] } },
        authorize: () => ({ namespace: "resume", audience: "member" }),
        projectRecord: (record) => record,
        authorizeOriginal: (_tx, input) => {
          phases.push(input.purpose);
          return true;
        },
      },
      projectResource: () => null,
      authorizeResource: () => true,
      authorizeView: () => true,
    };
    const app = await createCopilotz({
      namespace: "resume",
      database,
      actions: { run, child, leaf },
      collections: { records },
      views: {
        note: defineView({
          id: "resume.note",
          shows: "note",
          renderer: "text",
          modes: ["context"],
          render: (value: unknown) => {
            renders++;
            return (value as { record: { text: string } }).record.text;
          },
        }),
      },
      engine: { preparations, retryBaseMs: 0 },
    });
    try {
      await app.collections.records.create({ id: "record", text: "first" });
      assertEquals(
        await app.actions.run({}, { idempotencyKey: "named-resumption" }),
        "admitted",
      );
      assertEquals({ renders, executions, resumptions }, {
        renders: 1,
        executions: 1,
        resumptions: 1,
      });
      const rows = await database.query<{ body: { output: unknown } }>(
        "SELECT body FROM public.event_bodies WHERE body->>'actionId'='resume.child' AND body->>'status'='completed'",
      );
      assertEquals(rows.rows[0].body.output, { text: "first" });
      for (
        const phase of ["capture", "claim", "input", "mutation", "result"]
      ) assertEquals(phases.includes(phase), true);
    } finally {
      await app.close();
      await database.close();
    }
  },
});

import { secret } from "./secret.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
Deno.test({
  name:
    "named capture joins protected Action input policy in the existing owner command",
  ignore: !enabled,
  async fn() {
    const database = await createOwnerTestDatabase();
    let prepared = 0, authorized = 0, renders = 0;
    const records = defineCollection({
      name: "protected_source",
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          namespace: { type: "string" },
          text: { type: "string" },
        },
        required: ["id", "namespace", "text"],
      } as const,
    });
    const child = defineAction({
      id: "named.protected-child",
      ownerHooks: { prepareInput: true },
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          token: secret({ type: "string" }),
        },
        required: ["text"],
        additionalProperties: false,
      } as const,
      execute: (input: { text: string; token?: string }) => {
        assertEquals(input.token, "owner-secret");
        return input.text;
      },
    });
    const run = defineAction({
      id: "named.protected-parent",
      async execute(_input: unknown, ctx: ActionContext) {
        const request = {
          preparation: "note",
          recordId: "record",
          mode: "context",
        };
        const first = await ctx.actions.child.prepareNamed(request, {
          operationKey: "input",
        });
        assertEquals(
          await ctx.actions.child.prepareNamed(request, {
            operationKey: "input",
          }),
          first,
        );
        return first;
      },
    });
    const preparations: ActionPreparations = {
      registrations: {
        note: {
          source: "records",
          actionAlias: "child",
          shows: "note",
          modes: ["context"],
          mapInput: (text) => ({ text }),
        },
      },
      source: {
        sources: { records: { collectionAlias: "records", fields: ["/text"] } },
        authorize: async (_tx, context) => {
          assertEquals((await context.resolveSource()).ingress?.kind, "host");
          return { namespace: "protected", audience: "member" };
        },
        projectRecord: (record) => record,
        authorizeOriginal: () => true,
      },
      projectResource: () => null,
      authorizeResource: () => true,
      authorizeView: () => true,
    };
    const app = await createCopilotz({
      namespace: "protected",
      database,
      actions: { run, child },
      collections: { records },
      adapters: { secrets: { default: await testSecretAdapter() } },
      views: {
        note: defineView({
          id: "protected.note",
          shows: "note",
          renderer: "text",
          modes: ["context"],
          render: (value: unknown) => {
            renders++;
            return (value as { record: { text: string } }).record.text;
          },
        }),
      },
      protectedActions: {
        [child.id]: {
          async authorize(_input, context) {
            authorized++;
            assertEquals((await context.resolveSource()).ingress?.kind, "host");
          },
          prepareInput(input) {
            prepared++;
            return { ...input as object, token: "owner-secret" };
          },
        },
      },
      engine: { preparations, retryBaseMs: 0 },
    });
    try {
      await app.collections.records.create({ id: "record", text: "safe" });
      assertEquals(
        await app.actions.run({}, { idempotencyKey: "protected-named" }),
        "safe",
      );
      assertEquals({ prepared, renders }, { prepared: 1, renders: 1 });
      assertEquals(authorized > 1, true);
      const receipts = (await database.query<{ kind: string }>(
        "SELECT kind FROM public.owner_receipts WHERE kind IN ('actions.prepareNamed','action.protected-input')",
      )).rows;
      assertEquals(receipts.map((item) => item.kind).sort(), [
        "action.protected-input",
        "actions.prepareNamed",
      ]);
      const bodies =
        (await database.query("SELECT body FROM public.event_bodies")).rows;
      assertEquals(JSON.stringify(bodies).includes("owner-secret"), false);
    } finally {
      await app.close();
      await database.close();
    }
  },
});

for (const begunEffect of [false, true]) {
  Deno.test({
    name:
      `permanent named revocation reaches bounded truthful terminal refusal without domain mutation (begun effect: ${begunEffect})`,
    ignore: !enabled,
    async fn() {
      const database = await createOwnerTestDatabase();
      let renders = 0, executions = 0, resumptions = 0, allowed = true;
      const phases: string[] = [];
      const records = defineCollection({
        name: "resume_record",
        schema: {
          type: "object",
          properties: {
            id: { type: "string" },
            namespace: { type: "string" },
            text: { type: "string" },
          },
          required: ["id", "namespace", "text"],
        } as const,
      });
      const leaf = defineAction({
        id: "resume.leaf",
        async execute(_input: unknown, ctx: ActionContext) {
          if (begunEffect) {
            assertEquals(await ctx.effect.begin("provider"), {
              status: "proceed",
            });
          }
          allowed = false;
          await ctx.collections.records.update({
            id: "record",
            set: { text: "forbidden" },
          });
          return "leaf";
        },
      });
      const child = defineAction({
        id: "resume.child",
        execute: (input: { text: string }, ctx: ActionContext) => {
          executions++;
          return ctx.awaitOperation({
            start: { action: "leaf", input: {} },
            handoff: { text: input.text },
          });
        },
        resume: (handoff, outcome) => {
          resumptions++;
          assertEquals(outcome.status, "completed");
          return handoff;
        },
      });
      const run = defineAction({
        id: "resume.parent",
        async execute(_input: unknown, ctx: ActionContext) {
          await ctx.actions.child.prepareNamed({
            preparation: "note",
            recordId: "record",
            mode: "context",
          }, { operationKey: "prompt" });
          return "admitted";
        },
      });
      const preparations: ActionPreparations = {
        registrations: {
          note: {
            source: "records",
            actionAlias: "child",
            shows: "note",
            modes: ["context"],
            mapInput: (text) => ({ text }),
          },
        },
        source: {
          sources: {
            records: { collectionAlias: "records", fields: ["/text"] },
          },
          authorize: () => ({ namespace: "resume", audience: "member" }),
          projectRecord: (record) => record,
          authorizeOriginal: (_tx, input) => {
            phases.push(input.purpose);
            return allowed;
          },
        },
        projectResource: () => null,
        authorizeResource: () => true,
        authorizeView: () => true,
      };
      const app = await createCopilotz({
        namespace: "resume",
        database,
        actions: { run, child, leaf },
        collections: { records },
        views: {
          note: defineView({
            id: "resume.note",
            shows: "note",
            renderer: "text",
            modes: ["context"],
            render: (value: unknown) => {
              renders++;
              return (value as { record: { text: string } }).record.text;
            },
          }),
        },
        engine: { preparations, retryBaseMs: 0 },
      });
      try {
        await app.collections.records.create({ id: "record", text: "first" });
        await assertRejects(() =>
          app.actions.run({}, { idempotencyKey: "named-refusal" })
        );
        const terminal = await database.query<
          { body: { status: string; error?: { code: string } } }
        >("SELECT body FROM public.event_bodies WHERE body->>'actionId' IN ('resume.child','resume.leaf') AND body->>'status' IN ('failed','cancelled','completed')");
        assertEquals(
          terminal.rows.some((row) => row.body.status === "completed"),
          false,
        );
        assertEquals(terminal.rows.length, 2);
        assertEquals(
          terminal.rows.every((row) =>
            row.body.error?.code ===
              (begunEffect
                ? "effect_indeterminate"
                : "action_authorization_refused")
          ),
          true,
          JSON.stringify(terminal.rows),
        );
        assertEquals(
          (await database.query(
            "SELECT count(*)::int AS n FROM public.open_actions",
          )).rows[0].n,
          0,
        );
        assertEquals(
          (await database.query(
            "SELECT data->>'text' AS text FROM public.nodes WHERE type='resume_record' AND id='record'",
          )).rows[0].text,
          "first",
        );
        assertEquals(resumptions, 0);
        assertEquals(
          (await database.query(
            "SELECT count(*)::int AS n FROM public.action_effects WHERE status='begun'",
          )).rows[0].n,
          begunEffect ? 1 : 0,
        );
        assertEquals(
          (await database.query(
            "SELECT count(*)::int AS n FROM public.event_deliveries WHERE status IN ('pending','leased','retry_wait')",
          )).rows[0].n,
          0,
        );
        assertEquals(
          (await database.query<{ n: number }>(
            "SELECT max(attempts)::int AS n FROM public.event_deliveries",
          )).rows[0].n <= 2,
          true,
        );
        assertEquals({ renders, executions }, { renders: 1, executions: 1 });
      } finally {
        await app.close();
        await database.close();
      }
    },
  });
}
