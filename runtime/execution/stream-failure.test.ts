import type { WorkerCallContext } from "../../dependencies/oxian-hypervisor.ts";
import type { ActionContext, ActionLifecycleInput } from "../actions/types.ts";
import { createProcessorContext } from "../engine/context.ts";
import { authorizeActionCapabilities } from "../actions/capability-authorization.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { defineAction } from "../actions/define.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { createOwnerCapabilityHost } from "./owner-capabilities.ts";
import {
  type CapabilityCall,
  type CapabilityPoll,
  decodeCapability,
  encodeCapability,
  OWNER_CAPABILITY_WORKLOAD,
} from "./owner-capability-wire.ts";
import type {
  ContentStreamAbortInput,
  ContentStreamWriter,
  CreateContentStreamRuntimeOptions,
} from "../streams/types.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import {
  type ContentCatalog,
  createContentCatalog,
  openLogicalBody,
} from "../content/catalog.ts";
import {
  type BodyStore,
  createMemoryBodyStore,
} from "../content/body-store.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
} from "../engine/commands.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { createEventStore } from "../events/store.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import {
  createContentStreamRuntime,
  observeContentStreamFailure,
} from "../streams/stream.ts";
import { contentStreamBodyId } from "../streams/body-identity.ts";

async function fixture() {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
  });
  const schema = `writer_failure_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  const owner = await openDatabaseOwner(db, schema),
    catalog = createContentCatalog(db, schema),
    store = createMemoryBodyStore();
  return {
    db,
    schema,
    owner,
    catalog,
    store,
    runtime(
      overrides: {
        catalog?: ContentCatalog;
        store?: BodyStore;
        protectionMs?: number;
        signal?: AbortSignal;
        checkpointIntervalMs?: number;
        onTerminalizing?: CreateContentStreamRuntimeOptions["onTerminalizing"];
      } = {},
    ) {
      return createContentStreamRuntime({
        namespace: "scope",
        catalog,
        store,
        ...overrides,
        onOpen(_opened, publication) {
          publication.established();
        },
      });
    },
    async close() {
      owner.stop();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}
const bytes = (value: string) => new TextEncoder().encode(value);

Deno.test("a rejected append that lands after its final hint is fenced and terminates at the accepted prefix", async () => {
  const f = await fixture(),
    write = Promise.withResolvers<void>(),
    fence = Promise.withResolvers<void>(),
    hinted = Promise.withResolvers<void>(),
    publication = Promise.withResolvers<void>();
  let rejected = false, delayed: Promise<unknown> | undefined;
  const runtime = f.runtime({
    store: {
      ...f.store,
      append(input) {
        delayed = write.promise.then(() => f.store.append(input));
        rejected = true;
        return Promise.reject(new Error("remote reply lost"));
      },
      async fence(input) {
        await fence.promise;
        return await f.store.fence(input);
      },
      async head(input) {
        const head = await f.store.head(input);
        if (rejected && head?.byteLength === 0) hinted.resolve();
        return head;
      },
    },
  });
  const writer = await runtime.open({
    id: "late",
    mediaType: "text/plain",
    role: "output",
  });
  const reader = (await runtime.follow({ id: writer.id })).body.getReader();
  let failure: unknown;
  const remove = observeContentStreamFailure(
    writer,
    (reason) => failure = reason,
  );
  const reading = reader.read();
  try {
    await assertRejects(
      () => writer.append({ appendId: "late", bytes: bytes("unaccepted") }),
      Error,
      "remote reply lost",
    );
    assertEquals((failure as Error)?.message, "remote reply lost");
    await hinted.promise; // The one append-settlement hint has already read zero bytes.
    await createSchemaCommandRunner(f.db, f.schema)(
      "test.blockPublication",
      {},
      (_input, context) => context.afterCommit(() => publication.promise),
    );
    write.resolve();
    await delayed;
    assertEquals(
      (await f.store.head({ bodyId: contentStreamBodyId("scope", writer.id) }))
        ?.byteLength,
      10,
    );
    await assertRejects(
      () => writer.close({ assetId: "asset" }),
      Error,
      "remote reply lost",
    );
    fence.resolve();
    await writer.abort();
    const observed = await reading;
    // Live followers may see tentative physical bytes before the failure
    // terminal. That observation never advances the durable accepted prefix.
    if (!observed.done) {
      assertEquals(new TextDecoder().decode(observed.value), "unaccepted");
      assertEquals((await reader.read()).done, true);
    }
    const logical = await f.catalog.read(
      contentStreamBodyId("scope", writer.id),
    );
    assertEquals(logical?.committedOffset, 0);
    assertEquals(logical?.terminal?.length, 0);
    assertEquals(logical?.terminal?.outcome, "failed");
    assertEquals((failure as Error)?.message, "remote reply lost");
  } finally {
    publication.resolve();
    write.resolve();
    fence.resolve();
    remove();
    await reader.cancel();
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("a close queued behind a rejected append cannot accept a successful terminal", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const runtime = f.runtime({
    store: {
      ...f.store,
      async append() {
        entered.resolve();
        await release.promise;
        throw new Error("append failed");
      },
    },
  });
  const writer = await runtime.open({
    id: "queued",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    const append = writer.append({ appendId: "first", bytes: bytes("first") });
    const rejectedAppend = assertRejects(() => append, Error, "append failed");
    await entered.promise;
    const closing = writer.close({ assetId: "asset" });
    const rejectedClose = assertRejects(() => closing, Error, "append failed");
    release.resolve();
    await Promise.all([rejectedAppend, rejectedClose]);
    await writer.abort();
    const logical = await f.catalog.read(
      contentStreamBodyId("scope", writer.id),
    );
    assertEquals(logical?.terminal?.outcome, "failed");
    assertEquals(logical?.terminal?.length, 0);
  } finally {
    release.resolve();
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("a lost accepted seal reply keeps its completed terminal and never fences its ready bytes", async () => {
  const f = await fixture();
  let fences = 0, failures = 0;
  const runtime = f.runtime({
    catalog: {
      ...f.catalog,
      async sealAccepted(input) {
        await f.catalog.sealAccepted(input);
        throw new Error("seal reply lost");
      },
    },
    store: {
      ...f.store,
      fence(input) {
        fences++;
        return f.store.fence(input);
      },
    },
  });
  const writer = await runtime.open({
    id: "sealed",
    mediaType: "text/plain",
    role: "output",
  });
  const remove = observeContentStreamFailure(writer, () => failures++);
  try {
    await writer.append({ appendId: "prefix", bytes: bytes("prefix") });
    await assertRejects(
      () => writer.close({ assetId: "asset" }),
      Error,
      "seal reply lost",
    );
    await writer.abort();
    const logical = await f.catalog.read(
      contentStreamBodyId("scope", writer.id),
    );
    assertEquals(logical?.terminal?.outcome, "completed");
    assertEquals(logical?.terminal?.length, 6);
    assertEquals(fences, 0);
    assertEquals(failures, 1);
    assertEquals(
      (await f.store.head({ bodyId: logical!.copy.key }))?.state,
      "ready",
    );
  } finally {
    remove();
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("background renewal failure is latched for its writer but a late renewal cannot rewrite accepted success", async (t) => {
  for (const accepted of [false, true]) {
    await t.step(accepted ? "accepted terminal" : "active writer", async () => {
      const f = await fixture(),
        entered = Promise.withResolvers<void>(),
        renewal = Promise.withResolvers<string>();
      let failures = 0, fences = 0;
      const observed = Promise.withResolvers<unknown>();
      const runtime = f.runtime({
        protectionMs: 10,
        catalog: {
          ...f.catalog,
          renew() {
            entered.resolve();
            return renewal.promise;
          },
        },
        store: {
          ...f.store,
          fence(input) {
            fences++;
            return f.store.fence(input);
          },
        },
      });
      const writer = await runtime.open({
        id: "renewal",
        mediaType: "text/plain",
        role: "output",
      });
      const remove = observeContentStreamFailure(writer, (reason) => {
        failures++;
        observed.resolve(reason);
      });
      try {
        await writer.append({ appendId: "prefix", bytes: bytes("prefix") });
        await entered.promise;
        if (accepted) {
          await writer.close({ assetId: "asset" });
        }
        renewal.reject(new Error("renewal failed"));
        if (!accepted) {
          assertEquals(
            (await observed.promise as Error).message,
            "renewal failed",
          );
        }
        await writer.abort();
        await Promise.resolve();
        assertEquals(failures, accepted ? 0 : 1);
        assertEquals(fences, accepted ? 0 : 1);
        const logical = await f.catalog.read(
          contentStreamBodyId("scope", writer.id),
        );
        assertEquals(
          logical?.terminal?.outcome,
          accepted ? "completed" : "failed",
        );
        assertEquals(logical?.terminal?.length, 6);
      } finally {
        renewal.resolve("");
        remove();
        await writer.abort().catch(() => {});
        await f.close();
      }
    });
  }
});

Deno.test("a remote append settling after failure fencing cannot extend a terminated prefix", async () => {
  const f = await fixture(), write = Promise.withResolvers<void>();
  let delayed: Promise<unknown> | undefined;
  const runtime = f.runtime({
    store: {
      ...f.store,
      append(input) {
        delayed = write.promise.then(() => f.store.append(input)).catch(
          (error) => error,
        );
        return Promise.reject(new Error("reply rejected before write"));
      },
    },
  });
  const writer = await runtime.open({
    id: "fenced",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    await assertRejects(
      () => writer.append({ appendId: "late", bytes: bytes("late") }),
      Error,
      "reply rejected",
    );
    await writer.abort();
    write.resolve();
    assertEquals(await delayed instanceof Error, true);
    const logical = await f.catalog.read(
      contentStreamBodyId("scope", writer.id),
    );
    assertEquals(logical?.terminal?.length, 0);
    assertEquals(logical?.terminal?.outcome, "failed");
    assertEquals(
      (await f.store.head({ bodyId: logical!.copy.key }))?.byteLength,
      0,
    );
  } finally {
    write.resolve();
    await delayed;
    await writer.abort().catch(() => {});
    await f.close();
  }
});

async function capabilityFixture(
  streams: unknown[],
  execute?: (registry: PluginRegistry, signal: AbortSignal) => Promise<unknown>,
) {
  const abort = new AbortController();
  const outcomes = streams.map(() =>
    Promise.withResolvers<{ value?: unknown; error?: unknown }>()
  );
  const registry = createPluginRegistry({
    actions: {
      run: defineAction({
        id: "test.writer",
        execute: () => undefined,
      }),
    },
  });
  const host = createOwnerCapabilityHost({
    localExecution: true,
    registry,
    resolveAuthority: () => Promise.resolve({ epoch: 1, signal: abort.signal }),
    createWorkloads: ({ registry }) => ({
      test: async () => {
        await Promise.all(streams.map(async (runtime, index) => {
          const context = {
            namespace: "scope",
            databaseSchema: "public",
            operationKey: `operation-${index}`,
            signal: abort.signal,
            identity: { settlementScopeId: "operation" },
            now: () => new Date(),
            streams: runtime,
          } as unknown as ActionContext;
          try {
            outcomes[index].resolve({
              value: execute
                ? await execute(registry, abort.signal)
                : await registry.actions.run.execute(
                  {} as never,
                  context as never,
                ),
            });
          } catch (error) {
            outcomes[index].resolve({ error });
          }
        }));
        return {};
      },
    }),
  });
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
      operationId: "operation",
      metadata: { databaseSchema: "public", ownerEpoch: 1 },
    },
    signal: abort.signal,
  } as unknown as WorkerCallContext;
  const call = async (input: CapabilityCall) => {
    const handler = (await host.workerCalls.admit(binding))!;
    const output = await handler({
      input: new ReadableStream({
        start(c) {
          c.enqueue(encodeCapability(input));
          c.close();
        },
      }),
      signal: abort.signal,
    } as never);
    const response = decodeCapability(output as Uint8Array) as {
      value?: unknown;
      error?: Error;
    };
    if (response.error) throw response.error;
    return response.value;
  };
  await call({ kind: "open", value: new Uint8Array() });
  const ids: string[] = [];
  for (let i = 0; i < streams.length; i++) {
    ids.push(
      ((await call({ kind: "next" })) as CapabilityPoll).invocation!.context,
    );
  }
  return {
    call,
    ids,
    outcomes: outcomes.map((outcome) => outcome.promise),
    signal: abort.signal,
    close: () => host.close(),
  };
}

Deno.test("background writer failure rejects only its owning invocation even after confirmed cleanup", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    renewal = Promise.withResolvers<string>();
  const failing = f.runtime({
    protectionMs: 10,
    catalog: {
      ...f.catalog,
      renew() {
        entered.resolve();
        return renewal.promise;
      },
    },
  });
  let raw: ContentStreamWriter | undefined;
  const host = await capabilityFixture([{
    ...failing,
    async open(input: Parameters<typeof failing.open>[0]) {
      return raw = await failing.open(input);
    },
  }, f.runtime()]);
  try {
    for (const [index, context] of host.ids.entries()) {
      await host.call({
        kind: "call",
        context,
        path: ["streams", "open"],
        args: [{
          id: `writer-${index}`,
          mediaType: "text/plain",
          role: "output",
        }],
      });
    }
    await entered.promise;
    const observed = Promise.withResolvers<void>();
    const remove = observeContentStreamFailure(raw!, () => observed.resolve());
    renewal.reject(new Error("background writer failed"));
    await observed.promise;
    remove();
    await raw!.abort();
    await host.call({
      kind: "complete",
      id: host.ids[0],
      value: "incorrect success",
    }).catch(() => undefined);
    await host.call({
      kind: "complete",
      id: host.ids[1],
      value: "other invocation succeeds",
    });
    const [failed, healthy] = await Promise.all(host.outcomes);
    assertEquals((failed.error as Error)?.message, "background writer failed");
    assertEquals(healthy, { value: "other invocation succeeds" });
    assertEquals(host.signal.aborted, false);
  } finally {
    renewal.resolve("");
    await host.close();
    await f.close();
  }
});

Deno.test("writer failure during final cleanup overrides an already received success result", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    checkpoint = Promise.withResolvers<number>();
  let calls = 0;
  const runtime = f.runtime({
    checkpointIntervalMs: 100,
    catalog: {
      ...f.catalog,
      checkpoint(input) {
        if (++calls === 2) {
          entered.resolve();
          return checkpoint.promise;
        }
        return f.catalog.checkpoint(input);
      },
    },
  });
  const host = await capabilityFixture([runtime]);
  try {
    const context = host.ids[0];
    const handle = await host.call({
      kind: "call",
      context,
      path: ["streams", "open"],
      args: [{ id: "cleanup", mediaType: "text/plain", role: "output" }],
    }) as { handle: string };
    for (const id of ["accepted", "tentative"]) {
      await host.call({
        kind: "call",
        context,
        id: handle.handle,
        path: ["append"],
        args: [{ appendId: id, bytes: bytes(id) }],
      });
    }
    await entered.promise;
    await host.call({
      kind: "complete",
      id: context,
      value: "incorrect success",
    });
    checkpoint.reject(new Error("checkpoint failed during cleanup"));
    const result = await host.outcomes[0];
    assertEquals(
      (result.error as Error)?.message,
      "checkpoint failed during cleanup",
    );
    const logical = await f.catalog.read(
      contentStreamBodyId("scope", "cleanup"),
    );
    assertEquals(logical?.terminal?.length, 8);
    assertEquals(logical?.terminal?.outcome, "cancelled");
  } finally {
    checkpoint.resolve(0);
    await host.close();
    await f.close();
  }
});

Deno.test("unknown writer cleanup stays stronger than its latched background failure", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    renewal = Promise.withResolvers<string>();
  let uncertain = true, raw: ContentStreamWriter | undefined;
  const runtime = f.runtime({
    protectionMs: 10,
    catalog: {
      ...f.catalog,
      renew() {
        entered.resolve();
        return renewal.promise;
      },
    },
    store: {
      ...f.store,
      fence(input) {
        if (uncertain) {
          return Promise.reject(
            Object.assign(new Error("cleanup uncertain"), {
              code: "owner_cleanup_unknown",
            }),
          );
        }
        return f.store.fence(input);
      },
    },
  });
  const host = await capabilityFixture([{
    ...runtime,
    async open(input: Parameters<typeof runtime.open>[0]) {
      return raw = await runtime.open(input);
    },
  }]);
  try {
    await host.call({
      kind: "call",
      context: host.ids[0],
      path: ["streams", "open"],
      args: [{
        id: "uncertain-cleanup",
        mediaType: "text/plain",
        role: "output",
      }],
    });
    await entered.promise;
    const observed = Promise.withResolvers<void>();
    const remove = observeContentStreamFailure(raw!, () => observed.resolve());
    renewal.reject(new Error("background failure"));
    await observed.promise;
    remove();
    await host.call({
      kind: "complete",
      id: host.ids[0],
      value: "incorrect success",
    }).catch(() => undefined);
    assertEquals(
      (await host.outcomes[0]).error &&
        ((await host.outcomes[0]).error as { code?: string }).code,
      "owner_cleanup_unknown",
    );
  } finally {
    uncertain = false;
    renewal.resolve("");
    await raw?.abort().catch(() => {});
    await host.close().catch(() => {});
    await f.close();
  }
});

Deno.test("host writer admission rejects the third pending append before adding a serial queue entry", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let calls = 0;
  const host = await capabilityFixture([{
    open: () => ({
      id: "bounded",
      offset: () => 0,
      async append() {
        if (++calls === 1) {
          entered.resolve();
          await release.promise;
        }
        return { startOffset: calls - 1, endOffset: calls };
      },
      abort: () => Promise.resolve(),
    }),
  }]);
  const pending: Promise<unknown>[] = [];
  try {
    const context = host.ids[0];
    const handle = await host.call({
      kind: "call",
      context,
      path: ["streams", "open"],
      args: [{}],
    }) as { handle: string };
    const append = () =>
      host.call({
        kind: "call",
        context,
        id: handle.handle,
        path: ["append"],
        args: [{ appendId: "chunk", bytes: new Uint8Array(64 * 1024) }],
      });
    pending.push(append());
    await entered.promise;
    pending.push(append());
    let third: unknown;
    pending.push(
      append().then((value) => third = value, (error) => third = error),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    assertEquals((third as { code?: string })?.code, "owner_append_capacity");
    assertEquals(calls, 1);
    release.resolve();
    await Promise.all(pending);
    assertEquals(calls, 2);
    await host.call({ kind: "complete", id: context, value: "bounded" });
    assertEquals(await host.outcomes[0], { value: "bounded" });
  } finally {
    release.resolve();
    await Promise.allSettled(pending);
    await host.close();
  }
});

async function authorizedWriterFailure(
  t: Deno.TestContext,
  failureFirst: boolean,
) {
  for (const method of ["streams.open", "content.openCapture"] as const) {
    await t.step(method, async () => {
      const f = await fixture(),
        entered = Promise.withResolvers<void>(),
        checkpoint = Promise.withResolvers<number>(),
        fencing = Promise.withResolvers<void>(),
        releaseFence = Promise.withResolvers<void>();
      let calls = 0, authorizations = 0;
      const lifecycle: ActionLifecycleInput[] = [];
      await provisionOperationCatalog(f.db, f.schema);
      const operations = createOperationCatalog(f.db, f.schema);
      const events = createEventStore({
        session: f.db,
        schema: f.schema,
        indexOperationEventSql: (input, param) =>
          operations.indexEventSql(input, param),
      });
      const root = (await events.append({
        namespace: "scope",
        type: "test.root",
        payload: {},
      })).event;
      const operationCatalog = {
        ...operations,
        acceptStreamCheckpoint(
          input: Parameters<typeof operations.acceptStreamCheckpoint>[0],
        ) {
          if (++calls === 2) {
            entered.resolve();
            return checkpoint.promise;
          }
          return operations.acceptStreamCheckpoint(input);
        },
      };
      const catalog: ContentCatalog = {
        ...f.catalog,
        checkpoint(input) {
          if (++calls === 2) {
            entered.resolve();
            return checkpoint.promise;
          }
          return f.catalog.checkpoint(input);
        },
      };
      const host = await capabilityFixture(
        [undefined],
        async (registry, signal) => {
          const processor = createProcessorContext({
            base: {
              databaseSchema: f.schema,
              event: root,
              settlementScopeId: root.id,
              signal,
              idempotencyKey: "processor",
              createMutationIdentity: (operationKey: string) => ({
                deduplicationId: operationKey,
              }),
            },
            registry,
            assets: { catalog },
            operationCatalog,
            collections: { withScope: () => ({}), vectors: () => ({}) },
            streamBodyStore: {
              ...f.store,
              async fence(input: Parameters<typeof f.store.fence>[0]) {
                fencing.resolve();
                await releaseFence.promise;
                return await f.store.fence(input);
              },
            },
            operations: {},
            publishLocalStream: () => Promise.resolve(),
            authorizeAction: () => {
              authorizations++;
              return Promise.resolve();
            },
            actionLifecycle: {
              emit(input: ActionLifecycleInput) {
                lifecycle.push(input);
                return Promise.resolve({ deduplicated: false });
              },
              invoked: () => Promise.resolve(null),
              terminal: () => Promise.resolve(null),
            },
          } as never);
          return await processor.actions.run({} as never, {
            operationKey: "invoke",
          } as never);
        },
      );
      try {
        const context = host.ids[0];
        const handle = await host.call({
          kind: "call",
          context,
          path: method.split("."),
          args: [{
            id: "authorized",
            operationKey: "upload",
            mediaType: "text/plain",
            role: "output",
          }],
        }) as { handle: string; id: string };
        for (const id of ["accepted", "tentative"]) {
          await host.call({
            kind: "call",
            context,
            id: handle.handle,
            path: ["append"],
            args: [{ appendId: id, bytes: bytes(id) }],
          });
        }
        await entered.promise;
        if (!failureFirst) {
          await host.call({
            kind: "complete",
            id: context,
            value: "incorrect success",
          });
          // Let the host enter its still-authorized abort before releasing the
          // checkpoint tail; the failure must survive that confirmed cleanup.
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
        let settled = false;
        void host.outcomes[0].then(() => settled = true);
        checkpoint.reject(new Error("authorized checkpoint failed"));
        await fencing.promise;
        await new Promise((resolve) => setTimeout(resolve, 0));
        assertEquals(settled, false);

        releaseFence.resolve();
        const result = await host.outcomes[0];
        assertEquals(
          (result.error as Error)?.message,
          "authorized checkpoint failed",
        );
        assertEquals(lifecycle.map((event) => event.status), [
          "invoked",
          "failed",
        ]);
        assertEquals(authorizations > 0, true);
        const logical = await f.catalog.read(
          contentStreamBodyId("scope", handle.id),
        );
        assertEquals(logical?.terminal?.length, 8);
        assertEquals(
          (await f.store.head({ bodyId: logical!.copy.key }))?.byteLength,
          17,
        );
        assertEquals(
          await new Response(
            await openLogicalBody(
              f.catalog,
              logical!.bodyId,
              () => f.store,
            ),
          ).text(),
          "accepted",
        );
        if (method === "streams.open") {
          const projected = await operations.getStream(
            "scope",
            root.id,
            handle.id,
          );
          assertEquals(projected?.state, "terminal");
          assertEquals(projected?.committedOffset, 8);
          assertEquals(
            projected?.outcome,
            failureFirst ? "failed" : "cancelled",
          );
        }
        assertEquals(
          logical?.terminal?.outcome,
          failureFirst ? "failed" : "cancelled",
        );
        assertEquals(
          logical?.terminal?.reason,
          failureFirst ? "writer_failed" : "worker_context_closed",
        );
      } finally {
        checkpoint.resolve(0);
        releaseFence.resolve();
        await host.close();
        await f.close();
      }
    });
  }
}

Deno.test("authorized invoker writer facades retain background failure for streams and content capture", (t) =>
  authorizedWriterFailure(t, false));
Deno.test("autonomous writer failure cleans its accepted prefix before its authorized invocation can finish", (t) =>
  authorizedWriterFailure(t, true));

Deno.test("an authorized invoker keeps a quiet writer live through real checkpoint and renewal deadlines", async () => {
  const f = await fixture(), renewed = Promise.withResolvers<void>();
  const lifecycle: ActionLifecycleInput[] = [];
  let checkpoints = 0, renewals = 0, checks = 0;
  const catalog: ContentCatalog = {
    ...f.catalog,
    async checkpoint(input) {
      const result = await f.catalog.checkpoint(input);
      checkpoints++;
      return result;
    },
    async renew(input) {
      const result = await f.catalog.renew(input);
      renewals++;
      renewed.resolve();
      return result;
    },
  };
  const host = await capabilityFixture(
    [undefined],
    async (registry, signal) => {
      const processor = createProcessorContext({
        base: {
          databaseSchema: f.schema,
          event: {
            durable: false,
            namespace: "scope",
            type: "test.root",
            payload: {},
            metadata: {},
            correlationId: "quiet",
            createdAt: new Date().toISOString(),
          },
          signal,
          idempotencyKey: "quiet",
          createMutationIdentity: () => ({}),
        },
        registry,
        assets: { catalog },
        collections: { withScope: () => ({}), vectors: () => ({}) },
        streamBodyStore: f.store,
        operations: {},
        publishLocalStream: () => Promise.resolve(),
        authorizeAction: () => {
          checks++;
          return Promise.resolve();
        },
        actionLifecycle: {
          emit(input: ActionLifecycleInput) {
            lifecycle.push(input);
            return Promise.resolve({ deduplicated: false });
          },
          invoked: () => Promise.resolve(null),
          terminal: () => Promise.resolve(null),
        },
      } as never);
      return await processor.actions.run(
        {} as never,
        { operationKey: "invoke" } as never,
      );
    },
  );
  const expired = Promise.withResolvers<never>();
  const watchdog = setTimeout(
    () => expired.reject(new Error("writer renewal did not settle")),
    35_000,
  );
  try {
    const context = host.ids[0];
    const handle = await host.call({
      kind: "call",
      context,
      path: ["streams", "open"],
      args: [{ id: "quiet", mediaType: "text/plain", role: "output" }],
    }) as { handle: string; id: string };
    for (const id of ["first", "second"]) {
      await host.call({
        kind: "call",
        context,
        id: handle.handle,
        path: ["append"],
        args: [{ appendId: id, bytes: bytes(id) }],
      });
    }
    const initialChecks = checks;
    await Promise.race([
      renewed.promise,
      expired.promise,
      host.outcomes[0].then((outcome) => {
        throw outcome.error ??
          new Error("writer invocation ended before renewal");
      }),
    ]);
    assertEquals(checkpoints, 2);
    assertEquals(renewals, 1);
    assertEquals(checks > initialChecks, true);
    assertEquals(
      (await f.catalog.read(contentStreamBodyId("scope", handle.id)))
        ?.committedOffset,
      11,
    );
    await host.call({
      kind: "call",
      context,
      id: handle.handle,
      path: ["close"],
      args: [{ assetId: "asset" }],
    });
    await host.call({ kind: "complete", id: context, value: "quiet success" });
    assertEquals(await host.outcomes[0], { value: "quiet success" });
    assertEquals(lifecycle.map((event) => event.status), [
      "invoked",
      "completed",
    ]);
  } finally {
    clearTimeout(watchdog);
    await host.close();
    await f.close();
  }
});

Deno.test("writer scheduled policy is installed before held post-open disclosure and rechecks revocation", async () => {
  const f = await fixture(),
    disclosed = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    renewed = Promise.withResolvers<void>();
  let acquired = false, held = false, allowed = true, renewals = 0;
  let raw: ContentStreamWriter | undefined;
  const runtime = f.runtime({
    protectionMs: 100,
    catalog: {
      ...f.catalog,
      async renew(input) {
        const result = await f.catalog.renew(input);
        renewals++;
        renewed.resolve();
        return result;
      },
    },
  });
  const guarded = authorizeActionCapabilities(
    {
      streams: {
        ...runtime,
        async open(input: Parameters<typeof runtime.open>[0]) {
          raw = await runtime.open(input);
          acquired = true;
          return raw;
        },
      },
    } as unknown as ActionContext,
    () => {
      if (!allowed) throw new Error("writer policy revoked");
    },
    () => {},
    undefined,
    async () => {
      if (!allowed) throw new Error("writer policy revoked");
      if (acquired && !held) {
        held = true;
        disclosed.resolve();
        await release.promise;
      }
    },
  );
  const opening = guarded.streams.open({
    id: "held-disclosure",
    mediaType: "text/plain",
    role: "output",
  });
  void opening.catch(() => undefined);
  const expired = Promise.withResolvers<never>();
  const watchdog = setTimeout(
    () => expired.reject(new Error("held disclosure prevented writer renewal")),
    1000,
  );
  try {
    await disclosed.promise;
    await Promise.race([renewed.promise, expired.promise]);
    assertEquals(renewals, 1);
    release.resolve();
    const writer = await opening;
    const failed = Promise.withResolvers<unknown>();
    const remove = observeContentStreamFailure(writer, failed.resolve);
    allowed = false;
    await assertRejects(
      () => writer.append({ appendId: "denied", bytes: bytes("denied") }),
      Error,
      "writer policy revoked",
    );
    const reason = await Promise.race([failed.promise, expired.promise]);
    remove();
    assertEquals((reason as Error).message, "writer policy revoked");
    assertEquals(renewals, 1);
    assertEquals(
      (await f.catalog.read(contentStreamBodyId("scope", raw!.id)))
        ?.committedOffset,
      0,
    );
  } finally {
    clearTimeout(watchdog);
    release.resolve();
    await opening.catch(() => undefined);
    await raw?.abort().catch(() => undefined);
    await f.close();
  }
});

Deno.test("a failed stale writer cannot revoke or fence its replacement", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let fences = 0;
  const runtime = f.runtime({
    store: {
      ...f.store,
      async append() {
        entered.resolve();
        await release.promise;
        throw new Error("old append failed");
      },
      fence(input) {
        fences++;
        return f.store.fence(input);
      },
    },
  });
  const writer = await runtime.open({
    id: "replacement",
    mediaType: "text/plain",
    role: "output",
  });
  const bodyId = contentStreamBodyId("scope", writer.id);
  try {
    const appending = writer.append({ appendId: "old", bytes: bytes("old") });
    const rejected = assertRejects(() => appending, Error, "old append failed");
    await entered.promise;
    await createSchemaCommandRunner(f.db, f.schema)(
      "test.replaceWriter",
      {},
      async (_input, command) => {
        await command.transaction.query(
          `UPDATE "${f.schema}".content_logical_bodies SET writer_id='replacement',generation=2 WHERE body_id=$1`,
          [bodyId],
        );
      },
    );
    release.resolve();
    await rejected;
    await assertRejects(
      () => writer.abort(),
      Error,
      "Content writer identity is stale",
    );
    const logical = await f.catalog.read(bodyId);
    assertEquals(logical?.writerId, "replacement");
    assertEquals(logical?.generation, 2);
    assertEquals(logical?.revocation, "active");
    assertEquals(logical?.terminal, undefined);
    assertEquals(fences, 0);
  } finally {
    release.resolve();
    await f.close();
  }
});

Deno.test("ordinary public abort cannot bypass revoked writer policy with a failure reason", async () => {
  const f = await fixture();
  let allowed = true, fences = 0;
  const runtime = f.runtime({
    store: {
      ...f.store,
      fence(input) {
        fences++;
        return f.store.fence(input);
      },
    },
  });
  const guarded = authorizeActionCapabilities(
    { streams: runtime } as unknown as ActionContext,
    () => {
      if (!allowed) throw new Error("writer policy revoked");
    },
    () => {
      if (!allowed) throw new Error("writer policy revoked");
    },
  );
  const writer = await guarded.streams.open({
    id: "public-abort",
    mediaType: "text/plain",
    role: "output",
  });
  const id = writer.id, abortWriter = writer.abort;
  try {
    allowed = false;
    await assertRejects(
      async () =>
        await abortWriter({ outcome: "cancelled", reason: "writer_failed" }),
      Error,
      "writer policy revoked",
    );
    const logical = await f.catalog.read(
      contentStreamBodyId("scope", id),
    );
    assertEquals(logical?.revocation, "active");
    assertEquals(logical?.terminal, undefined);
    assertEquals(fences, 0);
  } finally {
    allowed = true;
    await writer.abort();
    await f.close();
  }
});

Deno.test("failure cleanup does not detach generic terminal callbacks from their call guard", async () => {
  const f = await fixture(),
    renewal = Promise.withResolvers<string>(),
    entered = Promise.withResolvers<void>(),
    callback = Promise.withResolvers<unknown>();
  let effects = 0, fences = 0, enabled = true;
  const command = createSchemaCommandRunner(f.db, f.schema);
  const runtime = f.runtime({
    protectionMs: 100,
    catalog: {
      ...f.catalog,
      renew() {
        entered.resolve();
        return renewal.promise;
      },
    },
    store: {
      ...f.store,
      fence(input) {
        fences++;
        return f.store.fence(input);
      },
    },
    async onTerminalizing() {
      if (!enabled) return;
      try {
        await command("test.genericTerminalMutation", {}, () => {
          effects++;
        });
        callback.resolve(undefined);
      } catch (error) {
        callback.resolve(error);
        throw error;
      }
    },
  });
  let raw: ContentStreamWriter | undefined;
  const guarded = authorizeActionCapabilities(
    {
      streams: {
        ...runtime,
        async open(input: Parameters<typeof runtime.open>[0]) {
          return raw = await runtime.open(input);
        },
      },
    } as unknown as ActionContext,
    () => {},
    () => {},
  );
  const writer = await guarded.streams.open({
    id: "generic-callback",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    await entered.promise;
    renewal.reject(new Error("renewal rejected"));
    assertEquals(
      (await callback.promise as Error)?.message,
      "Action capability lifetime has ended.",
    );
    assertEquals(effects, 0);
    assertEquals(fences, 0);
    assertEquals(
      (await f.catalog.read(contentStreamBodyId("scope", writer.id)))?.terminal,
      undefined,
    );
  } finally {
    enabled = false;
    renewal.resolve("");
    await raw?.abort();
    await f.close();
  }
});

Deno.test("abort captures the first admitted outcome and reason before queued physical work", async () => {
  const f = await fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const runtime = f.runtime({
    store: {
      ...f.store,
      async append(input) {
        entered.resolve();
        await release.promise;
        return await f.store.append(input);
      },
    },
  });
  const writer = await runtime.open({
    id: "abort-snapshot",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    const appending = writer.append({
      appendId: "first",
      bytes: bytes("first"),
    });
    await entered.promise;
    const input = { outcome: "cancelled", reason: "first" };
    const aborting = writer.abort(input as ContentStreamAbortInput);
    input.outcome = "completed";
    input.reason = "changed";
    const second = writer.abort({ outcome: "failed", reason: "second" });
    release.resolve();
    await Promise.all([appending, aborting, second]);
    const logical = await f.catalog.read(
      contentStreamBodyId("scope", writer.id),
    );
    assertEquals(logical?.terminal?.outcome, "cancelled");
    assertEquals(logical?.terminal?.reason, "first");
    assertEquals(logical?.terminal?.length, 5);
  } finally {
    release.resolve();
    await writer.abort();
    await f.close();
  }
});

Deno.test("forged completed or invalid abort wire input cannot admit a successful terminal", async () => {
  const f = await fixture();
  let fences = 0;
  const runtime = f.runtime({
    store: {
      ...f.store,
      fence(input) {
        fences++;
        return f.store.fence(input);
      },
    },
  });
  const host = await capabilityFixture([runtime]);
  try {
    const context = host.ids[0];
    const handle = await host.call({
      kind: "call",
      context,
      path: ["streams", "open"],
      args: [{ id: "forged-abort", mediaType: "text/plain", role: "output" }],
    }) as { handle: string; id: string };
    for (
      const input of [{ outcome: "completed" }, { outcome: "unknown" }, {
        outcome: "failed",
        reason: {},
      }]
    ) {
      await assertRejects(
        () =>
          host.call({
            kind: "call",
            context,
            id: handle.handle,
            path: ["abort"],
            args: [input],
          }),
        Error,
        "Abort requires",
      );
      const logical = await f.catalog.read(
        contentStreamBodyId("scope", handle.id),
      );
      assertEquals(logical?.revocation, "active");
      assertEquals(logical?.terminal, undefined);
      assertEquals(fences, 0);
    }
    await host.call({
      kind: "call",
      context,
      id: handle.handle,
      path: ["abort"],
      args: [{ outcome: "cancelled", reason: "valid" }],
    });
    assertEquals(
      (await f.catalog.read(contentStreamBodyId("scope", handle.id)))?.terminal
        ?.outcome,
      "cancelled",
    );
    await host.call({ kind: "complete", id: context, value: "input rejected" });
    assertEquals(await host.outcomes[0], { value: "input rejected" });
  } finally {
    await host.close();
    await f.close();
  }
});

Deno.test("captured invocation cancellation admits only its fixed accepted-prefix cleanup", async () => {
  const f = await fixture(), cancellation = new AbortController();
  let allowed = true, raw: ContentStreamWriter | undefined, fences = 0;
  const runtime = f.runtime({
    signal: cancellation.signal,
    store: {
      ...f.store,
      fence(input) {
        fences++;
        return f.store.fence(input);
      },
    },
  });
  const guarded = authorizeActionCapabilities({
    streams: {
      ...runtime,
      async open(input: Parameters<typeof runtime.open>[0]) {
        return raw = await runtime.open(input);
      },
    },
  } as unknown as ActionContext, () => {
    if (!allowed) throw new Error("writer policy revoked");
  }, () => {
    if (!allowed) throw new Error("writer policy revoked");
  });
  const writer = await guarded.streams.open({
    id: "captured-cancellation",
    mediaType: "text/plain",
    role: "output",
  });
  const id = writer.id, publicAbort = writer.abort;
  try {
    await writer.append({ appendId: "accepted", bytes: bytes("accepted") });
    allowed = false;
    cancellation.abort(new DOMException("invocation stopped", "AbortError"));
    await raw!.abort({ outcome: "failed", reason: "untrusted choice" });
    await assertRejects(
      async () => await publicAbort({ reason: "writer_failed" }),
      Error,
      "writer policy revoked",
    );
    const logical = await f.catalog.read(contentStreamBodyId("scope", id));
    assertEquals(logical?.terminal?.outcome, "cancelled");
    assertEquals(logical?.terminal?.reason, "cancelled");
    assertEquals(logical?.terminal?.length, 8);
    assertEquals(fences, 1);
  } finally {
    allowed = true;
    await raw?.abort();
    await f.close();
  }
});

Deno.test("a public retry after uncertain private cleanup retains its command policy", async () => {
  const f = await fixture(),
    renewal = Promise.withResolvers<string>(),
    entered = Promise.withResolvers<void>(),
    uncertain = Promise.withResolvers<void>();
  let allowed = true, fences = 0;
  const runtime = f.runtime({
    protectionMs: 100,
    catalog: {
      ...f.catalog,
      renew() {
        entered.resolve();
        return renewal.promise;
      },
    },
    store: {
      ...f.store,
      fence(input) {
        if (++fences === 1) {
          uncertain.resolve();
          return Promise.reject(new Error("private fence uncertain"));
        }
        return f.store.fence(input);
      },
    },
  });
  const guarded = authorizeActionCapabilities(
    { streams: runtime } as unknown as ActionContext,
    () => {
      if (!allowed) throw new Error("writer command policy revoked");
    },
    () => {},
  );
  const writer = await guarded.streams.open({
    id: "uncertain-retry",
    mediaType: "text/plain",
    role: "output",
  });
  const id = writer.id, retry = writer.abort;
  try {
    await entered.promise;
    renewal.reject(new Error("renewal failed"));
    await uncertain.promise;
    // The rejected terminal task must have settled before testing a new retry.
    await new Promise((resolve) => setTimeout(resolve, 0));
    allowed = false;
    await assertRejects(
      async () =>
        await retry({ outcome: "cancelled", reason: "worker choice" }),
      Error,
      "writer command policy revoked",
    );
    assertEquals(fences, 1);
    const pending = await f.catalog.read(contentStreamBodyId("scope", id));
    assertEquals(pending?.revocation, "revoking");
    assertEquals(pending?.terminal, undefined);
    allowed = true;
    await retry({ outcome: "cancelled", reason: "worker choice" });
    const logical = await f.catalog.read(contentStreamBodyId("scope", id));
    assertEquals(logical?.terminal?.outcome, "failed");
    assertEquals(logical?.terminal?.reason, "writer_failed");
    assertEquals(logical?.terminal?.length, 0);
    assertEquals(fences, 2);
  } finally {
    allowed = true;
    renewal.resolve("");
    await retry();
    await f.close();
  }
});

Deno.test("an uncertain terminal retry preserves the first admitted cancellation", async () => {
  const f = await fixture();
  let fences = 0;
  const runtime = f.runtime({
    store: {
      ...f.store,
      fence(input) {
        if (++fences === 1) {
          return Promise.reject(new Error("first fence uncertain"));
        }
        return f.store.fence(input);
      },
    },
  });
  const writer = await runtime.open({
    id: "first-terminal",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    await assertRejects(
      () => writer.abort({ outcome: "cancelled", reason: "first" }),
      Error,
      "first fence uncertain",
    );
    await writer.abort({ outcome: "failed", reason: "later" });
    const logical = await f.catalog.read(
      contentStreamBodyId("scope", writer.id),
    );
    assertEquals(logical?.terminal?.outcome, "cancelled");
    assertEquals(logical?.terminal?.reason, "first");
    assertEquals(fences, 2);
  } finally {
    await writer.abort();
    await f.close();
  }
});
