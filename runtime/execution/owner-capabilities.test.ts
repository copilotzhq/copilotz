import { isOwnerExecutionInterrupted } from "./owner-interruption.ts";
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createOwnerCapabilityHost } from "./owner-capabilities.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { defineAction } from "../actions/define.ts";
import type { ActionContext } from "../actions/types.ts";
import { withSnapshotControl } from "../collections/snapshot-control.ts";
import {
  type CapabilityCall,
  type CapabilityPoll,
  encodeCapability,
  OWNER_CAPABILITY_WORKLOAD,
  readCapability,
} from "./owner-capability-wire.ts";
import type { WorkerCallContext } from "../../dependencies/oxian-hypervisor.ts";

async function setup(
  cleanup: "confirmed" | "unknown" = "confirmed",
  overrides: Record<string, unknown> = {},
  limits: { resourceIdleMs?: number; resourceLifetimeMs?: number } = {},
  afterRegistration?: (options: Record<string, unknown>) => void,
) {
  let epoch = 1;
  const failure = Promise.withResolvers<unknown>();
  let held: Promise<unknown> | undefined;
  let authorityCalls = 0, epochReads = 0;
  const ownerAbort = new AbortController();
  const abort = new AbortController();
  const context = {
    namespace: "scope",
    databaseSchema: "public",
    operationKey: "operation",
    identity: { settlementScopeId: "scope-op" },
    signal: abort.signal,
    now: () => new Date(0),
    collections: {
      notes: { list: async () => held ? await held : [{ id: "visible" }] },
    },
    async readSnapshot(fn: (scope: unknown) => unknown | Promise<unknown>) {
      const disposed = Promise.withResolvers<"confirmed" | "unknown">();
      try {
        return await fn(
          withSnapshotControl({ collections: context.collections }, {
            kind: "exclusive",
            snapshot: {
              query: () => {
                epochReads++;
                return Promise.resolve({ rows: [{ epoch }] });
              },
            } as never,
            cleanup: disposed.promise,
          }),
        );
      } finally {
        disposed.resolve(cleanup);
      }
    },
    ...overrides,
  } as unknown as ActionContext;
  const action = defineAction({ id: "test.host", execute: () => undefined });
  const registry = createPluginRegistry({ actions: { run: action } });
  const hostOptions = {
    localExecution: true,
    ...limits,
    registry,
    resolveAuthority() {
      authorityCalls++;
      return Promise.resolve({ epoch, signal: ownerAbort.signal });
    },
    createWorkloads: (
      { registry }: Parameters<
        Parameters<typeof createOwnerCapabilityHost>[0]["createWorkloads"]
      >[0],
    ) => ({
      test: async () => {
        try {
          await registry.actions.run.execute({} as never, context as never);
          return {};
        } catch (error) {
          failure.resolve(error);
          throw error;
        }
      },
    }),
  };
  const host = createOwnerCapabilityHost(hostOptions);
  afterRegistration?.(hostOptions);
  const binding = {
    workload: OWNER_CAPABILITY_WORKLOAD,
    fence: {
      connectionId: "connection",
      sessionGeneration: 1,
      identity: { workerId: "worker", attemptId: "attempt", epoch: 1 },
    },
    parent: {
      streamId: "parent",
      workload: "test",
      operationId: "op",
      metadata: { databaseSchema: "public", ownerEpoch: 1 },
    },
    signal: abort.signal,
  } as unknown as WorkerCallContext;
  const call = async (input: CapabilityCall, source = binding) => {
    const handler = await host.workerCalls.admit(source);
    assert(handler);
    const result = await handler({
      input: new ReadableStream({
        start(c) {
          c.enqueue(encodeCapability(input));
          c.close();
        },
      }),
      signal: abort.signal,
    } as never);
    const bytes = result as Uint8Array;
    const response = await readCapability(
      new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    ) as { value?: unknown; error?: Error };
    if (response.error) throw response.error;
    return response.value;
  };
  await call({ kind: "open", value: new Uint8Array() });
  const poll = await call({ kind: "next" }) as CapabilityPoll;
  const id = poll.invocation!.context;
  return {
    host,
    failure: failure.promise,
    hostOptions,
    call,
    binding,
    id,
    abortContext(reason: unknown) {
      abort.abort(reason);
    },
    setEpoch(value: number) {
      epoch = value;
      ownerAbort.abort(
        new Error("The assignment belongs to a retired owner epoch."),
      );
    },
    hold(value: Promise<unknown>) {
      held = value;
    },
    authorityCalls: () => authorityCalls,
    epochReads: () => epochReads,
    setDatabaseEpoch(value: number) {
      epoch = value;
    },
    close: () => host.close(),
  };
}
Deno.test("owner capability refuses forged scope, aliases and replaced session handles", async () => {
  const f = await setup();
  try {
    await assertRejects(() =>
      f.call({
        kind: "call",
        context: f.id,
        path: ["collections", "notes", "constructor"],
      })
    );
    await assertRejects(() =>
      f.call({
        kind: "call",
        context: f.id,
        path: ["collections", "notes", "list"],
        args: [{}, { identity: { settlementScopeId: "other" } }],
      })
    );
    await assertRejects(() =>
      f.call({
        kind: "call",
        context: f.id,
        path: ["collections", "notes", "list"],
      }, { ...f.binding, fence: { ...f.binding.fence, sessionGeneration: 2 } })
    );
    assertEquals(
      await f.call({
        kind: "call",
        context: f.id,
        path: ["collections", "notes", "list"],
      }),
      [{ id: "visible" }],
    );
  } finally {
    await f.close();
  }
});
Deno.test("owner takeover suppresses a held read result and retires its assignment", async () => {
  const f = await setup();
  const held = Promise.withResolvers<unknown>();
  f.hold(held.promise);
  try {
    const read = f.call({
      kind: "call",
      context: f.id,
      path: ["collections", "notes", "list"],
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    f.setEpoch(2);
    held.resolve([{ id: "late secret" }]);
    await assertRejects(() => read, Error, "retired owner epoch");
  } finally {
    await f.close();
  }
});
for (const cleanup of ["confirmed", "unknown"] as const) {
  Deno.test(`snapshot ${cleanup} cleanup releases or quarantines actual resource capacity`, async () => {
    const f = await setup(cleanup);
    try {
      const opened = await f.call({ kind: "snapshot", context: f.id }) as {
        handle: string;
      };

      const close = () =>
        f.call({ kind: "close", context: f.id, id: opened.handle });
      if (cleanup === "unknown") {
        await assertRejects(close, Error, "owner_cleanup_unknown");
      } else {
        await close();
      }
      await assertRejects(() =>
        f.call({
          kind: "call",
          context: f.id,
          id: opened.handle,
          path: ["collections", "notes", "list"],
        })
      );
    } finally {
      await f.close();
    }
  });
}

Deno.test("disconnect cancels blocked follower reads and drains resources before retirement", async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const f = await setup("confirmed", {
    streams: {
      follow: () => ({
        bodyId: "body",
        offset: 0,
        mediaType: "text/plain",
        body: stream,
      }),
    },
  });
  try {
    const follower = await f.call({
      kind: "call",
      context: f.id,
      path: ["streams", "follow"],
      args: ["stream"],
    }) as { bodyId: string; body: { handle: string } };
    assertEquals(follower.bodyId, "body");
    const reading = f.call({
      kind: "call",
      context: f.id,
      id: follower.body.handle,
      path: ["read"],
    });
    void reading.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.host.lifecycle?.onDisconnect?.({ fence: f.binding.fence } as never);
    await assertRejects(() => reading);
    assertEquals(cancelled, 1);
  } finally {
    await f.close();
  }
});
Deno.test("writer capacity is bounded while quiet live writers outlast generic handle limits", async () => {
  let opened = 0, aborted = 0;
  const f = await setup("confirmed", {
    streams: {
      open: () => {
        opened++;
        return {
          id: String(opened),
          offset: () => 0,
          append: () => undefined,
          abort: () => {
            aborted++;
          },
        };
      },
    },
  }, { resourceIdleMs: 40, resourceLifetimeMs: 100 });
  try {
    for (let index = 0; index < 32; index++) {
      await f.call({
        kind: "call",
        context: f.id,
        path: ["streams", "open"],
        args: [{}],
      });
    }
    await assertRejects(
      () =>
        f.call({
          kind: "call",
          context: f.id,
          path: ["streams", "open"],
          args: [{}],
        }),
      Error,
      "owner_capacity",
    );
    assertEquals(opened, 32);
    await new Promise((resolve) => setTimeout(resolve, 220));
    assertEquals(aborted, 0);

    await f.call({ kind: "complete", id: f.id, value: "quiet live writers" });
    assertEquals((await f.call({ kind: "next" }) as CapabilityPoll).done, true);
    assertEquals(aborted, 32);
  } finally {
    await f.close();
  }
});
Deno.test("active writers outlast generic lifetime and still close on cancellation", async () => {
  let appended = 0, aborted = 0;
  const f = await setup("confirmed", {
    streams: {
      open: () => ({
        id: "active",
        offset: () => 0,
        append() {
          appended++;
        },
        abort() {
          aborted++;
        },
      }),
    },
  }, { resourceIdleMs: 40, resourceLifetimeMs: 100 });
  try {
    const writer = await f.call({
      kind: "call",
      context: f.id,
      path: ["streams", "open"],
      args: [{}],
    }) as { handle: string };
    for (let index = 0; index < 8; index++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      await f.call({
        kind: "call",
        context: f.id,
        id: writer.handle,
        path: ["append"],
        args: [{}],
      });
    }
    assertEquals(appended, 8);
    assertEquals(aborted, 0);

    f.abortContext(new Error("invocation cancelled"));
    await f.close();
    assertEquals(aborted, 1);
  } finally {
    await f.close();
  }
});

Deno.test("idle reader handles retain bounded expiry while writers use invocation lifetime", async () => {
  let cancelled = 0;
  const f = await setup("confirmed", {
    content: {
      open: () =>
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
    },
  }, { resourceIdleMs: 20, resourceLifetimeMs: 100 });
  try {
    await f.call({
      kind: "call",
      context: f.id,
      path: ["content", "open"],
      args: [{}],
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assertEquals(cancelled, 1);

    await assertRejects(() =>
      f.call({ kind: "complete", id: f.id, value: "expired reader" })
    );
  } finally {
    await f.close();
  }
});

Deno.test("effect outcome data is not mistaken for authority options", async () => {
  let outcome: unknown;
  const f = await setup("confirmed", {
    effect: {
      confirm: (_step: string, value: unknown) => {
        outcome = value;
      },
    },
  });
  try {
    await f.call({
      kind: "call",
      context: f.id,
      path: ["effect", "confirm"],
      args: ["step", { namespace: "provider-result" }],
    });
    assertEquals(outcome, { namespace: "provider-result" });
  } finally {
    await f.close();
  }
});

async function rawCall(
  host: ReturnType<typeof createOwnerCapabilityHost>,
  binding: WorkerCallContext,
  input: CapabilityCall,
) {
  const handler = await host.workerCalls.admit(binding);
  assert(handler);
  const result = await handler({
    input: new ReadableStream({
      start(c) {
        c.enqueue(encodeCapability(input));
        c.close();
      },
    }),
    signal: binding.signal,
  } as never) as Uint8Array;
  const response = await readCapability(
    new ReadableStream({
      start(c) {
        c.enqueue(result);
        c.close();
      },
    }),
  ) as { value?: unknown; error?: Error };
  if (response.error) throw response.error;
  return response.value;
}
function admissionBinding(parent = "parent"): WorkerCallContext {
  return {
    workload: OWNER_CAPABILITY_WORKLOAD,
    fence: {
      connectionId: "admission",
      sessionGeneration: 1,
      identity: { workerId: "worker", attemptId: "attempt", epoch: 1 },
    },
    parent: {
      streamId: parent,
      operationId: parent,
      workload: "test",
      metadata: { databaseSchema: "public", ownerEpoch: 1 },
    },
    signal: new AbortController().signal,
  } as unknown as WorkerCallContext;
}
Deno.test("concurrent Open reserves one parent before deferred authority and cleans failed admission", async () => {
  const authority = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let started = 0;
  const host = createOwnerCapabilityHost({
    localExecution: true,
    registry: createPluginRegistry({}),
    async resolveAuthority() {
      entered.resolve();
      await authority.promise;
      return { epoch: 1, signal: new AbortController().signal };
    },
    createWorkloads: () => ({
      test: () => {
        started++;
        return {};
      },
    }),
  });
  const binding = admissionBinding();
  const first = rawCall(host, binding, {
    kind: "open",
    value: new Uint8Array(),
  });
  void first.catch(() => undefined);
  try {
    await entered.promise;

    const duplicate = rawCall(host, binding, {
      kind: "open",
      value: new Uint8Array(),
    });
    void duplicate.catch(() => undefined);
    authority.resolve();
    await first;
    await assertRejects(() => duplicate, Error, "owner_assignment_started");
    assertEquals(started, 1);
    await assertRejects(
      () =>
        rawCall(host, admissionBinding("invalid"), {
          kind: "open",
          value: "invalid",
        }),
      Error,
      "owner_data_invalid",
    );
  } finally {
    authority.resolve();
    await host.close();
  }
});
Deno.test("deferred concurrent Open admissions cannot exceed assignment capacity", async () => {
  const authority = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let admissions = 0, started = 0;
  const host = createOwnerCapabilityHost({
    localExecution: true,
    registry: createPluginRegistry({}),
    async resolveAuthority() {
      if (++admissions === 256) entered.resolve();
      await authority.promise;
      return { epoch: 1, signal: new AbortController().signal };
    },
    createWorkloads: () => ({
      test: () => {
        started++;
        return {};
      },
    }),
  });
  const pending = Array.from(
    { length: 256 },
    (_, index) =>
      rawCall(host, admissionBinding(String(index)), {
        kind: "open",
        value: new Uint8Array(),
      }),
  );
  try {
    await entered.promise;

    const overflow = rawCall(host, admissionBinding("overflow"), {
      kind: "open",
      value: new Uint8Array(),
    });
    void overflow.catch(() => undefined);
    authority.resolve();
    await Promise.all(pending);
    await assertRejects(() => overflow, Error, "owner_capacity");
    assertEquals(started, 256);
  } finally {
    authority.resolve();
    await Promise.allSettled(pending);
    await host.close();
  }
});
Deno.test("deferred concurrent resource opens reserve physical capacity and clean failed opens", async () => {
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let opened = 0, aborted = 0;
  const f = await setup("confirmed", {
    streams: {
      async open() {
        if (++opened === 32) entered.resolve();
        await gate.promise;
        return {
          id: String(opened),
          offset: () => 0,
          append: () => undefined,
          abort: () => {
            aborted++;
          },
        };
      },
    },
  });
  const pending = Array.from(
    { length: 32 },
    () =>
      f.call({
        kind: "call",
        context: f.id,
        path: ["streams", "open"],
        args: [{}],
      }),
  );
  try {
    await entered.promise;

    const overflow = f.call({
      kind: "call",
      context: f.id,
      path: ["streams", "open"],
      args: [{}],
    });
    void overflow.catch(() => undefined);
    gate.resolve();
    await Promise.all(pending);
    await assertRejects(() => overflow, Error, "owner_capacity");
    assertEquals(opened, 32);
  } finally {
    gate.resolve();
    await Promise.allSettled(pending);
    await f.close();
  }
  assertEquals(aborted, 32);
  const rejected = await setup("confirmed", {
    streams: {
      open() {
        throw new Error("open failed");
      },
    },
  });
  try {
    await assertRejects(() =>
      rejected.call({
        kind: "call",
        context: rejected.id,
        path: ["streams", "open"],
        args: [{}],
      })
    );
  } finally {
    await rejected.close();
  }
});
Deno.test("retirement during deferred resource creation retains slot until actual writer cleanup", async () => {
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>(),
    cleanup = Promise.withResolvers<void>();
  let aborted = 0;
  const f = await setup("confirmed", {
    content: {
      async openCapture() {
        entered.resolve();
        await gate.promise;
        return {
          id: "capture",
          offset: () => 0,
          append: () => undefined,
          async abort() {
            aborted++;
            await cleanup.promise;
          },
        };
      },
    },
  });
  const opening = f.call({
    kind: "call",
    context: f.id,
    path: ["content", "openCapture"],
    args: [{}],
  });
  void opening.catch(() => undefined);
  try {
    await entered.promise;
    let retired = false;
    const retiring = f.close().then(() => {
      retired = true;
    });

    gate.resolve();
    while (!aborted) await new Promise((resolve) => setTimeout(resolve, 0));

    assertEquals(retired, false);
    cleanup.resolve();
    await retiring;
    await assertRejects(() => opening);
    assertEquals(aborted, 1);
  } finally {
    gate.resolve();
    cleanup.resolve();
    await f.close();
  }
});

Deno.test("hostile per-operation transaction options are refused before transaction or receipt side effects", async () => {
  let transactions = 0, writes = 0;
  const f = await setup("confirmed", {
    transaction: async (fn: (scope: unknown) => unknown | Promise<unknown>) => {
      transactions++;
      await fn({
        collections: {
          notes: {
            create() {
              writes++;
            },
          },
        },
        relations: {
          upsert() {
            writes++;
          },
        },
      });
    },
  });
  try {
    for (
      const options of [
        { namespace: "foreign" },
        { databaseSchema: "foreign" },
        { deliveryLease: { owner: "forged" } },
        { ownerEpoch: 99 },
        { workerId: "forged" },
        { context: {} },
        { identity: { settlementScopeId: "foreign" } },
        { identity: { actionScopeId: "foreign" } },
        { identity: { deliveryLease: { owner: "forged" } } },
      ]
    ) {
      for (
        const path of [["collections", "notes", "create"], [
          "relations",
          "upsert",
        ]]
      ) {
        const plan = [{ path, args: [{ id: "forged" }, options] }];
        const transactionOptions = { operationKey: "hostile" };
        const receipt = {
          key: JSON.stringify(["scope", "operation", "hostile"]),
          databaseSchema: "public",
          intent: JSON.parse(
            new TextDecoder().decode(
              encodeCapability({ plan, options: transactionOptions }),
            ),
          ),
        };
        await assertRejects(
          () =>
            f.call({
              kind: "transaction",
              context: f.id,
              plan,
              options: transactionOptions,
              receipt,
            }),
          Error,
          "owner_scope_refused",
        );
      }
    }
    assertEquals(transactions, 0);
    assertEquals(writes, 0);
  } finally {
    await f.close();
  }
});

Deno.test("complete seals context before an admitted open resolves and drains its real cleanup", async () => {
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>(),
    cleanup = Promise.withResolvers<void>(),
    cleaning = Promise.withResolvers<void>();
  let opens = 0, aborted = 0;
  const f = await setup("confirmed", {
    content: {
      async openCapture() {
        opens++;
        entered.resolve();
        await gate.promise;
        return {
          id: "capture",
          offset: () => 0,
          append: () => undefined,
          async abort() {
            aborted++;
            cleaning.resolve();
            await cleanup.promise;
          },
        };
      },
    },
  });
  const opening = f.call({
    kind: "call",
    context: f.id,
    path: ["content", "openCapture"],
    args: [{}],
  });
  void opening.catch(() => undefined);
  try {
    await entered.promise;
    await f.call({ kind: "complete", id: f.id, value: "premature success" });
    await assertRejects(
      () =>
        f.call({
          kind: "call",
          context: f.id,
          path: ["content", "openCapture"],
          args: [{}],
        }),
      Error,
      "owner_context_closed",
    );
    assertEquals(opens, 1);
    gate.resolve();
    await cleaning.promise;

    cleanup.resolve();
    await assertRejects(() => opening, Error, "owner_context_closed");
    const terminal = await f.call({ kind: "next" }) as CapabilityPoll;
    assertEquals(terminal.done, true);
    assertEquals((terminal.error as Error).message, "owner_calls_pending");
    assertEquals(aborted, 1);
  } finally {
    gate.resolve();
    cleanup.resolve();
    await f.close();
  }
});

Deno.test("owner context cancellation revokes a blocked reader before waiting for admitted calls", async () => {
  let cancelled = 0;
  const reading = Promise.withResolvers<void>();
  const stream = new ReadableStream<Uint8Array>({
    pull() {
      reading.resolve();
    },
    cancel() {
      cancelled++;
    },
  }, { highWaterMark: 0 });
  const f = await setup("confirmed", { content: { open: () => stream } });
  try {
    const opened = await f.call({
      kind: "call",
      context: f.id,
      path: ["content", "open"],
      args: [{}],
    }) as { handle: string };
    const pending = f.call({
      kind: "call",
      context: f.id,
      id: opened.handle,
      path: ["read"],
    });
    void pending.catch(() => undefined);
    await reading.promise;
    f.abortContext(new Error("delivery lease lost"));
    await assertRejects(() => pending);
    await f.close();
    assertEquals(cancelled, 1);
  } finally {
    await f.close();
  }
});

Deno.test("cancelled capability calls do not execute and authority is captured once", async () => {
  let reads = 0;
  const f = await setup("confirmed", {
    collections: {
      notes: {
        list() {
          reads++;
          return [];
        },
      },
    },
  });
  try {
    for (let i = 0; i < 4100; i++) {
      await f.call({
        kind: "call",
        context: f.id,
        path: ["collections", "notes", "list"],
      });
    }
    assertEquals(f.authorityCalls(), 1);
    const cancellation = new AbortController();
    cancellation.abort(new Error("cancelled call"));
    await assertRejects(
      () =>
        f.call({
          kind: "call",
          context: f.id,
          path: ["collections", "notes", "list"],
        }, { ...f.binding, signal: cancellation.signal }),
      Error,
      "cancelled call",
    );
    assertEquals(reads, 4100);
  } finally {
    await f.close();
  }
});

Deno.test("delayed old connection readiness failure cannot retire a replacement owner assignment", async () => {
  const f = await setup();
  const replacement = {
    ...f.binding,
    fence: {
      ...f.binding.fence,
      connectionId: "replacement",
      sessionGeneration: 2,
    },
    parent: {
      ...f.binding.parent!,
      streamId: "replacement-parent",
      operationId: "replacement-op",
    },
  };
  try {
    await f.call({ kind: "open", value: new Uint8Array() }, replacement);
    const next = await f.call({ kind: "next" }, replacement) as CapabilityPoll;

    // A rejected old readiness callback is delivered as the exact old fence's
    // disconnect, even if the replacement has already opened an invocation.
    await f.host.lifecycle!.onDisconnect!({ fence: f.binding.fence } as never);

    await f.host.lifecycle!.onDisconnect!({ fence: f.binding.fence } as never);
    assertEquals(
      await f.call({
        kind: "call",
        context: next.invocation!.context,
        path: ["collections", "notes", "list"],
      }, replacement),
      [{ id: "visible" }],
    );
    await f.host.lifecycle!.onDisconnect!(
      { fence: replacement.fence } as never,
    );
  } finally {
    await f.close();
  }
});

Deno.test("owner capability registration captures callbacks before asynchronous startup", async () => {
  const f = await setup("confirmed", {}, {}, (options) => {
    // Mutate before the first Open's authority await. The captured factory and
    // callback must already be detached in the construction turn.
    options.resolveAuthority = () =>
      Promise.reject(new Error("mutated callback"));
    options.createWorkloads = () => {
      throw new Error("mutated factory");
    };
  });
  try {
    assertEquals(
      await f.call({
        kind: "call",
        context: f.id,
        path: ["collections", "notes", "list"],
      }),
      [{ id: "visible" }],
    );
    const another = {
      ...f.binding,
      parent: { ...f.binding.parent!, streamId: "second" },
    };
    await f.call({ kind: "open", value: new Uint8Array() }, another);
    assert(
      (await f.call({ kind: "next" }, another) as CapabilityPoll).invocation,
    );
  } finally {
    await f.close();
  }
});

Deno.test("trusted disconnect classification does not replace a prior explicit invocation cancellation", async () => {
  const f = await setup();
  try {
    const reason = new DOMException("explicit user cancellation", "AbortError");
    f.abortContext(reason);
    await f.host.lifecycle!.onDisconnect!({ fence: f.binding.fence } as never);
    assertEquals(await f.failure, reason);
    assertEquals(isOwnerExecutionInterrupted(await f.failure), false);
  } finally {
    await f.close();
  }
});
Deno.test("trusted disconnect classification cannot replace a received worker business error", async () => {
  const f = await setup();
  try {
    await f.call({
      kind: "complete",
      id: f.id,
      error: Object.assign(new Error("business failure"), {
        code: "connection_lost",
      }),
    });
    await f.host.lifecycle!.onDisconnect!({ fence: f.binding.fence } as never);
    assertEquals(isOwnerExecutionInterrupted(await f.failure), false);
    assertEquals((await f.failure as Error).message, "business failure");
  } finally {
    await f.close();
  }
});
Deno.test("old completion cannot retire a replacement of the same operation or settle its Action", async () => {
  const f = await setup();
  const replacement = {
    ...f.binding,
    fence: {
      ...f.binding.fence,
      connectionId: "new-connection",
      sessionGeneration: 2,
    },
    parent: { ...f.binding.parent!, streamId: "new-stream" },
  };
  try {
    await f.call({ kind: "open", value: new Uint8Array() }, replacement);
    const next = await f.call({ kind: "next" }, replacement) as CapabilityPoll;
    await f.host.lifecycle!.onDisconnect!({ fence: f.binding.fence } as never);
    await f.host.lifecycle!.onComplete!(
      {
        operationId: f.binding.parent!.operationId,
        fence: f.binding.fence,
      } as never,
    );

    await assertRejects(
      () => f.call({ kind: "complete", id: f.id, value: "late old success" }),
      Error,
      "owner_assignment_unknown",
    );
    assertEquals(
      await f.call({
        kind: "call",
        context: next.invocation!.context,
        path: ["collections", "notes", "list"],
      }, replacement),
      [{ id: "visible" }],
    );
    f.setEpoch(2);
    await assertRejects(
      () =>
        f.call({
          kind: "complete",
          id: next.invocation!.context,
          value: "retired epoch success",
        }, replacement),
      Error,
      "retired owner epoch",
    );
  } finally {
    await f.close();
  }
});

Deno.test("late completion is fenced by stream even when operation and connection are unchanged", async () => {
  const f = await setup();
  const replacement = {
    ...f.binding,
    parent: { ...f.binding.parent!, streamId: "replacement-same-session" },
  };
  try {
    await f.call({ kind: "open", value: new Uint8Array() }, replacement);
    const next = await f.call({ kind: "next" }, replacement) as CapabilityPoll;
    const old = {
      operationId: f.binding.parent!.operationId,
      streamId: f.binding.parent!.streamId,
      fence: f.binding.fence,
    };
    await f.host.lifecycle!.onComplete!(old as never);
    await f.host.lifecycle!.onComplete!(old as never);

    assertEquals(
      await f.call({
        kind: "call",
        context: next.invocation!.context,
        path: ["collections", "notes", "list"],
      }, replacement),
      [{ id: "visible" }],
    );
    await assertRejects(
      () => f.call({ kind: "complete", id: f.id, value: "late success" }),
      Error,
      "owner_assignment_unknown",
    );
  } finally {
    await f.close();
  }
});

Deno.test("snapshot cleanup confirmation controls future admission, without a lifetime quota", async () => {
  for (const cleanup of ["confirmed", "unknown"] as const) {
    const f = await setup(cleanup);
    try {
      for (let i = 0; i < (cleanup === "confirmed" ? 64 : 32); i++) {
        const opened = await f.call({ kind: "snapshot", context: f.id }) as {
          handle: string;
        };
        const close = () =>
          f.call({ kind: "close", context: f.id, id: opened.handle });
        if (cleanup === "confirmed") await close();
        else await assertRejects(close, Error, "owner_cleanup_unknown");
      }
      if (cleanup === "unknown") {
        await assertRejects(
          () => f.call({ kind: "snapshot", context: f.id }),
          Error,
          "owner_capacity",
        );
      }
    } finally {
      await f.close();
    }
  }
});

Deno.test("snapshot reads have one current-epoch result gate even before owner retirement is noticed", async () => {
  const f = await setup();
  try {
    const opened = await f.call({ kind: "snapshot", context: f.id }) as {
      handle: string;
    };
    const read = () =>
      f.call({
        kind: "call",
        context: f.id,
        id: opened.handle,
        path: ["collections", "notes", "list"],
      });
    const before = f.epochReads();
    await read();
    assertEquals(f.epochReads() - before, 1);
    const held = Promise.withResolvers<unknown>();
    f.hold(held.promise);
    const pending = read();
    await new Promise((resolve) => setTimeout(resolve, 5));
    f.setDatabaseEpoch(2);
    held.resolve([{ id: "stale secret" }]);
    await assertRejects(() => pending, Error, "ActionOwnershipLost");
    assertEquals(f.authorityCalls(), 1);
  } finally {
    await f.close();
  }
});
