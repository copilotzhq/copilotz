import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createCopilotzApplication } from "../application/application.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { testSecretAdapter } from "../testing/secret-adapter.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { defineAction } from "./define.ts";
import { secret } from "./secret.ts";
import type { ActionContext } from "./types.ts";
import type { ActionInvocationFrame } from "./invoker.ts";
import type { ProtectedActionOwnerContext } from "./protected-action-types.ts";
import { resolveProtectedActionParent } from "./protected-action-parent.ts";
import {
  bindActionInvocationParent,
  inheritActionInvocationParent,
} from "./invocation-parent.ts";
const url = Deno.env.get("COPILOTZ_TEST_POSTGRES_URL");
Deno.test({
  name:
    "protected synchronous child resolves retained actual parent, rejects unrelated sibling and unbound frame claims",
  ignore: !url,
  async fn() {
    const db = await createTestDatabase({ url: url!, pgPoolMax: 1 });
    const schema = `parent_scope_${crypto.randomUUID().replaceAll("-", "")}`;
    const observed: ProtectedActionOwnerContext["action"][] = [];
    const child = defineAction({
      id: "fixture.parent-child",
      ownerHooks: { prepareInput: true },
      inputSchema: {
        type: "object",
        properties: { credential: secret({ type: "string" }) },
        additionalProperties: false,
      } as const,
      execute() {
        return true;
      },
    });
    const parent = defineAction({
      id: "fixture.actual-parent",
      execute(_input: unknown, ctx: ActionContext) {
        return ctx.actions.child({}, {
          operationKey: "credential",
          metadata: { parentId: "forged-parent", parentRunId: "forged-run" },
        });
      },
    });
    const actions = { parent, child };
    const app = await createCopilotzApplication({
      database: db,
      databaseSchema: schema,
      namespace: "space",
      actions,
      adapters: { secrets: { default: await testSecretAdapter() } },
      protectedActions: {
        [child.id]: {
          authorize(_input, ctx) {
            observed.push(ctx.action);
            assertEquals(ctx.action.parentId, parent.id);
            assert(ctx.action.parentRunId);
          },
          prepareInput() {
            return { credential: "synthetic-owner-token" };
          },
        },
      },
    });
    try {
      assertEquals(
        await app.host.actions.parent({}, { idempotencyKey: "one" }),
        true,
      );
      const first = observed[0];
      assert(first.parentRunId);
      assertEquals(
        await app.host.actions.parent({}, { idempotencyKey: "two" }),
        true,
      );
      const second = observed.find((item) =>
        item.parentRunId !== first.parentRunId
      )!;
      assert(second);
      const run = createSchemaCommandRunner(db, schema);
      const resolve = (
        frame: Parameters<typeof resolveProtectedActionParent>[0]["frame"],
        namespace = "space",
      ) =>
        run(
          "fixture.parent.resolve",
          {},
          (_, ctx) =>
            resolveProtectedActionParent({
              transaction: ctx.transaction,
              databaseSchema: schema,
              namespace,
              actions,
              frame,
            }),
        );
      const retained = {
        actionId: child.id,
        actionRunId: first.runId,
        parentActionRunId: first.parentRunId,
      };
      assertEquals(await resolve(retained), parent.id);
      await assertRejects(
        () => resolve({ ...retained, parentActionRunId: second.parentRunId }),
        Error,
        "parent binding",
      );
      await assertRejects(
        () => resolve({ ...retained, actionRunId: "forged-child" }),
        Error,
        "parent binding",
      );
      await assertRejects(
        () => resolve(retained, "other"),
        Error,
        "parent binding",
      );
      const frame: ActionInvocationFrame = {
        ...retained,
        rootKey: "root",
        operationKey: first.runId,
        metadata: {},
        signal: new AbortController().signal,
        nextActionIndex: () => 1,
      };
      const parentFrame = {
        ...frame,
        actionId: parent.id,
        actionRunId: first.parentRunId,
        parentActionRunId: undefined,
      };
      const owner = bindActionInvocationParent({
        ...frame,
        actionRunId: "owner-new",
      }, parentFrame);
      const copied = inheritActionInvocationParent(owner, {
        ...owner,
        metadata: { captured: true },
      });
      assertEquals(await resolve(copied), parent.id);
      assertThrows(
        () =>
          inheritActionInvocationParent(owner, {
            ...owner,
            parentActionRunId: second.parentRunId,
          }),
        Error,
        "cannot be replaced",
      );
      assertEquals(
        (await db.query(`SELECT action_run_id FROM "${schema}".open_actions`))
          .rows.length,
        0,
      );
      assertEquals(await resolve(retained), parent.id);
    } finally {
      await app.close();
      await db.close();
    }
  },
});
