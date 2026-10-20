import { recoverLogicalBody } from "../content/maintenance.ts";
import {
  createPromotedBodyStore,
  promotedReadyStore,
} from "../content/promoted-body-store.ts";
import { createContentStreamRuntime } from "./stream.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase } from "../testing/ominipg.ts";
import { type ContentCopy, createContentCatalog } from "../content/catalog.ts";
import {
  type BodyStore,
  createMemoryBodyStore,
} from "../content/body-store.ts";
import { createProcessorContext } from "../engine/context.ts";
import {
  createSchemaCommandRunner,
  openDatabaseOwner,
} from "../engine/commands.ts";
import { createEventStore } from "../events/store.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import type { SqlSession } from "../events/session.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "./catalog.ts";
import type { StreamOutput } from "./types.ts";
import { contentStreamBodyId } from "./body-identity.ts";

type Phase = "checkpoint" | "intent" | "seal" | "failure";
async function fixture(
  transformStore: (store: BodyStore) => BodyStore = (store) => store,
  local = false,
) {
  const db = await createTestDatabase({
    url: Deno.env.get("COPILOTZ_TEST_POSTGRES_URL") ?? ":memory:",
    pgPoolMax: 4,
  });
  const schema = `accepted_transition_${
    crypto.randomUUID().replaceAll("-", "")
  }`;
  let fault: Phase | undefined,
    injected = 0,
    transactions = 0,
    loseCommit = false;
  let commitHold: {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  } | undefined;
  const session: SqlSession = {
    query: (sql, params) => db.query(sql, params),
    transaction: async (run) => {
      transactions++;
      const result = await db.transaction(async (transaction) => {
        const result = await run({
          query(sql, params) {
            const projection = sql.includes("UPDATE");
            const matches = fault === "checkpoint"
              ? sql.includes("content_logical_bodies") &&
                sql.includes("SET committed_offset=")
              : fault === "intent"
              ? sql.includes("SET state='terminating'")
              : fault === "seal"
              ? sql.includes("SET state='terminal'") &&
                params?.[3] === "completed"
              : fault === "failure" &&
                sql.includes("SET state='terminal'") &&
                params?.[3] !== "completed";
            if (projection && matches) {
              fault = undefined;
              injected++;
              throw new Error("projection write failed");
            }
            return transaction.query(sql, params);
          },
        });
        const hold = commitHold;
        commitHold = undefined;
        if (hold) {
          hold.entered.resolve();
          await hold.release.promise;
        }
        return result;
      });
      if (loseCommit) {
        loseCommit = false;
        throw new Error("commit reply lost");
      }
      return result;
    },
  };
  await provisionCopilotzSchema(session, schema);
  let owner = await openDatabaseOwner(session, schema);
  await provisionOperationCatalog(session, schema);
  const catalog = createContentCatalog(session, schema),
    operations = createOperationCatalog(session, schema),
    physical = createMemoryBodyStore();
  const runtimeStore = transformStore(physical);
  const ready = promotedReadyStore(runtimeStore);
  const storeForCopy = (copy: ContentCopy) =>
    copy.backendId === ready?.backendId ? ready! : runtimeStore;
  const events = createEventStore({
    session,
    schema,
    indexOperationEventSql: (input, param) =>
      operations.indexEventSql(input, param),
  });
  const root = (await events.append({
    namespace: "scope",
    type: "test.root",
    payload: {},
  })).event;
  const command = createSchemaCommandRunner(session, schema);
  const abort = new AbortController();
  const published: StreamOutput[] = [];
  const context = createProcessorContext({
    base: {
      databaseSchema: schema,
      event: root,
      signal: abort.signal,
      settlementScopeId: local ? undefined : root.id,
      idempotencyKey: "processor",
      createMutationIdentity: () => ({}),
    },
    registry: createPluginRegistry({}),
    assets: { catalog, storeForCopy },
    collections: { withScope: () => ({}), vectors: () => ({}) },
    operationCatalog: operations,
    streamBodyStore: runtimeStore,
    streamBodyPrefix: "bodies",
    operations: {},
    publishLocalStream(output: StreamOutput) {
      published.push(output);
      return Promise.resolve();
    },
    actionLifecycle: {},
  } as never);
  return {
    db,
    catalog,
    operations,
    physical,
    context,
    published,
    root,
    events,
    command,
    transactions: () => transactions,
    loseCommitReply() {
      loseCommit = true;
    },
    holdCommit() {
      const hold = {
        entered: Promise.withResolvers<void>(),
        release: Promise.withResolvers<void>(),
      };
      commitHold = hold;
      return hold;
    },
    async restart() {
      owner.stop();
      owner = await openDatabaseOwner(session, schema);
      const catalog = createContentCatalog(session, schema);
      return {
        catalog,
        operations: createOperationCatalog(session, schema),
        runtime: createContentStreamRuntime({
          namespace: "scope",
          bodyPrefix: "bodies",
          catalog,
          store: runtimeStore,
          storeForCopy,
        }),
      };
    },
    inject(phase: Phase) {
      fault = phase;
    },
    injected: () => injected,
    async close() {
      owner.stop();
      await db.query(`DROP SCHEMA "${schema}" CASCADE`);
      await db.close();
    },
  };
}

