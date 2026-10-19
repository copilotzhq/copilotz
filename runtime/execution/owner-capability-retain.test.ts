/** Characterizes sealed stream retention at both real capability layers. @module */
import { assert, assertEquals, assertRejects } from "@std/assert";
import type { WorkerCallContext } from "../../dependencies/oxian-hypervisor.ts";
import type { WorkerWorkHandler } from "../../dependencies/oxian-worker.ts";
import { defineAction } from "../actions/define.ts";
import { authorizeActionCapabilities } from "../actions/capability-authorization.ts";
import type { ActionContext } from "../actions/types.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import type {
  ContentStreamRetentionInput,
  ContentStreamWriter,
} from "../streams/types.ts";
import { createOwnerCapabilityHost } from "./owner-capabilities.ts";
import { createOwnerWorkerWorkloads } from "./owner-capability-worker.ts";
import {
  type CapabilityCall,
  type CapabilityPoll,
  decodeCapability,
  encodeCapability,
  OWNER_CAPABILITY_WORKLOAD,
  readCapability,
} from "./owner-capability-wire.ts";

function body(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(bytes);
      c.close();
    },
  });
}

function fixture(
  execute: (context: ActionContext) => Promise<unknown>,
  failClose = false,
  options: {
    captureOnly?: boolean;
    onClose?: () => Promise<void>;
    onAbort?: () => Promise<void>;
    onRetain?: () => Promise<void>;
    authorizeAction?: () => Promise<void>;
  } = {},
) {
  const retained: ContentStreamRetentionInput[] = [];
  const calls: CapabilityCall[] = [];
  let physicalAppends = 0;
  let epoch = 1;
  const abort = new AbortController();
  // The physical stream is deliberately synthetic. Production host, worker,
  // resource accounting, invocation lifetime and the wire codec are real.
  const openWriter = () => {
    let sealed = false, aborted = false;
    return {
      id: "stream",
      offset: () => 0,
      append: () => {
        physicalAppends++;
        return Promise.resolve({ startOffset: 0, endOffset: 0 });
      },
      close: async () => {
        await options.onClose?.();
        if (failClose) return Promise.reject(new Error("physical seal failed"));
        sealed = true;
        return Promise.resolve({ sealed: true });
      },
      abort: async () => {
        await options.onAbort?.();
        aborted = true;
        return Promise.resolve();
      },
      ...(options.captureOnly ? {} : {
        async retain(input: ContentStreamRetentionInput) {
          assert(
            sealed && !aborted,
            "retention requires successfully sealed content",
          );
          await options.onRetain?.();
          retained.push(structuredClone(input));
        },
      }),
    };
  };
  const registry = createPluginRegistry({
    actions: {
      run: defineAction({
        id: "test.sealed-retain",
        execute: (_input: unknown, context: ActionContext) => execute(context),
      }),
    },
  });
  const context = {
    namespace: "scope",
    databaseSchema: "public",
    operationKey: "operation",
    identity: { settlementScopeId: "operation" },
    signal: abort.signal,
    now: () => new Date(0),
    streams: { open: () => Promise.resolve(openWriter()) },
  } as unknown as ActionContext;
  // Exercise the real function-Proxy facade used by the Action invoker.
  const authorizedContext = options.authorizeAction
    ? authorizeActionCapabilities(
      context,
      () => Promise.resolve(),
      () => abort.signal.throwIfAborted(),
      undefined,
      options.authorizeAction,
    )
    : context;
  const host = createOwnerCapabilityHost({
    registry,
    localExecution: true,
    resolveAuthority: () => Promise.resolve({ epoch, signal: abort.signal }),
    createWorkloads: ({ registry }) => ({
      test: async () => {
        await registry.actions.run.execute(
          {} as never,
          authorizedContext as never,
        );
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
  const call = async (input: CapabilityCall, source = binding) => {
    calls.push(input);
    const handler = await host.workerCalls.admit(source);
    assert(handler);
    const encoded = await handler(
      { input: body(encodeCapability(input)), signal: abort.signal } as never,
    );
    const response = await readCapability(body(encoded as Uint8Array)) as {
      value?: unknown;
      error?: Error;
    };
    if (response.error) throw response.error;
    return response.value;
  };
  const work: Parameters<WorkerWorkHandler>[0] = {
    streamId: "parent",
    workload: "test",
    metadata: {},
    signal: abort.signal,
    input: body(new Uint8Array()),
    sendMetadata: () => Promise.resolve(),
    async callHost(request) {
      assert(request.body instanceof Uint8Array);
      let response;
      try {
        response = {
          value: await call(decodeCapability(request.body) as CapabilityCall),
        };
      } catch (error) {
        response = { error };
      }
      return {
        streamId: "host-call",
        metadata: Promise.resolve({}),
        started: Promise.resolve(),
        cancel: () => Promise.resolve(),
        output: body(encodeCapability(response)),
        completed: Promise.resolve(),
      };
    },
  };
  return {
    call,
    binding,
    calls,
    retained,
    physicalAppends: () => physicalAppends,
    host,
    setEpoch(value: number) {
      epoch = value;
    },
    run: () =>
      createOwnerWorkerWorkloads({ registry, workloads: ["test"] }).test(work),
    close: () => host.close(),
  };
}

Deno.test("real worker-facing sealed writer retains the exact canonical selection repeatedly", async () => {
  const selection = { retention: "canonical", assetId: "asset" } as const;
  const f = fixture(async (context) => {
    const writer = await context.streams.open({
      id: "stream",
      mediaType: "text/plain",
      role: "output",
    });
    await writer.close({ assetId: "asset" });
    await writer.retain(selection);
    await writer.retain(selection);
  });
  try {
    await f.run();
    assertEquals(f.retained, [selection, selection]);
    assertEquals(f.host.snapshot().resources, 0);
  } finally {
    await f.close();
  }
});

Deno.test("remote owner keeps a bounded sealed retain capability until invocation cleanup", async () => {
  const f = fixture(() => Promise.resolve());
  try {
    await f.call({ kind: "open", value: new Uint8Array() });
    const poll = await f.call({ kind: "next" }) as CapabilityPoll;
    const context = poll.invocation!.context;
    const writer = await f.call({
      kind: "call",
      context,
      path: ["streams", "open"],
      args: [{}],
    }) as { handle: string };
    await f.call({
      kind: "call",
      context,
      id: writer.handle,
      path: ["close"],
      args: [{}],
    });
    const selection = { retention: "observation" } as const;
    await f.call({
      kind: "call",
      context,
      id: writer.handle,
      path: ["retain"],
      args: [selection],
    });
    await f.call({
      kind: "call",
      context,
      id: writer.handle,
      path: ["retain"],
      args: [selection],
    });
    assertEquals(f.retained, [selection, selection]);
    assertEquals(f.host.snapshot().resources, 1);
    await f.call({ kind: "complete", id: context });
    assertEquals((await f.call({ kind: "next" }) as CapabilityPoll).done, true);
    assertEquals(f.host.snapshot().resources, 0);
  } finally {
    await f.close();
  }
});

Deno.test("worker sealed and aborted writers cannot append or close again", async () => {
  for (const finish of ["close", "abort"] as const) {
    let leaked: ContentStreamWriter | undefined;
    const f = fixture(async (context) => {
      const writer = await context.streams.open({
        id: "stream",
        mediaType: "text/plain",
        role: "output",
      });
      leaked = writer;
      if (finish === "close") await writer.close({ assetId: "asset" });
      else await writer.abort();
      await assertRejects(
        () => writer.append({ appendId: "late", bytes: new Uint8Array() }),
        Error,
        "owner_handle_closed",
      );
      await assertRejects(
        () => writer.close({ assetId: "asset" }),
        Error,
        "owner_handle_closed",
      );
      if (finish === "abort") {
        await assertRejects(
          () => writer.retain({ retention: "observation" }),
          Error,
          "owner_handle_closed",
        );
      }
    });
    try {
      await f.run();
      assertEquals(f.retained, []);
      assertEquals(f.host.snapshot().resources, 0);
      await assertRejects(
        () => leaked!.retain({ retention: "observation" }),
        Error,
        "owner_assignment_ended",
      );
    } finally {
      await f.close();
    }
  }
});

Deno.test("sealed retain cannot cross a retired owner epoch or substituted session", async () => {
  for (const revoke of ["epoch", "session"] as const) {
    const f = fixture(() => Promise.resolve());
    try {
      await f.call({ kind: "open", value: new Uint8Array() });
      const poll = await f.call({ kind: "next" }) as CapabilityPoll;
      const context = poll.invocation!.context;
      const writer = await f.call({
        kind: "call",
        context,
        path: ["streams", "open"],
        args: [{}],
      }) as { handle: string };
      await f.call({
        kind: "call",
        context,
        id: writer.handle,
        path: ["close"],
        args: [{}],
      });
      if (revoke === "epoch") f.setEpoch(2);
      const binding = revoke === "session"
        ? { ...f.binding, fence: { ...f.binding.fence, sessionGeneration: 2 } }
        : f.binding;
      await assertRejects(() =>
        f.call({
          kind: "call",
          context,
          id: writer.handle,
          path: ["retain"],
          args: [{ retention: "observation" }],
        }, binding)
      );
      assertEquals(f.retained, []);
    } finally {
      await f.close();
    }
  }
});

Deno.test({
  name: "PostgreSQL repeated retain keeps the same stream and body identity",
  ignore: !Deno.env.get("COPILOTZ_TEST_POSTGRES_URL"),
  async fn() {
    const { createTestDatabase } = await import("../testing/ominipg.ts");
    const { provisionCopilotzSchema } = await import("../events/schema.ts");
    const { openDatabaseOwner, createSchemaCommandRunner } = await import(
      "../engine/commands.ts"
    );
    const { createOperationCatalog, provisionOperationCatalog } = await import(
      "../streams/catalog.ts"
    );
    const { createStreamOutputDescriptor } = await import(
      "../streams/observation.ts"
    );
    const { recordTestContentTerminal } = await import(
      "../testing/content-catalog.ts"
    );
    const db = await createTestDatabase({
      url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL")!,
    });
    const schema = `retain_identity_${crypto.randomUUID().replaceAll("-", "")}`;
    await provisionCopilotzSchema(db, schema);
    await provisionOperationCatalog(db, schema);
    const owner = await openDatabaseOwner(db, schema);
    const catalog = createOperationCatalog(db, schema);
    try {
      await createSchemaCommandRunner(db, schema)(
        "test.index",
        {},
        (_input, { transaction }) =>
          catalog.indexEvent(transaction, {
            namespace: "scope",
            operationId: "operation",
            eventId: "operation",
            position: "1",
            correlationId: "retention",
            createdAt: new Date(0).toISOString(),
            metadata: {},
          }),
      );
      const coordinate = {
        namespace: "scope",
        operationId: "operation",
        streamId: "stream",
      };
      const descriptor = createStreamOutputDescriptor({
        id: "stream",
        semanticId: "stream",
        metadata: {},
        mediaType: "text/plain",
        kind: "text",
        role: "output",
      }, { namespace: "scope" });
      await catalog.openStream({
        ...coordinate,
        semanticStreamId: "stream",
        bodyId: "body",
        descriptor,
      });
      const head = {
        bodyId: "body",
        byteLength: 1,
        mediaType: "text/plain",
        digest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
      };
      await recordTestContentTerminal(db, schema, "scope", head);
      await catalog.sealStream({
        ...coordinate,
        body: {
          ...head,
          state: "ready",
          maintenanceVersion: 1,
          versionToken: "test-version",
        },
      });
      const identity = (
        stream: NonNullable<Awaited<ReturnType<typeof catalog.getStream>>>,
      ) => ({
        replayKey: stream.replayKey,
        streamOrdinal: stream.streamOrdinal,
        bodyId: stream.bodyId,
        state: stream.state,
        outcome: stream.outcome,
        committedOffset: stream.committedOffset,
        terminalAt: stream.terminalAt,
      });
      const before = await catalog.getStream("scope", "operation", "stream");
      assert(before);
      for (
        const selection of [{ retention: "observation" }, {
          retention: "canonical",
          assetId: "asset",
        }] as const
      ) {
        await catalog.retainStream({ ...coordinate, ...selection });
        await catalog.retainStream({ ...coordinate, ...selection });
        const after = await catalog.getStream("scope", "operation", "stream");
        assert(after);
        assertEquals(identity(after), identity(before));
        assertEquals(after.retention, selection.retention);
        assertEquals(
          after.assetId,
          "assetId" in selection ? selection.assetId : undefined,
        );
        assertEquals(
          (await catalog.listStreams({
            namespace: "scope",
            operationId: "operation",
          })).length,
          1,
        );
      }
    } finally {
      owner.stop();
      await db.close();
    }
  },
});

Deno.test("a failed physical seal cannot select retention", async () => {
  const f = fixture(async (context) => {
    const writer = await context.streams.open({
      id: "stream",
      mediaType: "text/plain",
      role: "output",
    });
    await assertRejects(
      () => writer.close({ assetId: "asset" }),
      Error,
      "physical seal failed",
    );
    await assertRejects(
      () => writer.retain({ retention: "canonical", assetId: "asset" }),
      Error,
      "owner_handle_not_sealed",
    );
  }, true);
  try {
    await f.run();
    assertEquals(f.retained, []);
    assertEquals(f.host.snapshot().resources, 0);
  } finally {
    await f.close();
  }
});

Deno.test("accounting: 64 sequential close without retain plus disposal releases every slot", async () => {
  const f = fixture(async (context) => {
    for (let i = 0; i < 64; i++) {
      const writer = await context.streams.open({
        id: `stream-${i}`,
        mediaType: "text/plain",
        role: "output",
      });
      await writer.close({ assetId: `asset-${i}` });
      assertEquals(f.host.snapshot().resources, 1);
      await writer[Symbol.asyncDispose]();
      assertEquals(f.host.snapshot().resources, 0);
    }
  });
  try {
    await f.run();
    assertEquals(f.host.snapshot().resources, 0);
  } finally {
    await f.close();
  }
});

Deno.test("accounting baseline: 32 live slots refuse the next open until explicit disposal", async () => {
  const f = fixture(async (context) => {
    const writers: ContentStreamWriter[] = [];
    for (let i = 0; i < 32; i++) {
      writers.push(
        await context.streams.open({
          id: `stream-${i}`,
          mediaType: "text/plain",
          role: "output",
        }),
      );
    }
    assertEquals(f.host.snapshot().resources, 32);
    await assertRejects(
      () =>
        context.streams.open({
          id: "overflow",
          mediaType: "text/plain",
          role: "output",
        }),
      Error,
      "owner_capacity",
    );
    await writers[0][Symbol.asyncDispose]();
    assertEquals(f.host.snapshot().resources, 31);
    writers.push(
      await context.streams.open({
        id: "replacement",
        mediaType: "text/plain",
        role: "output",
      }),
    );
    assertEquals(f.host.snapshot().resources, 32);
    for (const writer of writers.slice(1)) await writer[Symbol.asyncDispose]();
    assertEquals(f.host.snapshot().resources, 0);
  });
  try {
    await f.run();
    assertEquals(f.host.snapshot().resources, 0);
  } finally {
    await f.close();
  }
});

Deno.test("accounting contract: 64 sequential close retain repeat dispose cycles release every slot", async () => {
  const f = fixture(async (context) => {
    for (let i = 0; i < 64; i++) {
      const writer = await context.streams.open({
        id: `stream-${i}`,
        mediaType: "text/plain",
        role: "output",
      });
      await writer.close({ assetId: `asset-${i}` });
      const selection = {
        retention: "canonical",
        assetId: `asset-${i}`,
      } as const;
      await writer.retain(selection);
      await writer.retain(selection);
      await writer[Symbol.asyncDispose]();
      assertEquals(f.host.snapshot().resources, 0);
    }
  });
  try {
    await f.run();
    assertEquals(f.retained.length, 128);
  } finally {
    await f.close();
  }
});

for (const retain of [false, true]) {
  Deno.test(`accounting contract: 32 undisposed sealed ${retain ? "retained" : "unselected"} handles stay bounded`, async () => {
    const f = fixture(async (context) => {
      const writers: ContentStreamWriter[] = [];
      for (let i = 0; i < 32; i++) {
        const writer = await context.streams.open({
          id: `stream-${i}`,
          mediaType: "text/plain",
          role: "output",
        });
        await writer.close({ assetId: `asset-${i}` });
        if (retain) {
          await writer.retain({ retention: "observation" });
          await writer.retain({ retention: "observation" });
        }
        writers.push(writer);
      }
      assertEquals(f.host.snapshot().resources, 32);
      await assertRejects(
        () =>
          context.streams.open({
            id: "overflow",
            mediaType: "text/plain",
            role: "output",
          }),
        Error,
        "owner_capacity",
      );
      await writers[0][Symbol.asyncDispose]();
      assertEquals(f.host.snapshot().resources, 31);
      const replacement = await context.streams.open({
        id: "replacement",
        mediaType: "text/plain",
        role: "output",
      });
      await replacement.abort();
      for (const writer of writers.slice(1)) {
        await writer[Symbol.asyncDispose]();
      }
      assertEquals(f.host.snapshot().resources, 0);
    });
    try {
      await f.run();
      assertEquals(f.host.snapshot().resources, 0);
    } finally {
      await f.close();
    }
  });
}

async function rawWriter(f: ReturnType<typeof fixture>) {
  await f.call({ kind: "open", value: new Uint8Array() });
  const poll = await f.call({ kind: "next" }) as CapabilityPoll;
  const context = poll.invocation!.context;
  const descriptor = await f.call({
    kind: "call",
    context,
    path: ["streams", "open"],
    args: [{}],
  }) as { handle: string; retainAfterClose?: boolean };
  return { context, id: descriptor.handle, descriptor };
}

Deno.test("capture-only close releases immediately for 64 sequential worker writers", async () => {
  const f = fixture(
    async (context) => {
      for (let i = 0; i < 64; i++) {
        const writer = await context.streams.open({
          mediaType: "text/plain",
          role: "output",
        });
        await writer.close({ assetId: "asset" });
        assertEquals(f.host.snapshot().resources, 0);
        await writer[Symbol.asyncDispose]();
        await assertRejects(
          () => writer.retain({ retention: "observation" }),
          Error,
          "owner_handle_closed",
        );
      }
    },
    false,
    { captureOnly: true },
  );
  try {
    await f.run();
    assertEquals(f.retained, []);
  } finally {
    await f.close();
  }
});

Deno.test("worker-supplied shape hint cannot preserve a capture-only owner handle", async () => {
  const f = fixture(() => Promise.resolve(), false, { captureOnly: true });
  try {
    const { context, id, descriptor } = await rawWriter(f);
    assertEquals(descriptor.retainAfterClose, undefined);
    await f.call({
      kind: "call",
      context,
      id,
      path: ["close"],
      args: [{ retainAfterClose: true }],
      value: { retainAfterClose: true },
    });
    assertEquals(f.host.snapshot().resources, 0);
    await assertRejects(
      () =>
        f.call({
          kind: "call",
          context,
          id,
          path: ["retain"],
          args: [{ retention: "observation", retainAfterClose: true }],
        }),
      Error,
      "owner_handle_unknown",
    );
  } finally {
    await f.close();
  }
});

Deno.test("owner refuses append and reclose queued behind a physical seal", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const f = fixture(() => Promise.resolve(), false, {
    onClose: () => {
      entered.resolve();
      return release.promise;
    },
  });
  try {
    const { context, id } = await rawWriter(f);
    const closing = f.call({
      kind: "call",
      context,
      id,
      path: ["close"],
      args: [{}],
    });
    await entered.promise;
    const appended = assertRejects(
      () =>
        f.call({
          kind: "call",
          context,
          id,
          path: ["append"],
          args: [{ bytes: new Uint8Array([1]), appendId: "late" }],
        }),
      Error,
      "owner_handle_closed",
    );
    const reclosed = assertRejects(
      () => f.call({ kind: "call", context, id, path: ["close"], args: [{}] }),
      Error,
      "owner_handle_closed",
    );
    release.resolve();
    await Promise.all([closing, appended, reclosed]);
    assertEquals(f.physicalAppends(), 0);
    assertEquals(f.host.snapshot().resources, 1);
    await f.call({
      kind: "call",
      context,
      id,
      path: ["retain"],
      args: [{ retention: "observation" }],
    });
    await f.call({ kind: "close", context, id });
    await assertRejects(
      () =>
        f.call({
          kind: "call",
          context,
          id,
          path: ["retain"],
          args: [{ retention: "observation" }],
        }),
      Error,
      "owner_handle_unknown",
    );
  } finally {
    release.resolve();
    await f.close();
  }
});

Deno.test("retention result cannot escape after owner authority changes during selection", async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const f = fixture(() => Promise.resolve(), false, {
    onRetain: () => {
      entered.resolve();
      return release.promise;
    },
  });
  try {
    const { context, id } = await rawWriter(f);
    await f.call({ kind: "call", context, id, path: ["close"], args: [{}] });
    const selection = assertRejects(
      () =>
        f.call({
          kind: "call",
          context,
          id,
          path: ["retain"],
          args: [{ retention: "observation" }],
        }),
      Error,
      "retired owner epoch",
    );
    await entered.promise;
    f.setEpoch(2);
    release.resolve();
    await selection;
  } finally {
    release.resolve();
    await f.close();
  }
});

for (const unknown of [false, true]) {
  Deno.test(`disposal ${unknown ? "unknown" : "failed"} cleanup reserves the slot until physical close settles`, async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const cleanupEntered = Promise.withResolvers<void>();
    const cleanupError = Object.assign(new Error("cleanup failed"), {
      code: unknown ? "owner_cleanup_unknown" : "test_cleanup_failed",
    });
    const f = fixture(() => Promise.resolve(), false, {
      onClose: () => {
        entered.resolve();
        return release.promise;
      },
      onAbort: () => {
        cleanupEntered.resolve();
        return Promise.reject(cleanupError);
      },
    });
    try {
      const { context, id } = await rawWriter(f);
      const closing = assertRejects(
        () =>
          f.call({ kind: "call", context, id, path: ["close"], args: [{}] }),
        Error,
        "owner_handle_unknown",
      );
      await entered.promise;
      let disposed = false;
      const disposal = assertRejects(
        () => f.call({ kind: "close", context, id }),
        Error,
        "cleanup failed",
      ).then(() => {
        disposed = true;
      });
      await cleanupEntered.promise;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals(disposed, false);
      assertEquals(f.host.snapshot().resources, 1);
      release.resolve();
      await Promise.all([closing, disposal]);
      assertEquals(f.host.snapshot().resources, unknown ? 1 : 0);
    } finally {
      release.resolve();
      await f.close();
    }
  });
}

Deno.test("Action-authorized sealed writer retains repeatedly through the real host and worker", async () => {
  const selection = { retention: "canonical", assetId: "asset" } as const;
  let authorizationChecks = 0;
  const f = fixture(
    async (context) => {
      const writer = await context.streams.open({
        id: "stream",
        mediaType: "text/plain",
        role: "output",
      });
      await writer.close({ assetId: "asset" });
      const afterSeal = authorizationChecks;
      await writer.retain(selection);
      const afterFirstRetain = authorizationChecks;
      assert(afterFirstRetain > afterSeal);
      await writer.retain(selection);
      assert(authorizationChecks > afterFirstRetain);
      await writer[Symbol.asyncDispose]();
    },
    false,
    {
      authorizeAction: () => {
        authorizationChecks++;
        return Promise.resolve();
      },
    },
  );
  try {
    await f.run();
    assertEquals(f.retained, [selection, selection]);
    assertEquals(f.host.snapshot().resources, 0);
  } finally {
    await f.close();
  }
});

Deno.test("Action-authorized sealed retention rechecks current policy before the physical method", async () => {
  let permitted = true;
  const f = fixture(
    async (context) => {
      const writer = await context.streams.open({
        id: "stream",
        mediaType: "text/plain",
        role: "output",
      });
      await writer.close({ assetId: "asset" });
      permitted = false;
      const refusal = await assertRejects(
        () => writer.retain({ retention: "observation" }),
        Error,
        "post-seal retention authority revoked",
      );
      assertEquals(
        (refusal as Error & { code: string }).code,
        "retention_policy_revoked",
      );
      await writer[Symbol.asyncDispose]();
    },
    false,
    {
      authorizeAction: () =>
        permitted ? Promise.resolve() : Promise.reject(
          Object.assign(new Error("post-seal retention authority revoked"), {
            code: "retention_policy_revoked",
          }),
        ),
    },
  );
  try {
    await f.run();
    assertEquals(f.retained, []);
    assertEquals(f.host.snapshot().resources, 0);
  } finally {
    await f.close();
  }
});
