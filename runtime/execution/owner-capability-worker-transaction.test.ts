import { assert, assertEquals, assertRejects } from "@std/assert";
import type { WorkerWorkHandler } from "../../dependencies/oxian-worker.ts";
import { defineAction } from "../actions/define.ts";
import { defineCollection } from "../collections/definition.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createOwnerWorkerWorkloads } from "./owner-capability-worker.ts";
import {
  type CapabilityCall,
  type CapabilityInvocation,
  decodeCapability,
  encodeCapability,
} from "./owner-capability-wire.ts";

type Plan = {
  collections: {
    notes: {
      create(input: { id?: string; title: string }): Promise<{ id: string }>;
    };
  };
};
type Context = {
  transaction<T>(
    execute: (plan: Plan) => T | Promise<T>,
    options?: { signal?: AbortSignal; operationKey?: string },
  ): Promise<T>;
};

/** Exercise the real workload/context and wire codec without a database owner. */
async function invoke(
  execute: (context: Context) => unknown | Promise<unknown>,
  onTransaction?: (
    call: CapabilityCall,
    signal: AbortSignal,
  ) => Promise<void>,
) {
  const calls: CapabilityCall[] = [];
  const complete = Promise.withResolvers<CapabilityCall>();
  const invocation: CapabilityInvocation = {
    id: "invocation",
    context: "context",
    kind: "action",
    alias: "run",
    args: [{}],
    scope: {
      namespace: "scope",
      databaseSchema: "public",
      operationKey: "operation",
      now: new Date(0).toISOString(),
    },
  };
  const registry = createPluginRegistry({
    actions: {
      run: defineAction({
        id: "test.transaction",
        execute: (_input: unknown, context: Context) => execute(context),
      }),
    },
    collections: {
      notes: defineCollection({
        name: "notes",
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      }),
    },
  });
  let sent = false;
  const work: Parameters<WorkerWorkHandler>[0] = {
    streamId: "stream",
    workload: "copilotz.delivery.v1",
    metadata: {},
    signal: new AbortController().signal,
    input: new ReadableStream({ start: (controller) => controller.close() }),
    sendMetadata: () => Promise.resolve(),
    async callHost(request) {
      assert(request.body instanceof Uint8Array);
      const call = decodeCapability(request.body) as CapabilityCall;
      calls.push(call);
      let value: unknown;
      if (call.kind === "next") {
        if (!sent) {
          sent = true;
          value = { invocation };
        } else {
          await complete.promise;
          value = { done: true };
        }
      } else if (call.kind === "complete") complete.resolve(call);
      else if (call.kind === "transaction") {
        await onTransaction?.(call, request.signal!);
      }
      return {
        streamId: "host-call",
        metadata: Promise.resolve({}),
        started: Promise.resolve(),
        cancel: () => Promise.resolve(),
        output: new ReadableStream({
          start(controller) {
            controller.enqueue(encodeCapability({ value }));
            controller.close();
          },
        }),
        completed: Promise.resolve(),
      };
    },
  };
  await createOwnerWorkerWorkloads({ registry })[work.workload](work);
  const result = await complete.promise;
  if (result.error) throw result.error;
  return { calls, value: result.value };
}

Deno.test("worker pre-aborted transactions never plan, call owner, or disturb implicit receipt identity", async () => {
  let callbacks = 0;
  const result = await invoke(async (context) => {
    const aborted = AbortSignal.abort(new Error("pre-aborted"));
    // More than the invocation RPC budget: refused plans consume no admission.
    for (let index = 0; index < 4100; index++) {
      await assertRejects(
        () => context.transaction(() => callbacks++, { signal: aborted }),
        Error,
        "pre-aborted",
      );
    }
    const invalidOptions = Object.defineProperty(
      { signal: aborted },
      "operationKey",
      {
        get: () => {
          throw new Error("options must not be read");
        },
      },
    );
    await assertRejects(
      () => context.transaction(() => callbacks++, invalidOptions),
      Error,
      "pre-aborted",
    );
    return await context.transaction(async (plan) => {
      return await plan.collections.notes.create({ title: "unchanged intent" });
    });
  });
  const control = await invoke((context) =>
    context.transaction((plan) =>
      plan.collections.notes.create({ title: "unchanged intent" })
    )
  );
  assertEquals(callbacks, 0);
  const transactions = result.calls.filter((call) =>
    call.kind === "transaction"
  );
  assertEquals(transactions.length, 1);
  assertEquals(
    transactions,
    control.calls.filter((c) => c.kind === "transaction"),
  );
  assertEquals(transactions[0].options?.operationKey, "transaction:1");
  assertEquals(result.value, control.value);
});