Deno.test("accepted stream checkpoint rolls back before publication", async () => {
  const f = await fixture();
  const writer = await f.context.streams.open({
    id: "checkpoint",
    mediaType: "text/plain",
    role: "output",
  });
  const offsets: number[] = [];
  const remove = await f.operations.onChange((_id, change) => {
    if (change.kind === "stream-offset") offsets.push(change.committedOffset!);
  }, { namespace: "scope" });
  try {
    f.inject("checkpoint");
    await assertRejects(
      () =>
        writer.append({
          appendId: "first",
          bytes: new TextEncoder().encode("prefix"),
        }),
      Error,
      "projection write failed",
    );
    assertEquals(f.injected(), 1);
    const body = await f.catalog.read(
      contentStreamBodyId("scope", writer.id, "bodies"),
    );
    const projection = await f.operations.getStream(
      "scope",
      f.root.id,
      writer.id,
    );
    assertEquals(body?.committedOffset, 0);
    assertEquals(projection?.committedOffset, 0);
    await writer.abort();
    assertEquals((await f.catalog.read(body!.bodyId))?.terminal?.length, 0);
    assertEquals(offsets, []);
  } finally {
    remove();
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("accepted stream seal and its projection roll back together after physical Ready", async () => {
  const f = await fixture();
  const writer = await f.context.streams.open({
    id: "seal",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    await writer.append({
      appendId: "prefix",
      bytes: new TextEncoder().encode("prefix"),
    });
    f.inject("seal");
    await assertRejects(
      () => writer.close({ assetId: "asset" }),
      Error,
      "projection write failed",
    );
    assertEquals(f.injected(), 1);
    const body = await f.catalog.read(
      contentStreamBodyId("scope", writer.id, "bodies"),
    );
    const projection = await f.operations.getStream(
      "scope",
      f.root.id,
      writer.id,
    );
    assertEquals(body?.terminal, undefined);
    assertEquals(body?.sealIntent?.length, 6);
    assertEquals(projection?.state, "terminating");
    assertEquals(
      (await f.physical.head({ bodyId: body!.copy.key }))?.state,
      "ready",
    );
    const next = await f.restart();
    const recoverable = (await next.catalog.read(body!.bodyId))!;
    assertEquals(
      await recoverLogicalBody(next.catalog, recoverable, f.physical),
      "sealed",
    );
    const head = (await f.physical.head({ bodyId: body!.copy.key }))!;
    if (head.state !== "ready") {
      throw new Error("Expected the physical Ready seal.");
    }
    assertEquals(
      await next.operations.sealStream({
        namespace: "scope",
        operationId: f.root.id,
        streamId: writer.id,
        body: { ...head, bodyId: body!.bodyId },
      }),
      true,
    );
    assertEquals(
      (await next.catalog.read(body!.bodyId))?.terminal?.outcome,
      "completed",
    );
    assertEquals(
      (await next.operations.getStream("scope", f.root.id, writer.id))?.outcome,
      "completed",
    );
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("accepted failed stream prefix and its projection roll back together", async () => {
  const f = await fixture();
  const writer = await f.context.streams.open({
    id: "failure",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    await writer.append({
      appendId: "prefix",
      bytes: new TextEncoder().encode("prefix"),
    });
    f.inject("failure");
    await assertRejects(
      () => writer.abort({ reason: "failed" }),
      Error,
      "projection write failed",
    );
    assertEquals(f.injected(), 1);
    const body = await f.catalog.read(
      contentStreamBodyId("scope", writer.id, "bodies"),
    );
    const projection = await f.operations.getStream(
      "scope",
      f.root.id,
      writer.id,
    );
    assertEquals(body?.terminal, undefined);
    assertEquals(body?.committedOffset, 6);
    assertEquals(projection?.state, "terminating");
    assertEquals(
      (await f.physical.head({ bodyId: body!.copy.key }))?.state,
      "open",
    );
    const next = await f.restart();
    assertEquals(
      await recoverLogicalBody(
        {
          ...next.catalog,
          recordFailure: (content) =>
            next.operations.acceptStreamFailure({
              namespace: "scope",
              operationId: f.root.id,
              streamId: writer.id,
              content,
            }),
        },
        (await next.catalog.read(body!.bodyId))!,
        f.physical,
      ),
      "terminated",
    );
    const head = (await f.physical.head({ bodyId: body!.copy.key }))!;
    if (head.state !== "open") {
      throw new Error("Expected the fenced physical copy.");
    }
    assertEquals(
      await next.operations.terminateStream({
        namespace: "scope",
        operationId: f.root.id,
        streamId: writer.id,
        body: { ...head, bodyId: body!.bodyId },
        outcome: "failed",
        reason: "recovered",
      }),
      true,
    );
    assertEquals((await next.catalog.read(body!.bodyId))?.terminal?.length, 6);
    const recovered = await next.operations.getStream(
      "scope",
      f.root.id,
      writer.id,
    );
    assertEquals(recovered?.state, "terminal");
    assertEquals(recovered?.reason, "failed");
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("accepted stream commands bind the exact body before mutating content", async () => {
  const f = await fixture();
  const writer = await f.context.streams.open({
    id: "bound",
    mediaType: "text/plain",
    role: "output",
  });
  const foreign = {
    bodyId: "other-body",
    writerId: "other-writer",
    generation: 1,
  };
  try {
    await f.catalog.reserve({
      ...foreign,
      namespace: "scope",
      copy: {
        key: foreign.bodyId,
        backendKind: f.physical.kind,
        backendId: f.physical.backendId,
      },
    });
    await assertRejects(
      () =>
        f.operations.acceptStreamCheckpoint({
          namespace: "scope",
          operationId: f.root.id,
          streamId: writer.id,
          content: { ...foreign, expectedOffset: 0, offset: 6 },
        }),
      Error,
      "lost durable write ownership",
    );
    assertEquals((await f.catalog.read(foreign.bodyId))?.committedOffset, 0);
    assertEquals(
      (await f.operations.getStream("scope", f.root.id, writer.id))
        ?.committedOffset,
      0,
    );
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("checkpoint acceptance takes one owner command and terminal acceptance publishes only its semantic transition", async () => {
  const f = await fixture();
  const writer = await f.context.streams.open({
    id: "counts",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    const before = f.transactions();
    const eventsBefore = await f.events.listEvents({
      namespace: "scope",
      limit: 100,
    });
    await writer.append({
      appendId: "prefix",
      bytes: new TextEncoder().encode("prefix"),
    });
    assertEquals(f.transactions() - before, 1);
    assertEquals(
      (await f.events.listEvents({ namespace: "scope", limit: 100 })).length,
      eventsBefore.length,
    );
    const beforeClose = f.transactions();
    await writer.close({ assetId: "asset" });
    assertEquals(f.transactions() - beforeClose, 2);
    const body = await f.catalog.read(
      contentStreamBodyId("scope", writer.id, "bodies"),
    );
    const projection = await f.operations.getStream(
      "scope",
      f.root.id,
      writer.id,
    );
    assertEquals(body?.terminal?.length, 6);
    assertEquals(projection?.committedOffset, 6);
    assertEquals(projection?.outcome, "completed");
    const terminalEvents =
      (await f.events.listEvents({ namespace: "scope", limit: 100 })).filter(
        (event) =>
          (event.payload as { state?: { state?: string } }).state?.state ===
            "terminal",
      );
    assertEquals(terminalEvents.length, 1);
    await writer.close({ assetId: "asset" });
    assertEquals(f.transactions() - beforeClose, 2);
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("cancellation wins before terminal intent and cannot rewrite an accepted completed stream", async (t) => {
  for (const completed of [false, true]) {
    await t.step(
      completed ? "accepted completed stream" : "open stream",
      async () => {
        const f = await fixture();
        const writer = await f.context.streams.open({
          id: "cancel",
          mediaType: "text/plain",
          role: "output",
        });
        try {
          await writer.append({
            appendId: "prefix",
            bytes: new TextEncoder().encode("prefix"),
          });
          if (completed) await writer.close({ assetId: "asset" });
          await f.command(
            "test.cancel",
            {},
            (_input, { transaction }) =>
              f.operations.requestCancellation(
                transaction,
                "scope",
                f.root.id,
                "cancelled",
              ),
          );
          if (!completed) {
            await assertRejects(
              () => writer.close({ assetId: "asset" }),
              Error,
              "lost durable write ownership",
            );
            await writer.abort({
              outcome: "failed",
              reason: "late producer failure",
            });
          }
          const body = await f.catalog.read(
            contentStreamBodyId("scope", writer.id, "bodies"),
          );
          const projection = await f.operations.getStream(
            "scope",
            f.root.id,
            writer.id,
          );
          assertEquals(
            body?.terminal?.outcome,
            completed ? "completed" : "cancelled",
          );
          assertEquals(
            projection?.outcome,
            completed ? "completed" : "cancelled",
          );
          assertEquals(body?.terminal?.length, 6);
          assertEquals(projection?.committedOffset, 6);
        } finally {
          await writer.abort().catch(() => {});
          await f.close();
        }
      },
    );
  }
});

Deno.test("physical append seal and fence do not hold the owner command transaction", async (t) => {
  for (const phase of ["append", "seal", "fence"] as const) {
    await t.step(phase, async () => {
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const f = await fixture((store) => ({
        ...store,
        [phase]: async (input: never) => {
          entered.resolve();
          await release.promise;
          return await store[phase](input);
        },
      }));
      const writer = await f.context.streams.open({
        id: phase,
        mediaType: "text/plain",
        role: "output",
      });
      let pending: Promise<unknown> | undefined;
      try {
        if (phase !== "append") {
          await writer.append({
            appendId: "prefix",
            bytes: new TextEncoder().encode("prefix"),
          });
        }
        pending = phase === "append"
          ? writer.append({
            appendId: "prefix",
            bytes: new TextEncoder().encode("prefix"),
          })
          : phase === "seal"
          ? writer.close({ assetId: "asset" })
          : writer.abort();
        await entered.promise;
        const work = f.command(
          "test.unrelated",
          {},
          () => "owner admitted another command",
        );
        assertEquals(await work, "owner admitted another command");
        release.resolve();
        await pending;
      } finally {
        release.resolve();
        await pending?.catch(() => {});
        await writer.abort().catch(() => {});
        await f.close();
      }
    });
  }
});

Deno.test("accepted terminal survives promotion and owner restart with the current physical copy", async () => {
  const ready = createMemoryBodyStore({ backendId: "ready" });
  const f = await fixture((staging) =>
    createPromotedBodyStore({ staging, ready })
  );
  const writer = await f.context.streams.open({
    id: "promoted",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    await writer.append({
      appendId: "prefix",
      bytes: new TextEncoder().encode("prefix"),
    });
    const pending = await writer.close({ assetId: "asset" });
    const logical = await f.catalog.read(
      contentStreamBodyId("scope", writer.id, "bodies"),
    );
    assertEquals(logical?.copy.backendId, "ready");
    const next = await f.restart();
    const accepted = await next.catalog.resolvePending("scope", pending);
    const projection = await next.operations.getStream(
      "scope",
      f.root.id,
      writer.id,
    );
    assertEquals(accepted.body.copy.key, logical?.copy.key);
    assertEquals(projection?.outcome, "completed");
    assertEquals(projection?.committedOffset, accepted.body.terminal?.length);
    const follower = await next.runtime.follow({ id: writer.id });
    const content = await new Response(follower.body).text();
    assertEquals(content, "prefix");
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test({
  name:
    "logical acceptance projection and offset publication become visible only after confirmed outer commit",
  ignore: !Deno.env.get("COPILOTZ_TEST_POSTGRES_URL"),
  async fn() {
    const f = await fixture();
    const writer = await f.context.streams.open({
      id: "atomic",
      mediaType: "text/plain",
      role: "output",
    });
    const offsets: number[] = [];
    const remove = await f.operations.onChange((_id, change) => {
      if (change.kind === "stream-offset") {
        offsets.push(change.committedOffset!);
      }
    }, { namespace: "scope" });
    const hold = f.holdCommit();
    let appending: Promise<unknown> | undefined;
    try {
      appending = writer.append({
        appendId: "prefix",
        bytes: new TextEncoder().encode("prefix"),
      });
      await hold.entered.promise;
      const body = await f.catalog.read(
        contentStreamBodyId("scope", writer.id, "bodies"),
      );
      const projection = await f.operations.getStream(
        "scope",
        f.root.id,
        writer.id,
      );
      assertEquals(body?.committedOffset, 0);
      assertEquals(projection?.committedOffset, 0);
      assertEquals(offsets, []);
      hold.release.resolve();
      await appending;
      await new Promise((resolve) => setTimeout(resolve, 0));
      assertEquals((await f.catalog.read(body!.bodyId))?.committedOffset, 6);
      assertEquals(
        (await f.operations.getStream("scope", f.root.id, writer.id))
          ?.committedOffset,
        6,
      );
      assertEquals(offsets, [6]);
    } finally {
      hold.release.resolve();
      await appending?.catch(() => {});
      remove();
      await writer.abort().catch(() => {});
      await f.close();
    }
  },
});

Deno.test("a lost checkpoint commit reply restarts with the authoritative content offset", async () => {
  const f = await fixture();
  const writer = await f.context.streams.open({
    id: "unknown-commit",
    mediaType: "text/plain",
    role: "output",
  });
  const offsets: number[] = [];
  const remove = await f.operations.onChange((_id, change) => {
    if (change.kind === "stream-offset") offsets.push(change.committedOffset!);
  }, { namespace: "scope" });
  try {
    f.loseCommitReply();
    await assertRejects(
      () =>
        writer.append({
          appendId: "prefix",
          bytes: new TextEncoder().encode("prefix"),
        }),
      Error,
      "commit",
    );
    assertEquals(offsets, []);
    const next = await f.restart();
    const body = await next.catalog.read(
      contentStreamBodyId("scope", writer.id, "bodies"),
    );
    const projection = await next.operations.getStream(
      "scope",
      f.root.id,
      writer.id,
    );
    assertEquals(body?.committedOffset, 6);
    assertEquals(projection?.committedOffset, 6);
    const reader = (await next.runtime.follow({ id: writer.id })).body
      .getReader();
    try {
      assertEquals(
        new TextDecoder().decode((await reader.read()).value),
        "prefix",
      );
    } finally {
      await reader.cancel();
    }
  } finally {
    remove();
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("local stream terminal delivery remains local with real catalog acceptance", async (t) => {
  for (const complete of [true, false]) {
    await t.step(complete ? "completed" : "failed prefix", async () => {
      const f = await fixture(undefined, true);
      const writer = await f.context.streams.open({
        id: "local",
        mediaType: "text/plain",
        role: "output",
      });
      try {
        await writer.append({
          appendId: "prefix",
          bytes: new TextEncoder().encode("prefix"),
        });
        if (complete) {
          await writer.close({ assetId: "asset" });
        } else await writer.abort({ reason: "failed" });
        assertEquals(f.published.length, 1);
        assertEquals(
          (await f.published[0].terminal).outcome,
          complete ? "completed" : "failed",
        );
        assertEquals(
          await new Response(f.published[0].payload).text(),
          "prefix",
        );
        assertEquals(
          await f.operations.getStream("scope", f.root.id, writer.id),
          null,
        );
        assertEquals(
          (await f.events.listEvents({ namespace: "scope", limit: 100 }))
            .length,
          1,
        );
      } finally {
        await writer.abort().catch(() => {});
        await f.close();
      }
    });
  }
});

Deno.test("final checkpoint and seal intent roll back together with the stream projection", async () => {
  const f = await fixture();
  const writer = await f.context.streams.open({
    id: "intent",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    await writer.append({
      appendId: "committed",
      bytes: new TextEncoder().encode("a"),
    });
    await writer.append({
      appendId: "tentative",
      bytes: new TextEncoder().encode("b"),
    });
    f.inject("intent");
    await assertRejects(
      () => writer.close({ assetId: "asset" }),
      Error,
      "projection write failed",
    );
    const body = await f.catalog.read(
      contentStreamBodyId("scope", writer.id, "bodies"),
    );
    assertEquals(body?.committedOffset, 1);
    assertEquals(body?.sealIntent, undefined);
    assertEquals(f.injected(), 1);
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});

Deno.test("replaying seal intent after acceptance preserves the terminal and owner sequence", async () => {
  const f = await fixture();
  const writer = await f.context.streams.open({
    id: "intent-replay",
    mediaType: "text/plain",
    role: "output",
  });
  try {
    await writer.append({
      appendId: "prefix",
      bytes: new TextEncoder().encode("prefix"),
    });
    await writer.close({ assetId: "asset" });
    const body = (await f.catalog.read(
      contentStreamBodyId("scope", writer.id, "bodies"),
    ))!;
    const events = await f.events.listEvents({
      namespace: "scope",
      limit: 100,
    });
    const projection = await f.operations.getStream(
      "scope",
      f.root.id,
      writer.id,
    );
    assertEquals(
      await f.operations.acceptStreamSealIntent({
        namespace: "scope",
        operationId: f.root.id,
        streamId: writer.id,
        content: {
          bodyId: body.bodyId,
          writerId: body.writerId,
          generation: body.generation,
          expectedOffset: 0,
          ...body.sealIntent!,
        },
      }),
      body.sealIntent,
    );
    assertEquals(
      await f.operations.getStream("scope", f.root.id, writer.id),
      projection,
    );
    assertEquals(
      await f.events.listEvents({ namespace: "scope", limit: 100 }),
      events,
    );
  } finally {
    await writer.abort().catch(() => {});
    await f.close();
  }
});
