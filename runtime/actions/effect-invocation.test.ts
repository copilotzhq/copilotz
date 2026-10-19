import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createOwnerEffectClient } from "./effect-commands.ts";
import { createActionCallers } from "./invoker.ts";
import { defineAction } from "./define.ts";
import type {
  ActionContext,
  ActionEventData,
  ActionInvokedData,
  ActionLifecycleEmitter,
  ActionMap,
} from "./types.ts";
import type { ActionEffectClient } from "./effect-client.ts";

function lifecycle() {
  const receipts = new Map<string, ActionEventData>();
  let crashed = false;
  const emitter: ActionLifecycleEmitter = {
    emit(value) {
      if (crashed && value.status !== "invoked") {
        return Promise.reject(new Error("owner process lost"));
      }
      if (receipts.has(value.deduplicationId)) {
        return Promise.resolve({ deduplicated: true } as never);
      }
      receipts.set(value.deduplicationId, value);
      return Promise.resolve({ deduplicated: false } as never);
    },
    invoked: (run) =>
      Promise.resolve(
        receipts.get(`${run}:action:invoked`) as ActionInvokedData ?? null,
      ),
    terminal: (run) =>
      Promise.resolve(receipts.get(`${run}:action:terminal`) as never ?? null),
  };
  return {
    emitter,
    receipts,
    crash: () => {
      crashed = true;
    },
    restart: () => {
      crashed = false;
    },
  };
}

Deno.test("interruption around begin, provider, confirm and terminal never blindly repeats external dispatch", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "effect_invocation";
  await provisionCopilotzSchema(db, schema);
  try {
    for (const loss of ["begin", "provider", "confirm", "terminal"] as const) {
      const history = lifecycle();
      let dispatches = 0;
      let armed = true;
      const action = defineAction({
        id: "fixture.send",
        async execute(_input: unknown, ctx: ActionContext) {
          const permission = await ctx.effect.begin("send");
          if (permission.status === "replay") return permission.outcome;
          if (permission.status !== "proceed") {
            throw new Error("no dispatch permission");
          }
          dispatches++;
          if (armed && loss === "provider") {
            armed = false;
            history.crash();
            throw new Error("provider accepted but reply lost");
          }
          await ctx.effect.confirm("send", { reference: "accepted" });
          if (armed && loss === "terminal") {
            armed = false;
            history.crash();
            throw new Error("lost before terminal");
          }
          return { reference: "accepted" };
        },
      });
      const create = () =>
        createActionCallers({ send: action }, {
          actionLifecycle: history.emitter,
          signal: new AbortController().signal,
          createInvocationKey: () => loss,
          createContext: ({ frame, actions }) =>
            ({
              signal: frame.signal,
              actions,
              action: {
                id: frame.actionId,
                runId: frame.actionRunId,
                metadata: {},
              },
            }) as ActionContext,
          createEffectClient(frame) {
            const client = createOwnerEffectClient({
              session: db,
              schema,
              namespace: "space",
              actionRunId: frame.actionRunId,
            });
            return {
              ...client,
              async begin(step, options) {
                const value = await client.begin(step, options);
                if (armed && loss === "begin") {
                  armed = false;
                  history.crash();
                  throw new Error("lost committed begin reply");
                }
                return value;
              },
              async confirm(step, value, options) {
                await client.confirm(step, value, options);
                if (armed && loss === "confirm") {
                  armed = false;
                  history.crash();
                  throw new Error("lost committed confirm reply");
                }
              },
            };
          },
        });
      await assertRejects(() => create().send(null));
      history.restart();
      if (loss === "begin" || loss === "provider") {
        const error = await assertRejects(() => create().send(null));
        assertEquals((error as { code?: string }).code, "effect_indeterminate");
      } else assertEquals(await create().send(null), { reference: "accepted" });
      assertEquals(dispatches, loss === "begin" ? 0 : 1);
    }
  } finally {
    await db.close();
  }
});