Deno.test("worker transaction cancellation during planning rejects new stages and waits for callback lifetime", async () => {
  const abort = new AbortController();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let settled = false;
  let captured: Plan | undefined;
  const running = invoke(async (context) => {
    const transaction = context.transaction(async (plan) => {
      captured = plan;
      await plan.collections.notes.create({ id: "first", title: "first" });
      entered.resolve();
      await release.promise;
      await assertRejects(
        () => plan.collections.notes.create({ id: "late", title: "late" }),
        Error,
        "cancel planning",
      );
    }, { signal: abort.signal });
    void transaction.finally(() => settled = true).catch(() => undefined);
    await assertRejects(() => transaction, Error, "cancel planning");
    return "cancelled";
  });
  await entered.promise;
  abort.abort(new Error("cancel planning"));
  await Promise.resolve();
  assertEquals(settled, false);
  release.resolve();
  const result = await running;
  assertEquals(result.value, "cancelled");
  assertEquals(result.calls.filter((c) => c.kind === "transaction"), []);
  await assertRejects(
    () => captured!.collections.notes.create({ id: "closed", title: "closed" }),
    Error,
    "owner_assignment_ended",
  );
});

Deno.test("worker transaction drains unawaited plan calls and closes planning handles before commit", async () => {
  let captured: Plan | undefined;
  const result = await invoke(async (context) => {
    const value = await context.transaction((plan) => {
      captured = plan;
      // The generated ID is asynchronous; the callback deliberately does not await it.
      void plan.collections.notes.create({ title: "pending" });
      return "callback result";
    }, { operationKey: "stable" });
    await assertRejects(
      () => captured!.collections.notes.create({ title: "after callback" }),
      Error,
      "owner_plan_closed",
    );
    return value;
  }, async (call) => {
    assertEquals(call.plan?.length, 1);
    const input = call.plan![0].args[0] as { id?: string };
    assert(typeof input.id === "string" && input.id.length > 0);
    await assertRejects(
      () => captured!.collections.notes.create({ title: "during commit" }),
      Error,
      "owner_plan_closed",
    );
  });
  assertEquals(result.value, "callback result");
  assertEquals(result.calls.filter((c) => c.kind === "transaction").length, 1);
});

Deno.test("worker transaction forwards cancellation during owner admission and never releases a result", async () => {
  const abort = new AbortController();
  const result = await invoke(async (context) => {
    await assertRejects(
      () => context.transaction(() => "hidden", { signal: abort.signal }),
      Error,
      "cancel commit",
    );
    return "cancelled";
  }, async (_call, signal) => {
    assertEquals(signal.aborted, false);
    abort.abort(new Error("cancel commit"));
    assertEquals(signal.aborted, true);
    // Even if the response wins the transport race, cancellation gates release.
    await Promise.resolve();
  });
  assertEquals(result.value, "cancelled");
  assertEquals(result.calls.filter((c) => c.kind === "transaction").length, 1);
});

Deno.test("worker cancellation drains a physically pending planning tail before rejecting", async () => {
  const result = await invoke(async (context) => {
    const abort = new AbortController();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = crypto.subtle.digest;
    const descriptor = Object.getOwnPropertyDescriptor(crypto.subtle, "digest");
    Object.defineProperty(crypto.subtle, "digest", {
      configurable: true,
      value: async (...args: Parameters<SubtleCrypto["digest"]>) => {
        entered.resolve();
        await release.promise;
        return await original.apply(crypto.subtle, args);
      },
    });
    let settled = false;
    try {
      const transaction = context.transaction((plan) => {
        void plan.collections.notes.create({ title: "pending digest" });
        abort.abort(new Error("cancel pending plan"));
        return "hidden";
      }, { signal: abort.signal, operationKey: "long-key-".repeat(30) });
      const rejected = assertRejects(
        () => transaction,
        Error,
        "cancel pending plan",
      );
      void transaction.finally(() => settled = true).catch(() => undefined);
      await entered.promise;
      await Promise.resolve();
      assertEquals(settled, false);
      release.resolve();
      await rejected;
      assertEquals(settled, true);
      return "drained";
    } finally {
      release.resolve();
      if (descriptor) {
        Object.defineProperty(crypto.subtle, "digest", descriptor);
      } else Reflect.deleteProperty(crypto.subtle, "digest");
    }
  });
  assertEquals(result.value, "drained");
  assertEquals(result.calls.filter((call) => call.kind === "transaction"), []);
});
