import { assertEquals, assertRejects } from "@std/assert";
import { createOwnerTestDatabase } from "../testing/owner-database.ts";
import { createCopilotz } from "../application/copilotz.ts";
import { defineAction } from "./define.ts";
import type { ActionContext } from "./types.ts";
import { defineCollection } from "../collections/definition.ts";
import { ActionError } from "./errors.ts";
import { secret } from "./secret.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import type { ProtectedActionDefinitions } from "./protected-action-types.ts";
const enabled = Boolean(Deno.env.get("COPILOTZ_OWNER_TEST_POSTGRES_URL"));
for (const begunEffect of [false, true]) {
  Deno.test({
    name:
      `permanent protected Action revocation reaches bounded truthful terminal refusal without domain mutation (begun effect: ${begunEffect})`,
    ignore: !enabled,
    async fn() {
      const database = await createOwnerTestDatabase();
      let preparations = 0, executions = 0, resumptions = 0, allowed = true;
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
        ownerHooks: { prepareInput: true },
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            credential: secret({ type: "string" }),
          },
          additionalProperties: false,
        } as const,
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
        ownerHooks: { prepareInput: true },
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            credential: secret({ type: "string" }),
          },
          additionalProperties: false,
        } as const,
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
      const protectedActions: ProtectedActionDefinitions = Object.fromEntries(
        [child, leaf].map((action) => [action.id, {
          authorize() {
            if (!allowed) {
              throw new ActionError("Action access revoked", {
                code: "forbidden",
                status: 403,
              });
            }
          },
          prepareInput(input: unknown) {
            preparations++;
            return { ...input as object, credential: "owner-only-credential" };
          },
        }]),
      );
      const app = await createCopilotz({
        namespace: "resume",
        database,
        actions: { child, leaf },
        collections: { records },
        adapters: { secrets: { default: await testSecretAdapter() } },
        protectedActions,
        engine: { retryBaseMs: 0 },
      });
      try {
        await app.collections.records.create({ id: "record", text: "first" });
        await assertRejects(() =>
          app.actions.child({ text: "first" }, {
            idempotencyKey: "protected-refusal",
          })
        );
        const terminal = await database.query<
          { body: { status: string; error?: { code: string } } }
        >("SELECT COALESCE(body->'data',body) AS body FROM public.event_bodies WHERE COALESCE(body->'data',body)->>'actionId' IN ('resume.child','resume.leaf') AND COALESCE(body->'data',body)->>'status' IN ('failed','cancelled','completed')");
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
        assertEquals({ preparations, executions }, {
          preparations: 2,
          executions: 1,
        });
      } finally {
        await app.close();
        await database.close();
      }
    },
  });
}