Deno.test("recovery reconciles removed effect steps before current execute and does not reclassify old contracts", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "effect_recovery_contract";
  try {
    await provisionCopilotzSchema(db, schema);
    for (const original of [true, false]) {
      const history = lifecycle();
      let executed = 0;
      let reconciled = 0;
      const run = original ? "modern:action:send" : "old:action:send";
      const receipt: ActionInvokedData = {
        actionId: "fixture.send",
        actionRunId: run,
        status: "invoked",
        input: null,
        metadata: {},
        ...(original ? { effectProtocol: 1 as const } : {}),
      };
      const action = defineAction({
        id: "fixture.send",
        execute() {
          executed++;
          return "done";
        },
        reconcile(step: string) {
          assertEquals(step, "removed-step");
          reconciled++;
          return { status: "confirmed" as const, outcome: null };
        },
      });
      const callers = createActionCallers({ send: action }, {
        actionLifecycle: history.emitter,
        signal: new AbortController().signal,
        createInvocationKey: () => original ? "modern" : "old",
        createContext: ({ frame }) =>
          ({ signal: frame.signal }) as ActionContext,
        createEffectClient: (frame) =>
          createOwnerEffectClient({
            session: db,
            schema,
            namespace: "space",
            actionRunId: frame.actionRunId,
          }),
      });
      // Obtain the exact host-derived run identity without inferring its encoding.
      const probe = defineAction({
        id: "fixture.send",
        execute() {
          throw new Error("capture");
        },
      });
      const scratch = lifecycle();
      await assertRejects(() =>
        createActionCallers({ send: probe }, {
          actionLifecycle: scratch.emitter,
          signal: new AbortController().signal,
          createInvocationKey: () => original ? "modern" : "old",
          createContext: () => ({}) as ActionContext,
        }).send(null)
      );
      const captured = [...scratch.receipts.values()].find((value) =>
        value.status === "invoked"
      )!;
      history.receipts.set(`${captured.actionRunId}:action:invoked`, {
        ...receipt,
        actionRunId: captured.actionRunId,
      });
      if (original) {
        await createOwnerEffectClient({
          session: db,
          schema,
          namespace: "space",
          actionRunId: captured.actionRunId,
        }).begin("removed-step");
      }
      if (original) {
        assertEquals(await callers.send(null), "done");
        assertEquals(reconciled, 1);
      } else {
        const error = await assertRejects(() => callers.send(null));
        assertEquals((error as { code?: string }).code, "effect_indeterminate");
        assertEquals(executed, 0);
      }
    }
  } finally {
    await db.close();
  }
});

Deno.test("swallowed own effect failures cannot produce success; caught child failures do not poison parents", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "effect_success_guard";
  try {
    await provisionCopilotzSchema(db, schema);
    for (const mode of ["swallowed", "nested"] as const) {
      const history = lifecycle();
      const child = defineAction({
        id: "fixture.child",
        async execute(_input: unknown, ctx: ActionContext) {
          await ctx.effect.begin("send");
          throw new Error("provider reply lost");
        },
      });
      const root = defineAction({
        id: "fixture.root",
        async execute(_input: unknown, ctx: ActionContext) {
          if (mode === "nested") {
            await ctx.actions.child(null).catch(() => undefined);
          } else {
            await ctx.effect.begin("send");
            if (mode === "swallowed") {
              await ctx.effect.begin("send").catch(() => undefined);
            }
          }
          return "must not succeed";
        },
      });
      const actions: ActionMap = { root, child };
      const callers = createActionCallers(actions, {
        actionLifecycle: history.emitter,
        signal: new AbortController().signal,
        createInvocationKey: () => mode,
        createContext: ({ frame, actions }) =>
          ({ signal: frame.signal, actions }) as ActionContext,
        createEffectClient: (frame) =>
          createOwnerEffectClient({
            session: db,
            schema,
            namespace: "space",
            actionRunId: frame.actionRunId,
          }) as ActionEffectClient,
      });
      if (mode === "nested") {
        assertEquals(await callers.root(null), "must not succeed");
        assertEquals(await callers.root(null), "must not succeed");
        continue;
      }
      const error = await assertRejects(() => callers.root(null));
      assertEquals((error as { code?: string }).code, "effect_indeterminate");
      const replayed = await assertRejects(() => callers.root(null));
      assertEquals((replayed as { retryable?: boolean }).retryable, false);
      assertEquals(
        [...history.receipts.values()].some((value) =>
          value.status === "completed"
        ),
        false,
      );
    }
  } finally {
    await db.close();
  }
});

Deno.test("restarted parents may complete independently while descendant effect evidence remains", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = "effect_descendant_recovery";
  try {
    await provisionCopilotzSchema(db, schema);
    const history = lifecycle();
    let rootCalls = 0;
    let sends = 0;
    const child = defineAction({
      id: "fixture.child",
      async execute(_input: unknown, ctx: ActionContext) {
        await ctx.effect.begin("send");
        sends++;
        history.crash();
        throw new Error("process terminated after dispatch");
      },
    });
    const middle = defineAction({
      id: "fixture.middle",
      execute: (_input: unknown, ctx: ActionContext) => ctx.actions.child(null),
    });
    const original = defineAction({
      id: "fixture.root",
      execute(_input: unknown, ctx: ActionContext) {
        rootCalls++;
        return ctx.actions.middle(null);
      },
    });
    const changed = defineAction({
      id: "fixture.root",
      execute() {
        rootCalls++;
        return "new deployment omitted the child";
      },
    });
    const create = (root: typeof original | typeof changed) =>
      createActionCallers({ root, middle, child }, {
        actionLifecycle: history.emitter,
        signal: new AbortController().signal,
        createInvocationKey: () => "root",
        createContext: ({ frame, actions }) =>
          ({ signal: frame.signal, actions }) as ActionContext,
        createEffectClient: (frame) =>
          createOwnerEffectClient({
            session: db,
            schema,
            namespace: "space",
            actionRunId: frame.actionRunId,
          }),
      });
    await assertRejects(() => create(original).root(null));
    history.restart();
    assertEquals(
      await create(changed).root(null),
      "new deployment omitted the child",
    );
    assertEquals(rootCalls, 2);
    const unresolved = await db.query(
      `SELECT status FROM ${schema}.action_effects`,
    );
    assertEquals(unresolved.rows, [{ status: "begun" }]);
    assertEquals(sends, 1);
  } finally {
    await db.close();
  }
});
