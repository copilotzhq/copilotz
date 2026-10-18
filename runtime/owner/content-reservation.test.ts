import { digestContent } from "../content/digest.ts";
import type { SqlExecutor } from "../events/session.ts";
import { assertEquals, assertRejects } from "@std/assert";
import { createTestDatabase, type TestDatabase } from "../testing/ominipg.ts";
import { provisionCopilotzSchema } from "../events/schema.ts";
import { provisionOwnerContentCatalog } from "../streams/owner-catalog-schema.ts";
import { createOwnerOperationCatalogCore } from "../streams/catalog.ts";
import { createEventStore } from "../events/store.ts";
import { createMemoryPhysicalBodyStore } from "../content/memory-physical-body-store.ts";
import type { PhysicalBodyStore } from "../content/physical-body-store.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerJson,
} from "./boundary.ts";
import {
  createOwnerStreamReservations,
  OWNER_STREAM_CHECKPOINT,
  OWNER_STREAM_CONFIRM,
  OWNER_STREAM_RESERVE,
  OWNER_STREAM_REVOKED,
  OWNER_STREAM_SEAL_INTENT,
} from "./content-reservation.ts";
import type { OwnerLocalProcessorAssignmentBinding } from "./placement-binding.ts";

const input = {
  id: "answer",
  mediaType: "text/plain",
  kind: "text" as const,
  role: "assistant",
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => resolve = r);
  return { resolve, promise };
}
async function fixture(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  maxUnresolved = 128,
) {
  const f = await setup(maxUnresolved);
  try {
    await run(f);
  } finally {
    f.owner.stop();
    await f.db.close();
  }
}
async function setup(maxUnresolved = 128) {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    return await initialize(db, maxUnresolved);
  } catch (error) {
    try {
      await db.close();
    } catch (cleanup) {
      throw new AggregateError(
        [error, cleanup],
        "Stream fixture initialization and cleanup failed.",
      );
    }
    throw error;
  }
}
async function initialize(db: TestDatabase, maxUnresolved: number) {
  await provisionCopilotzSchema(db, "public");
  await provisionOwnerContentCatalog(db, "public");
  await provisionOwnerCommandSchema(db, "public");
  const core = createOwnerOperationCatalogCore(db, "public");
  const physical = createMemoryPhysicalBodyStore();
  let time = "2026-10-18T00:00:00.000Z", active = true;
  let currentHook: (
    caller: OwnerCaller,
    binding: OwnerLocalProcessorAssignmentBinding,
  ) => boolean = () => active;
  let sourceId = "", deliveryId = "";
  let physicalCalls = 0;
  let reserve: PhysicalBodyStore["reserve"] = (identity) =>
    physical.reserve(identity);
  let append: PhysicalBodyStore["append"] = (input) => physical.append(input);
  let head: PhysicalBodyStore["head"] = (id) => physical.head(id);
  let readRange: PhysicalBodyStore["readRange"] = (input) =>
    physical.readRange(input);
  let fence: PhysicalBodyStore["fence"] = (identity) =>
    physical.fence(identity);
  let controlCurrent = (caller: OwnerCaller): boolean =>
    caller.principal.kind === "owner-control" &&
    caller.principal.holderId === "holder";
  let renewalHook: ((tx: SqlExecutor) => Promise<void>) | undefined;
  let cleanupOrphan:
    | ((
      target: import("./content-reservation.ts").OwnerStreamTarget,
    ) => Promise<void>)
    | undefined;
  const published: unknown[] = [];
  const content = createOwnerStreamReservations({
    ownerId: "owner",
    schema: "public",
    session: db,
    backendId: "memory",
    physical: {
      ...physical,
      fence: (identity) => fence(identity),
      append(input) {
        return append(input);
      },
      head(id) {
        return head(id);
      },
      readRange: (input) => readRange(input),
      reserve(identity) {
        physicalCalls++;
        return reserve(identity);
      },
    },
    protectionMs: 1000,
    now: () => time,
    maxUnresolved,
    cleanupOrphan: (target) => cleanupOrphan?.(target) ?? Promise.resolve(),
    isControlCurrent: (caller) => controlCurrent(caller),
    isRenewalCurrent: (caller) => controlCurrent(caller),
    async resolveReserved(tx) {
      await renewalHook?.(tx);
      const store = createEventStore({
        schema: "public",
        session: { query: tx.query.bind(tx), transaction: (run) => run(tx) },
      });
      const delivery = await store.getDelivery(deliveryId);
      return delivery ? { delivery, isCurrent: () => active } : undefined;
    },
    async resolve(tx) {
      if (!active) return undefined;
      const store = createEventStore({
        session: { query: tx.query.bind(tx), transaction: (fn) => fn(tx) },
        schema: "public",
      });
      const source = await store.getEvent(sourceId),
        delivery = await store.getDelivery(deliveryId);
      return source && delivery ? { binding, source, delivery } : undefined;
    },
    isCurrent: (caller, value) =>
      currentHook(caller, value as OwnerLocalProcessorAssignmentBinding),
    publish: (descriptor) => {
      published.push(descriptor);
    },
  });
  let queryFault: ((sql: string) => boolean) | undefined;
  const owner = createOwnerCommandBoundary({
    session: {
      query: db.query.bind(db),
      transaction: (run) =>
        db.transaction((tx) =>
          run({
            query: (sql, params) =>
              queryFault?.(sql)
                ? Promise.reject(new Error("injected terminal write failure"))
                : tx.query(sql, params),
          })
        ),
    },
    schema: "public",
    ownerId: "owner",
    holderId: "holder",
    now: () => time,
    handlers: {
      seed: async (_input, ctx) => {
        const store = createEventStore({
          session: db,
          schema: "public",
          ownerCommit: { ...ctx.ownerCommit, afterCommit: ctx.afterCommit },
          assertOperationCatalog: core.assertFormat,
          admitOperationEventSql: core.admitEventSql,
          indexOperationEvent: core.indexEvent,
          indexOperationEventSql: core.indexEventSql,
        });
        const seeded = await store.commitMutation({
          transaction: ctx.tx,
          draft: {
            type: "work.created",
            namespace: "tenant",
            payload: {},
            metadata: { observationKeys: ["team"] },
          },
          consumers: [{
            consumerId: "processor:fixture",
            settlement: "inherit",
          }],
        });
        sourceId = seeded.event.id;
        deliveryId = seeded.deliveries[0].id;
        await ctx.tx.query(
          "UPDATE public.event_deliveries SET status='leased',attempts=1,lease_owner='attempt',lease_expires_at=NULL WHERE id=$1",
          [deliveryId],
        );
        return null;
      },
    },
    checkpoints: content.checkpoints,
    authorize: (tx, caller, command, now) =>
      command.kind === "seed"
        ? undefined
        : content.authorize(tx, caller, command, now),
    isCurrentAuthorization: (tx, caller, command) =>
      command.kind === "seed"
        ? true
        : content.isCurrentAuthorization(tx, caller),
    currentAuthorizationKinds: Object.keys(content.checkpoints),
    authenticateReceipt() {},
  });
  await owner.acquire(0);
  await owner.execute({
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
    },
    ownerEpoch: 1,
  }, { kind: "seed", domain: "occurrence", key: "seed", intent: null });
  const binding: OwnerLocalProcessorAssignmentBinding = {
    placement: "owner-local",
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    attemptId: "attempt",
    namespace: "tenant",
    sourceEventId: sourceId,
    deliveryId,
    kind: "processor",
    processorId: "fixture",
    consumerId: "processor:fixture",
  };
  const caller: OwnerCaller = {
    principal: {
      kind: "owner-local",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
      deliveryId,
      attemptId: "attempt",
    },
    ownerEpoch: 1,
  };
  const counts = async () => {
    const result: Record<string, number> = {};
    for (
      const table of [
        "events",
        "owner_receipts",
        "owner_receipt_readers",
        "copilotz_operation_streams",
      ]
    ) {
      result[table] = (await db.query<{ n: number }>(
        `SELECT count(*)::integer AS n FROM public.${table}`,
      )).rows[0].n;
    }
    return result;
  };
  return {
    db,
    owner,
    caller,
    content,
    physical,
    published,
    counts,
    getPhysicalCalls: () => physicalCalls,
    setQueryFault: (hook: typeof queryFault) => {
      queryFault = hook;
    },
    setAppend: (value: PhysicalBodyStore["append"]) => {
      append = value;
    },
    setFence: (value: PhysicalBodyStore["fence"]) => {
      fence = value;
    },
    setReadRange: (value: PhysicalBodyStore["readRange"]) => {
      readRange = value;
    },
    setHead: (value: PhysicalBodyStore["head"]) => {
      head = value;
    },
    setCleanupOrphan: (hook: typeof cleanupOrphan) => {
      cleanupOrphan = hook;
    },
    setRenewalHook: (hook: typeof renewalHook) => {
      renewalHook = hook;
    },
    setControlCurrent: (hook: typeof controlCurrent) => {
      controlCurrent = hook;
    },
    setCurrent: (hook: typeof currentHook) => {
      currentHook = hook;
    },
    setActive: (value: boolean) => {
      active = value;
    },
    setTime: (value: string) => {
      time = value;
    },
    setReserve: (value: PhysicalBodyStore["reserve"]) => {
      reserve = value;
    },
  };
}

Deno.test("owner stream reserves before physical storage and publishes exactly once without additional receipts", () =>
  fixture(async (f) => {
    const before = await f.counts();
    f.setReserve(async (identity) => {
      assertEquals(
        (await f.db.query(
          "SELECT state,stream_ordinal,committed_offset::text FROM public.copilotz_operation_streams",
        )).rows,
        [{ state: "reserving", stream_ordinal: null, committed_offset: "0" }],
      );
      assertEquals(await f.counts(), {
        ...before,
        copilotz_operation_streams: 1,
      });
      return f.physical.reserve(identity);
    });
    const first = await f.content.open(f.owner, f.caller, input);
    const duplicate = await f.content.open(f.owner, f.caller, input);
    assertEquals(first, duplicate);
    assertEquals(first.streamOrdinal, "1");
    assertEquals(f.getPhysicalCalls(), 1);
    assertEquals(await f.counts(), {
      ...before,
      events: before.events + 1,
      copilotz_operation_streams: 1,
    });
    assertEquals(f.published.length, 1);
    await assertRejects(() =>
      f.content.open(f.owner, f.caller, { ...input, role: "different" })
    );
    assertEquals(await f.counts(), {
      ...before,
      events: before.events + 1,
      copilotz_operation_streams: 1,
    });
  }));

Deno.test("owner stream rejects generic dispatch and derives source metadata instead of trusting injected fields", () =>
  fixture(async (f) => {
    for (const kind of Object.keys(f.content.checkpoints)) {
      await assertRejects(
        () =>
          f.owner.execute(f.caller, {
            kind,
            domain: "occurrence",
            key: "fake",
            intent: input,
          }),
        Error,
        "Command kind is not registered",
      );
      await assertRejects(
        () => f.owner.project(f.caller, kind, input),
        Error,
        "Command kind is not registered",
      );
    }
    for (const metadata of [null, 42, "text", [], true]) {
      await assertRejects(
        () =>
          f.content.open(f.owner, f.caller, {
            ...input,
            metadata: metadata as unknown as Record<string, unknown>,
          }),
        TypeError,
        "plain object",
      );
    }
    assertEquals(f.getPhysicalCalls(), 0);
    assertEquals((await f.counts()).copilotz_operation_streams, 0);
    const output = await f.content.open(f.owner, f.caller, {
      ...input,
      metadata: {
        sourceActionRunId: "spoof",
        sourceDeliveryId: "spoof",
        sourceActionScopeId: "spoof",
        sourceConsumerId: "spoof",
        label: "kept",
      },
    });
    assertEquals(output.metadata.sourceActionRunId, undefined);
    assertEquals(output.metadata.sourceActionScopeId, undefined);
    assertEquals(output.metadata.sourceConsumerId, "processor:fixture");
    assertEquals(output.metadata.sourceDeliveryId === "spoof", false);
    assertEquals(output.metadata.label, "kept");
  }));

Deno.test("owner stream authority loss or expiry during physical reservation never publishes", () =>
  fixture(async (f) => {
    f.setReserve(async (identity) => {
      const head = await f.physical.reserve(identity);
      f.setActive(false);
      return head;
    });
    await assertRejects(() => f.content.open(f.owner, f.caller, input));
    assertEquals(
      (await f.db.query(
        "SELECT state,stream_ordinal FROM public.copilotz_operation_streams",
      )).rows,
      [{ state: "reserving", stream_ordinal: null }],
    );
    assertEquals(f.published.length, 0);
    f.setActive(true);
    f.setTime("2026-10-18T00:00:02.000Z");
    await assertRejects(() => f.content.open(f.owner, f.caller, input));
    assertEquals(f.getPhysicalCalls(), 1);
  }));

Deno.test("owner stream ordinals follow physical confirmation order", () =>
  fixture(async (f) => {
    const entered = deferred(), release = deferred();
    let first = true;
    f.setReserve(async (identity) => {
      if (first) {
        first = false;
        entered.resolve();
        await release.promise;
      }
      return f.physical.reserve(identity);
    });
    const slow = f.content.open(f.owner, f.caller, { ...input, id: "slow" });
    await entered.promise;
    const fast = await f.content.open(f.owner, f.caller, {
      ...input,
      id: "fast",
    });
    release.resolve();
    const later = await slow;
    assertEquals(fast.streamOrdinal, "1");
    assertEquals(later.streamOrdinal, "2");
    assertEquals(
      (await f.db.query(
        "SELECT count(*)::integer AS n FROM public.events WHERE type='copilotz.stream.opened'",
      )).rows,
      [{ n: 2 }],
    );
  }));

Deno.test("owner stream confirmation refuses mismatched physical evidence and remains hidden", () =>
  fixture(async (f) => {
    const reserve = await f.owner.checkpoint(
      f.caller,
      OWNER_STREAM_RESERVE,
      input,
    );
    const writer = (reserve as { writer: Record<string, OwnerJson> }).writer;
    await assertRejects(() =>
      f.owner.checkpoint(f.caller, OWNER_STREAM_CONFIRM, {
        open: input,
        head: {
          ...writer,
          format: "owner-physical-v1",
          state: "open",
          byteLength: 1,
          versionToken: "fake",
        },
      })
    );
    assertEquals(
      (await f.db.query(
        "SELECT state,stream_ordinal FROM public.copilotz_operation_streams",
      )).rows,
      [{ state: "reserving", stream_ordinal: null }],
    );
  }));

Deno.test("owner stream retries exact identities after lost reserve and confirmation replies", () =>
  fixture(async (f) => {
    const before = await f.counts();
    let lost = true;
    f.setReserve(async (identity) => {
      const head = await f.physical.reserve(identity);
      if (lost) {
        lost = false;
        throw new Error("lost physical acknowledgement");
      }
      return head;
    });
    await assertRejects(
      () => f.content.open(f.owner, f.caller, input),
      Error,
      "lost physical acknowledgement",
    );
    const staged = (await f.db.query(
      "SELECT body_id,reservation_id,protection_deadline::text AS deadline FROM public.copilotz_operation_streams",
    )).rows;
    const first = await f.content.open(f.owner, f.caller, input);
    assertEquals(
      (await f.db.query(
        "SELECT body_id,reservation_id,protection_deadline::text AS deadline FROM public.copilotz_operation_streams",
      )).rows,
      staged,
    );
    assertEquals(first.streamOrdinal, "1");
    let lostConfirmation = true;
    const transport = {
      ...f.owner,
      checkpoint: async (...args: Parameters<typeof f.owner.checkpoint>) => {
        const result = await f.owner.checkpoint(...args);
        if (args[1] === OWNER_STREAM_CONFIRM && lostConfirmation) {
          lostConfirmation = false;
          throw new Error("lost confirmed reply");
        }
        return result;
      },
    };
    const secondInput = { ...input, id: "second" };
    await assertRejects(
      () => f.content.open(transport, f.caller, secondInput),
      Error,
      "lost confirmed reply",
    );
    const second = await f.content.open(transport, f.caller, secondInput);
    assertEquals(second.streamOrdinal, "2");
    assertEquals(await f.counts(), {
      ...before,
      events: before.events + 2,
      copilotz_operation_streams: 2,
    });
    assertEquals(f.published.length, 2);
  }));

Deno.test("owner stream concurrent exact opens share one descriptor and one publication", () =>
  fixture(async (f) => {
    const result = await Promise.all([
      f.content.open(f.owner, f.caller, input),
      f.content.open(f.owner, f.caller, input),
    ]);
    assertEquals(result[0], result[1]);
    assertEquals(
      (await f.db.query(
        "SELECT next_stream_ordinal::text AS ordinal FROM public.copilotz_operations",
      )).rows,
      [{ ordinal: "2" }],
    );
    assertEquals(
      (await f.db.query(
        "SELECT count(*)::integer AS n FROM public.events WHERE type='copilotz.stream.opened'",
      )).rows,
      [{ n: 1 }],
    );
  }));

Deno.test("owner stream derives bounded canonical descriptors consistently for catalog and lifecycle", () =>
  fixture(async (f) => {
    const result = await f.content.open(f.owner, f.caller, {
      ...input,
      metadata: {
        nested: {
          assetId: "asset",
          kind: "text",
          role: "input",
          mediaType: "text/plain",
          text: "hydrated-private",
          data: { secret: "not-durable" },
        },
      },
    });
    const rows = (await f.db.query<
      { descriptor: Record<string, unknown>; replay: string; ordinal: string }
    >("SELECT descriptor,replay_key::text AS replay,stream_ordinal::text AS ordinal FROM public.copilotz_operation_streams"))
      .rows;
    assertEquals<unknown>(result, {
      ...rows[0].descriptor,
      replayKey: rows[0].replay,
      streamOrdinal: rows[0].ordinal,
    });
    assertEquals(
      (await f.db.query(
        "SELECT payload FROM public.events WHERE type='copilotz.stream.opened'",
      )).rows,
      [{ payload: result }],
    );
    assertEquals(result.metadata.nested, {
      assetId: "asset",
      kind: "text",
      role: "input",
      mediaType: "text/plain",
    });
    await assertRejects(
      () =>
        f.content.open(f.owner, f.caller, {
          ...input,
          id: "wrong-correlation",
          correlationId: "foreign",
        }),
      TypeError,
      "owner-derived",
    );
  }));

Deno.test("owner stream current-lifetime hooks receive detached coordinates and must be synchronous", () =>
  fixture(async (f) => {
    f.setCurrent((caller, binding) => {
      Object.assign(binding, { namespace: "forged" });
      Object.assign(caller, { ownerEpoch: 999 });
      return true;
    });
    const result = await f.content.open(f.owner, f.caller, input);
    assertEquals(result.namespace, "tenant");
    assertEquals(f.caller.ownerEpoch, 1);
    f.setCurrent(() =>
      Promise.reject(new Error("async hook refused")) as unknown as boolean
    );
    await assertRejects(() =>
      f.content.open(f.owner, f.caller, { ...input, id: "async" })
    );
    assertEquals((await f.counts()).copilotz_operation_streams, 1);
  }));

Deno.test("owner stream suppresses a caller reply cancelled immediately after confirmed commit", () =>
  fixture(async (f) => {
    const abort = new AbortController();
    const transport = {
      ...f.owner,
      checkpoint: async (...args: Parameters<typeof f.owner.checkpoint>) => {
        const result = await f.owner.checkpoint(...args);
        if (args[1] === OWNER_STREAM_CONFIRM) {
          abort.abort(new Error("late caller cancel"));
        }
        return result;
      },
    };
    await assertRejects(
      () => f.content.open(transport, f.caller, input, abort.signal),
      Error,
      "late caller cancel",
    );
    assertEquals(
      (await f.db.query(
        "SELECT state,stream_ordinal::text FROM public.copilotz_operation_streams",
      )).rows,
      [{ state: "open", stream_ordinal: "1" }],
    );
    assertEquals(f.published.length, 1);
  }));

Deno.test("owner stream confirmation replay does not adopt bytes appended after publication", () =>
  fixture(async (f) => {
    const reserved = await f.owner.checkpoint(
      f.caller,
      OWNER_STREAM_RESERVE,
      input,
    );
    const writer = (reserved as unknown as {
      writer: Parameters<PhysicalBodyStore["reserve"]>[0];
    }).writer;
    const head = await f.physical.reserve(writer);
    const first = await f.owner.checkpoint(
      f.caller,
      OWNER_STREAM_CONFIRM,
      { open: input, head } as unknown as OwnerJson,
    );
    await f.physical.append({
      writer,
      expectedOffset: 0,
      appendId: "append",
      bytes: new Uint8Array([1, 2, 3]),
    });
    const laterHead = await f.physical.reserve(writer);
    const replay = await f.owner.checkpoint(
      f.caller,
      OWNER_STREAM_CONFIRM,
      { open: input, head: laterHead } as unknown as OwnerJson,
    );
    assertEquals(first, replay);
    assertEquals(
      (await f.db.query(
        "SELECT committed_offset::text AS offset FROM public.copilotz_operation_streams",
      )).rows,
      [{ offset: "0" }],
    );
    const fenced = await f.physical.fence(writer);
    await assertRejects(() =>
      f.owner.checkpoint(
        f.caller,
        OWNER_STREAM_CONFIRM,
        { open: input, head: fenced } as unknown as OwnerJson,
      )
    );
  }));

Deno.test("owner physical appends remain tentative until a receipt-free checkpoint accepts their prefix", () =>
  fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, input);
    const before = await f.counts();
    const sequence = () =>
      f.db.query("SELECT last_seq::text AS seq FROM public.owner_epochs");
    const revisions = () =>
      f.db.query(
        "SELECT namespace,selection_key,change_ordinal::text AS revision FROM public.copilotz_operation_selection_heads ORDER BY namespace,selection_key",
      );
    const beforeSequence = (await sequence()).rows,
      beforeRevisions = (await revisions()).rows;
    const deadline = (await f.db.query(
      "SELECT protection_deadline::text AS deadline FROM public.copilotz_operation_streams",
    )).rows;
    assertEquals(
      await f.content.append(f.owner, f.caller, opened.streamId, {
        expectedOffset: 0,
        appendId: "a",
        bytes: new Uint8Array([1, 2, 3]),
      }),
      { startOffset: 0, endOffset: 3 },
    );
    assertEquals(
      await f.content.append(f.owner, f.caller, opened.streamId, {
        expectedOffset: 3,
        appendId: "b",
        bytes: new Uint8Array([4, 5, 6]),
      }),
      { startOffset: 3, endOffset: 6 },
    );
    assertEquals(
      (await f.db.query(
        "SELECT committed_offset::text AS offset FROM public.copilotz_operation_streams",
      )).rows,
      [{ offset: "0" }],
    );
    assertEquals(await f.counts(), before);
    assertEquals(
      await f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 6),
      { committedOffset: 6 },
    );
    assertEquals(
      await f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 3),
      { committedOffset: 3 },
    );
    assertEquals(
      await f.content.append(f.owner, f.caller, opened.streamId, {
        expectedOffset: 0,
        appendId: "a",
        bytes: new Uint8Array([1, 2, 3]),
      }),
      { startOffset: 0, endOffset: 3 },
    );
    assertEquals(
      (await f.db.query(
        "SELECT committed_offset::text AS offset FROM public.copilotz_operation_streams",
      )).rows,
      [{ offset: "6" }],
    );
    assertEquals(
      (await f.db.query(
        "SELECT protection_deadline::text AS deadline FROM public.copilotz_operation_streams",
      )).rows,
      deadline,
    );
    assertEquals(await f.counts(), before);
    assertEquals((await sequence()).rows, beforeSequence);
    assertEquals((await revisions()).rows, beforeRevisions);
    await assertRejects(() =>
      f.content.append(f.owner, f.caller, opened.streamId, {
        expectedOffset: 0,
        appendId: "a",
        bytes: new Uint8Array([9, 9, 9]),
      })
    );
  }));

Deno.test("owner checkpoints refuse gaps, overlap and a proposed end not equal to the observed physical head", () =>
  fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, input);
    await f.content.append(f.owner, f.caller, opened.streamId, {
      expectedOffset: 0,
      appendId: "a",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await assertRejects(() =>
      f.content.checkpoint(f.owner, f.caller, opened.streamId, 1, 3)
    );
    await assertRejects(() =>
      f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 2)
    );
    await assertRejects(() =>
      f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 4)
    );
    assertEquals(
      await f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 3),
      { committedOffset: 3 },
    );
    await f.content.append(f.owner, f.caller, opened.streamId, {
      expectedOffset: 3,
      appendId: "b",
      bytes: new Uint8Array([4, 5, 6]),
    });
    await assertRejects(() =>
      f.content.checkpoint(f.owner, f.caller, opened.streamId, 1, 6)
    );
    assertEquals(
      (await f.db.query(
        "SELECT committed_offset::text AS offset FROM public.copilotz_operation_streams",
      )).rows,
      [{ offset: "3" }],
    );
    assertEquals(
      await f.content.checkpoint(f.owner, f.caller, opened.streamId, 3, 6),
      { committedOffset: 6 },
    );
  }));

Deno.test("owner append captures bytes before admission and never adopts a late revoked physical append", () =>
  fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, input);
    const bytes = new Uint8Array([1, 2, 3]);
    f.setCurrent(() => {
      bytes.fill(9);
      return true;
    });
    await f.content.append(f.owner, f.caller, opened.streamId, {
      expectedOffset: 0,
      appendId: "a",
      bytes,
    });
    const body = (await f.db.query<{ body_id: string }>(
      "SELECT body_id FROM public.copilotz_operation_streams",
    )).rows[0].body_id;
    assertEquals(
      await f.physical.readRange({ bodyId: body, offset: 0, end: 3 }),
      new Uint8Array([1, 2, 3]),
    );
    f.setAppend(async (request) => {
      const result = await f.physical.append(request);
      await f.db.query(
        "UPDATE public.copilotz_operation_streams SET revocation_state='revoking'",
      );
      return result;
    });
    await assertRejects(() =>
      f.content.append(f.owner, f.caller, opened.streamId, {
        expectedOffset: 3,
        appendId: "b",
        bytes: new Uint8Array([4, 5, 6]),
      })
    );
    assertEquals((await f.physical.head(body))?.byteLength, 6);
    assertEquals(
      (await f.db.query(
        "SELECT committed_offset::text AS offset FROM public.copilotz_operation_streams",
      )).rows,
      [{ offset: "0" }],
    );
    await assertRejects(() =>
      f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 6)
    );
  }));

Deno.test("owner checkpoint reauthorizes after head I/O and leaves revoked tentative bytes unaccepted", () =>
  fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, input);
    await f.content.append(f.owner, f.caller, opened.streamId, {
      expectedOffset: 0,
      appendId: "a",
      bytes: new Uint8Array([1, 2, 3]),
    });
    f.setHead(async (id) => {
      const head = await f.physical.head(id);
      await f.db.query(
        "UPDATE public.copilotz_operation_streams SET revocation_state='revoking'",
      );
      return head;
    });
    await assertRejects(() =>
      f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 3)
    );
    assertEquals(
      (await f.db.query(
        "SELECT committed_offset::text AS offset FROM public.copilotz_operation_streams",
      )).rows,
      [{ offset: "0" }],
    );
  }));

Deno.test("owner append and checkpoint retain exact durable replay after lost acknowledgements", () =>
  fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, input);
    const before = await f.counts();
    const deadline = (await f.db.query(
      "SELECT protection_deadline::text AS deadline FROM public.copilotz_operation_streams",
    )).rows;
    let lostAppend = true;
    f.setAppend(async (request) => {
      const result = await f.physical.append(request);
      if (lostAppend) {
        lostAppend = false;
        throw new Error("lost append reply");
      }
      return result;
    });
    const request = {
      expectedOffset: 0,
      appendId: "a",
      bytes: new Uint8Array([1, 2, 3]),
    };
    await assertRejects(
      () => f.content.append(f.owner, f.caller, opened.streamId, request),
      Error,
      "lost append reply",
    );
    assertEquals(
      await f.content.append(f.owner, f.caller, opened.streamId, request),
      { startOffset: 0, endOffset: 3 },
    );
    let lostCheckpoint = true;
    const transport = {
      ...f.owner,
      checkpoint: async (...args: Parameters<typeof f.owner.checkpoint>) => {
        const result = await f.owner.checkpoint(...args);
        if (args[1] === OWNER_STREAM_CHECKPOINT && lostCheckpoint) {
          lostCheckpoint = false;
          throw new Error("lost checkpoint reply");
        }
        return result;
      },
    };
    await assertRejects(
      () => f.content.checkpoint(transport, f.caller, opened.streamId, 0, 3),
      Error,
      "lost checkpoint reply",
    );
    // Internal receipt proof only. A real invocation must latch the reported
    // checkpoint failure and cannot use this lower-level replay to resume itself.
    assertEquals(
      await f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 3),
      { committedOffset: 3 },
    );
    assertEquals(await f.counts(), before);
    assertEquals(
      (await f.db.query(
        "SELECT protection_deadline::text AS deadline FROM public.copilotz_operation_streams",
      )).rows,
      deadline,
    );
  }));

Deno.test("owner append acknowledgement refuses protection expiry during physical I/O", () =>
  fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, input);
    f.setAppend(async (request) => {
      const result = await f.physical.append(request);
      f.setTime("2026-10-18T00:00:02.000Z");
      return result;
    });
    await assertRejects(() =>
      f.content.append(f.owner, f.caller, opened.streamId, {
        expectedOffset: 0,
        appendId: "a",
        bytes: new Uint8Array([1, 2, 3]),
      })
    );
    assertEquals(
      (await f.db.query(
        "SELECT committed_offset::text AS offset FROM public.copilotz_operation_streams",
      )).rows,
      [{ offset: "0" }],
    );
  }));

Deno.test("owner checkpoint refuses protection expiry during physical head observation", () =>
  fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, input);
    await f.content.append(f.owner, f.caller, opened.streamId, {
      expectedOffset: 0,
      appendId: "a",
      bytes: new Uint8Array([1, 2, 3]),
    });
    f.setHead(async (id) => {
      const result = await f.physical.head(id);
      f.setTime("2026-10-18T00:00:02.000Z");
      return result;
    });
    await assertRejects(() =>
      f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 3)
    );
    assertEquals(
      (await f.db.query(
        "SELECT committed_offset::text AS offset FROM public.copilotz_operation_streams",
      )).rows,
      [{ offset: "0" }],
    );
  }));

const cleanupCaller: OwnerCaller = {
  principal: {
    kind: "owner-control",
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
  },
  ownerEpoch: 1,
};
async function streamRow(
  f: Awaited<ReturnType<typeof setup>>,
  streamId?: string,
) {
  const row = (await f.db.query<Record<string, unknown>>(
    "SELECT * FROM copilotz_operation_streams WHERE ($1::text IS NULL OR stream_id=$1) ORDER BY created_at LIMIT 1",
    [streamId ?? null],
  )).rows[0];
  if (!row) throw new Error("missing fixture stream");
  return {
    row,
    target: {
      namespace: String(row.namespace),
      operationId: String(row.operation_id),
      streamId: String(row.stream_id),
    },
  };
}
Deno.test("owner revocation preserves C after caller loss and does not publish a terminal Core Event", async () => {
  await fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, input);
    await f.content.append(f.owner, f.caller, opened.streamId, {
      expectedOffset: 0,
      appendId: "a",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 3);
    await f.content.append(f.owner, f.caller, opened.streamId, {
      expectedOffset: 3,
      appendId: "b",
      bytes: new Uint8Array([4, 5]),
    });
    const { target } = await streamRow(f);
    const before = await f.counts();
    f.setActive(false);
    await f.content.revoke(f.owner, cleanupCaller, target, {
      outcome: "failed",
    });
    const { row } = await streamRow(f);
    assertEquals(row.state, "terminal");
    assertEquals(row.revocation_state, "revoked");
    assertEquals(Number(row.committed_offset), 3);
    assertEquals(row.outcome, "failed");
    assertEquals(row.capture, "truncated");
    assertEquals(row.availability, "retained");
    assertEquals((await f.physical.head(String(row.body_id)))?.byteLength, 5);
    assertEquals((await f.counts()).events, before.events);
    assertEquals((await f.counts()).owner_receipts, before.owner_receipts);
    await f.content.revoke(f.owner, cleanupCaller, target, {
      outcome: "cancelled",
    });
    assertEquals((await streamRow(f)).row.outcome, "failed");
  });
});
Deno.test("owner revocation remains unresolved while a fence is held or unknown", async () => {
  await fixture(async (f) => {
    await f.content.open(f.owner, f.caller, input);
    const { target } = await streamRow(f);
    const entered = deferred(), released = deferred();
    f.setFence(async () => {
      entered.resolve();
      await released.promise;
      throw new Error("physical outcome unknown");
    });
    const pending = f.content.revoke(f.owner, cleanupCaller, target);
    void pending.catch(() => undefined);
    await entered.promise;
    assertEquals((await streamRow(f)).row.revocation_state, "revoking");
    released.resolve();
    const error = await assertRejects(
      () => pending,
      Error,
      "fence outcome is unknown",
    );
    assertEquals(
      (error as Error & { indeterminate?: boolean }).indeterminate,
      true,
    );
    assertEquals((await streamRow(f)).row.revocation_state, "revoking");
    f.setFence((writer) => f.physical.fence(writer));
    await f.content.revoke(f.owner, cleanupCaller, target);
    assertEquals((await streamRow(f)).row.revocation_state, "revoked");
  });
});
Deno.test("owner cleanup fences hidden reservations without publishing them", async () => {
  await fixture(async (f) => {
    f.setReserve(() => Promise.reject(new Error("reserve unavailable")));
    await assertRejects(() => f.content.open(f.owner, f.caller, input));
    const { target } = await streamRow(f);
    const before = await f.counts();
    f.setActive(false);
    await f.content.revoke(f.owner, cleanupCaller, target);
    const { row } = await streamRow(f);
    assertEquals(row.state, "reserving");
    assertEquals(row.revocation_state, "revoked");
    assertEquals(row.stream_ordinal, null);
    assertEquals(Number(row.committed_offset), 0);
    assertEquals((await f.counts()).events, before.events);
  });
});
Deno.test("owner short physical fence marks missing without shrinking accepted prefix", async () => {
  await fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, input);
    await f.content.append(f.owner, f.caller, opened.streamId, {
      expectedOffset: 0,
      appendId: "a",
      bytes: new Uint8Array([1, 2, 3]),
    });
    await f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 3);
    const missing = createMemoryPhysicalBodyStore();
    f.setFence((writer) => missing.fence(writer));
    const { target } = await streamRow(f);
    await f.content.revoke(f.owner, cleanupCaller, target, {
      outcome: "cancelled",
    });
    const { row } = await streamRow(f);
    assertEquals(Number(row.committed_offset), 3);
    assertEquals(row.outcome, "cancelled");
    assertEquals(row.availability, "missing");
  });
});
Deno.test("owner unresolved writer bound includes revoking rows and permits exact replay", async () => {
  await fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, input);
    assertEquals(
      (await f.content.open(f.owner, f.caller, input)).streamId,
      opened.streamId,
    );
    await assertRejects(
      () => f.content.open(f.owner, f.caller, { ...input, id: "second" }),
      Error,
      "capacity",
    );
    const { target } = await streamRow(f);
    f.setFence(() => Promise.reject(new Error("unknown fence")));
    await assertRejects(() => f.content.revoke(f.owner, cleanupCaller, target));
    await assertRejects(
      () => f.content.open(f.owner, f.caller, { ...input, id: "second" }),
      Error,
      "capacity",
    );
    f.setFence((writer) => f.physical.fence(writer));
    await f.content.revoke(f.owner, cleanupCaller, target);
    await f.content.open(f.owner, f.caller, { ...input, id: "second" });
  }, 1);
});
Deno.test("owner cleanup refuses producer callers and mismatched physical fences", async () => {
  await fixture(async (f) => {
    await f.content.open(f.owner, f.caller, input);
    const { target } = await streamRow(f);
    await assertRejects(
      () => f.content.revoke(f.owner, f.caller, target),
      Error,
      "cleanup authority",
    );
    assertEquals((await streamRow(f)).row.revocation_state, "active");
    f.setFence(async (writer) => ({
      ...await f.physical.fence(writer),
      generation: writer.generation,
    }));
    await assertRejects(
      () => f.content.revoke(f.owner, cleanupCaller, target),
      Error,
      "does not match",
    );
    assertEquals((await streamRow(f)).row.revocation_state, "revoking");
  });
});

Deno.test("owner current-epoch cleanup refuses retained epochs and asynchronous control proof", async () => {
  await fixture(async (f) => {
    await f.content.open(f.owner, f.caller, input);
    const { target } = await streamRow(f);
    await f.db.query(
      "UPDATE copilotz_operation_streams SET opening_owner_epoch=2",
    );
    await assertRejects(
      () => f.content.revoke(f.owner, cleanupCaller, target),
      Error,
      "target is unavailable",
    );
    assertEquals((await streamRow(f)).row.revocation_state, "active");
    await f.db.query(
      "UPDATE copilotz_operation_streams SET opening_owner_epoch=1",
    );
    f.setControlCurrent(
      (() => Promise.reject(new Error("late proof rejection"))) as never,
    );
    await assertRejects(
      () => f.content.revoke(f.owner, cleanupCaller, target),
      Error,
      "cleanup authority",
    );
    await new Promise((done) => setTimeout(done, 0));
    assertEquals((await streamRow(f)).row.revocation_state, "active");
  });
});

Deno.test("owner quiet renewal advances only protection and keeps a durable ordered alarm", async () => {
  await fixture(async (f) => {
    await f.content.open(f.owner, f.caller, input);
    const { target, row } = await streamRow(f), before = await f.counts();
    f.setTime("2026-10-18T00:00:00.600Z");
    assertEquals((await f.content.scan(f.owner, cleanupCaller)).active, [
      target,
    ]);
    await f.content.renew(f.owner, cleanupCaller, target);
    f.setTime("2026-10-18T00:00:01.200Z");
    await f.content.renew(f.owner, cleanupCaller, target);
    const current = (await streamRow(f)).row;
    assertEquals(Number(current.committed_offset), 0);
    assertEquals(current.placement_binding, row.placement_binding);
    assertEquals(current.delivery_attempt, row.delivery_attempt);
    assertEquals(current.revocation_state, "active");
    assertEquals(
      (await f.db.query(
        "SELECT protection_deadline='2026-10-18T00:00:02.200Z'::timestamptz AS exact FROM copilotz_operation_streams",
      )).rows[0].exact,
      true,
    );
    assertEquals(
      (await f.db.query(
        "SELECT due_at='2026-10-18T00:00:01.700Z'::timestamptz AS exact FROM owner_alarms WHERE name LIKE '%content.stream.scan%'",
      )).rows[0].exact,
      true,
    );
    assertEquals(await f.counts(), before);
  });
});
for (
  const mode of [
    "expired",
    "revoking",
    "ordinal",
    "private",
    "control",
    "cancelled",
    "clock",
    "body",
    "reservation",
    "generation",
    "media",
  ] as const
) {
  Deno.test(`owner renewal cannot resurrect ${mode} authority`, async () => {
    await fixture(async (f) => {
      await f.content.open(f.owner, f.caller, input);
      const { target } = await streamRow(f);
      f.setTime("2026-10-18T00:00:00.600Z");
      if (mode === "expired") f.setTime("2026-10-18T00:00:01.001Z");
      if (mode === "revoking") {
        await f.content.beginRevocation(f.owner, cleanupCaller, target);
      }
      if (mode === "ordinal") {
        await f.db.query(
          "UPDATE event_deliveries SET attempts=2 WHERE status='leased'",
        );
      }
      if (mode === "private") {
        f.setRenewalHook(() => {
          f.setActive(false);
          return Promise.resolve();
        });
      }
      if (mode === "control") {
        f.setRenewalHook(() => {
          f.setControlCurrent(() => false);
          return Promise.resolve();
        });
      }
      if (mode === "cancelled") {
        f.setRenewalHook(async (tx) => {
          await tx.query(
            "UPDATE copilotz_operations SET cancellation_requested_at='2026-10-18T00:00:00.600Z'",
          );
        });
      }
      if (mode === "clock") {
        f.setRenewalHook(() => {
          f.setTime("2026-10-18T00:00:01.100Z");
          return Promise.resolve();
        });
      }
      if (mode === "body") {
        f.setRenewalHook(async (tx) => {
          await tx.query(
            "UPDATE copilotz_operation_streams SET body_id='replacement'",
          );
        });
      }
      if (mode === "reservation") {
        f.setRenewalHook(async (tx) => {
          await tx.query(
            "UPDATE copilotz_operation_streams SET reservation_id='replacement'",
          );
        });
      }
      if (mode === "generation") {
        f.setRenewalHook(async (tx) => {
          await tx.query(
            "UPDATE copilotz_operation_streams SET writer_generation=2",
          );
        });
      }
      if (mode === "media") {
        f.setRenewalHook(async (tx) => {
          await tx.query(
            `UPDATE copilotz_operation_streams SET descriptor=jsonb_set(descriptor,'{mediaType}', '"text/other"'::jsonb)`,
          );
        });
      }
      const before = (await streamRow(f)).row;
      await assertRejects(() =>
        f.content.renew(f.owner, cleanupCaller, target)
      );
      assertEquals((await streamRow(f)).row, before);
    });
  });
}

Deno.test("owner orphan opening waits for physical cleanup before rejecting", async () => {
  await fixture(async (f) => {
    const entered = deferred(), release = deferred();
    f.setCleanupOrphan((target) =>
      f.content.revoke(f.owner, cleanupCaller, target, { outcome: "failed" })
    );
    f.setReserve(async (writer) => {
      await f.physical.reserve(writer);
      throw new Error("reserve acknowledgement failed");
    });
    f.setFence(async (writer) => {
      entered.resolve();
      await release.promise;
      return f.physical.fence(writer);
    });
    let finished = false;
    const opening = f.content.open(f.owner, f.caller, input);
    void opening.then(() => {
      finished = true;
    }, () => {
      finished = true;
    });
    await entered.promise;
    try {
      assertEquals(finished, false);
      assertEquals((await streamRow(f)).row.revocation_state, "revoking");
    } finally {
      release.resolve();
    }
    await assertRejects(() => opening, Error, "reserve acknowledgement failed");
    const { row } = await streamRow(f);
    assertEquals(row.revocation_state, "revoked");
    assertEquals(row.state, "reserving");
    assertEquals(row.stream_ordinal, null);
    assertEquals(f.published.length, 0);
  });
});
Deno.test("owner orphan opening preserves unknown cleanup instead of ordinary failure", async () => {
  await fixture(async (f) => {
    f.setCleanupOrphan((target) =>
      f.content.revoke(f.owner, cleanupCaller, target)
    );
    f.setReserve(() => Promise.reject(new Error("reserve unavailable")));
    f.setFence(() => Promise.reject(new Error("fence unavailable")));
    const error = await assertRejects(
      () => f.content.open(f.owner, f.caller, input),
      AggregateError,
      "cleanup is unresolved",
    );
    assertEquals(
      (error as AggregateError & { indeterminate: boolean }).indeterminate,
      true,
    );
    assertEquals((await streamRow(f)).row.revocation_state, "revoking");
    assertEquals(f.published.length, 0);
  });
});

Deno.test("owner cleanup scan traverses unresolved first-page fences without forgetting rows", async () => {
  await fixture(async (f) => {
    for (let i = 0; i < 20; i++) {
      await f.content.open(f.owner, f.caller, { ...input, id: `cursor-${i}` });
    }
    const rows = (await f.db.query<
      { namespace: string; operation_id: string; stream_id: string }
    >("SELECT namespace,operation_id,stream_id FROM copilotz_operation_streams"))
      .rows;
    for (const row of rows) {
      await f.content.beginRevocation(f.owner, cleanupCaller, {
        namespace: row.namespace,
        operationId: row.operation_id,
        streamId: row.stream_id,
      });
    }
    const first = await f.content.scanCleanup(f.owner, cleanupCaller);
    assertEquals(first.targets.length, 16);
    assertEquals(first.more, true);
    const second = await f.content.scanCleanup(
      f.owner,
      cleanupCaller,
      first.targets.at(-1)!,
    );
    assertEquals(second.targets.length, 4);
    assertEquals(second.more, false);
    assertEquals(
      new Set([...first.targets, ...second.targets].map((t) => t.streamId))
        .size,
      20,
    );
    assertEquals(
      (await f.content.scanCleanup(
        f.owner,
        cleanupCaller,
        second.targets.at(-1)!,
      )).targets,
      [],
    );
    assertEquals(
      (await f.db.query(
        "SELECT 1 FROM copilotz_operation_streams WHERE revocation_state='revoking'",
      )).rows.length,
      20,
    );
    assertEquals(
      (await f.content.scanCleanup(f.owner, cleanupCaller)).targets,
      first.targets,
    );
  });
});

async function prepareSeal(f: Awaited<ReturnType<typeof setup>>) {
  const opened = await f.content.open(f.owner, f.caller, input);
  await f.content.append(f.owner, f.caller, opened.streamId, {
    expectedOffset: 0,
    appendId: "answer",
    bytes: new TextEncoder().encode("abc"),
  });
  await f.content.checkpoint(f.owner, f.caller, opened.streamId, 0, 3);
  return opened;
}
Deno.test("owner seal persists pending descriptor atomically before completed terminal and replays cleanup", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const before = await f.counts();
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      3,
    );
    let row = (await streamRow(f)).row;
    assertEquals([
      row.state,
      row.outcome,
      row.revocation_state,
      Number(row.committed_offset),
    ], ["terminating", "completed", "revoking", 3]);
    assertEquals(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      [],
    );
    await assertRejects(() =>
      f.content.append(f.owner, f.caller, opened.streamId, {
        expectedOffset: 3,
        appendId: "late",
        bytes: new Uint8Array([1]),
      })
    );
    f.setActive(false);
    await f.content.revoke(f.owner, cleanupCaller, target, {
      outcome: "cancelled",
    });
    row = (await streamRow(f)).row;
    assertEquals([
      row.state,
      row.outcome,
      row.revocation_state,
      Number(row.committed_offset),
    ], ["terminal", "completed", "revoked", 3]);
    const bodies =
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows;
    assertEquals(bodies.length, 1);
    assertEquals(
      bodies[0].digest,
      await digestContent(new TextEncoder().encode("abc")),
    );
    assertEquals(bodies[0].pending_descriptor, {
      kind: "text",
      role: "assistant",
      mediaType: "text/plain",
      metadata: opened.metadata,
    });
    assertEquals(bodies[0].asset_id, null);
    assertEquals(bodies[0].domain_owner_id, null);
    await f.content.revoke(f.owner, cleanupCaller, target);
    assertEquals(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      bodies,
    );
    assertEquals(await f.counts(), before);
  }));
Deno.test("owner seal accepts only checkpointed prefix despite a longer physical tail", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const row = (await streamRow(f)).row;
    await f.physical.append({
      writer: {
        bodyId: String(row.body_id),
        reservationId: String(row.reservation_id),
        mediaType: "text/plain",
        generation: 1,
      },
      expectedOffset: 3,
      appendId: "unaccepted",
      bytes: new TextEncoder().encode("tail"),
    });
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      3,
    );
    await f.content.revoke(f.owner, cleanupCaller, target);
    assertEquals(
      (await f.db.query(
        "SELECT byte_length::integer AS length,digest FROM copilotz_operation_bodies",
      )).rows,
      [{
        length: 3,
        digest: await digestContent(new TextEncoder().encode("abc")),
      }],
    );
    assertEquals((await f.physical.head(String(row.body_id)))?.byteLength, 7);
  }));
Deno.test("owner seal mismatch fails at accepted prefix without publishing pending content", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      3,
    );
    f.setReadRange(async (input) => {
      const data = await f.physical.readRange(input);
      data[0] ^= 1;
      return data;
    });
    await f.content.revoke(f.owner, cleanupCaller, target);
    const row = (await streamRow(f)).row;
    assertEquals([
      row.state,
      row.outcome,
      row.capture,
      Number(row.committed_offset),
      row.digest,
    ], ["terminal", "failed", "truncated", 3, null]);
    assertEquals(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      [],
    );
  }));
Deno.test("owner seal retains intent across an unknown physical fence and completes once", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      3,
    );
    f.setFence(async (writer) => {
      await f.physical.fence(writer);
      throw new Error("lost fence reply");
    });
    await assertRejects(() => f.content.revoke(f.owner, cleanupCaller, target));
    assertEquals((await streamRow(f)).row.state, "terminating");
    assertEquals(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      [],
    );
    f.setFence((writer) => f.physical.fence(writer));
    await f.content.revoke(f.owner, cleanupCaller, target);
    assertEquals((await streamRow(f)).row.outcome, "completed");
    assertEquals(
      (await f.db.query(
        "SELECT count(*)::integer AS count FROM copilotz_operation_bodies",
      )).rows,
      [{ count: 1 }],
    );
  }));
Deno.test("owner seal refuses uncheckpointed length and expired original authority", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    await assertRejects(() =>
      f.content.beginSeal(f.owner, f.caller, opened.streamId, 4)
    );
    f.setTime("2026-10-18T00:00:02.000Z");
    await assertRejects(() =>
      f.content.beginSeal(f.owner, f.caller, opened.streamId, 3)
    );
    assertEquals((await streamRow(f)).row.state, "open");
  }));

Deno.test("owner seal preserves intent on transient storage unavailability and retries verification", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      3,
    );
    f.setReadRange(() =>
      Promise.reject(
        Object.assign(new Error("temporary S3 503"), {
          code: "asset_storage_unavailable",
        }),
      )
    );
    const error = await assertRejects(() =>
      f.content.revoke(f.owner, cleanupCaller, target)
    );
    assertEquals((error as { indeterminate?: boolean }).indeterminate, true);
    assertEquals((await streamRow(f)).row.state, "terminating");
    assertEquals(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      [],
    );
    f.setReadRange((input) => f.physical.readRange(input));
    await f.content.revoke(f.owner, cleanupCaller, target);
    assertEquals((await streamRow(f)).row.outcome, "completed");
  }));
Deno.test("owner seal fails a verifier-observed short prefix without a pending descriptor", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      3,
    );
    f.setReadRange(() => Promise.resolve(new Uint8Array(2)));
    await f.content.revoke(f.owner, cleanupCaller, target);
    assertEquals((await streamRow(f)).row.outcome, "failed");
    assertEquals((await streamRow(f)).row.availability, "missing");
    assertEquals(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      [],
    );
  }));

Deno.test("owner seal admits bounded wire metadata despite JSONB whitespace expansion", () =>
  fixture(async (f) => {
    const metadata = Object.fromEntries(
      Array.from({ length: 4900 }, (_, i) => [`key${i}`, ""]),
    );
    const opened = await f.content.open(f.owner, f.caller, {
      ...input,
      metadata,
    });
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      0,
    );
    await f.content.revoke(f.owner, cleanupCaller, target);
    const rows = (await f.db.query(
      "SELECT octet_length(pending_descriptor::text) AS bytes,pending_descriptor FROM copilotz_operation_bodies",
    )).rows;
    assertEquals(rows.length, 1);
    assertEquals(Number(rows[0].bytes) > 65536, true);
    assertEquals(
      (rows[0].pending_descriptor as { metadata: unknown }).metadata,
      opened.metadata,
    );
  }));

Deno.test("owner seal cleanup recovers lost intent and accepted-terminal replies without duplicate bodies", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const before = await f.counts();
    let dropIntent = true, dropTerminal = true;
    const transport = {
      ...f.owner,
      checkpoint: async (...args: Parameters<typeof f.owner.checkpoint>) => {
        const result = await f.owner.checkpoint(...args);
        if (args[1] === OWNER_STREAM_SEAL_INTENT && dropIntent) {
          dropIntent = false;
          throw new Error("lost intent reply");
        }
        if (args[1] === OWNER_STREAM_REVOKED && dropTerminal) {
          dropTerminal = false;
          throw new Error("lost terminal reply");
        }
        return result;
      },
    };
    await assertRejects(
      () => f.content.beginSeal(transport, f.caller, opened.streamId, 3),
      Error,
      "lost intent reply",
    );
    f.setActive(false);
    const { target } = await streamRow(f);
    await assertRejects(
      () => f.content.revoke(transport, cleanupCaller, target),
      Error,
      "lost terminal reply",
    );
    const bodies =
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows;
    assertEquals(bodies.length, 1);
    await f.content.revoke(transport, cleanupCaller, target, {
      outcome: "failed",
    });
    assertEquals((await streamRow(f)).row.outcome, "completed");
    assertEquals(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      bodies,
    );
    assertEquals(await f.counts(), before);
  }));

Deno.test("owner seal rolls pending insertion back with failed terminal update", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      3,
    );
    f.setQueryFault((sql) => sql.includes("SET revocation_state='revoked'"));
    await assertRejects(
      () => f.content.revoke(f.owner, cleanupCaller, target),
      Error,
      "injected terminal write failure",
    );
    assertEquals(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      [],
    );
    assertEquals((await streamRow(f)).row.state, "terminating");
    f.setQueryFault(undefined);
    await Promise.all([
      f.content.revoke(f.owner, cleanupCaller, target),
      f.content.revoke(f.owner, cleanupCaller, target),
    ]);
    assertEquals(
      (await f.db.query(
        "SELECT count(*)::integer AS count FROM copilotz_operation_bodies",
      )).rows,
      [{ count: 1 }],
    );
    assertEquals((await streamRow(f)).row.outcome, "completed");
  }));
Deno.test("owner seal cannot record intent after authority is lost during hashing", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const entered = deferred(), release = deferred();
    f.setReadRange(async (input) => {
      entered.resolve();
      await release.promise;
      return f.physical.readRange(input);
    });
    const sealing = f.content.beginSeal(f.owner, f.caller, opened.streamId, 3);
    const observed = sealing.catch((error: unknown) => error);
    await entered.promise;
    f.setActive(false);
    release.resolve();
    assertEquals(await observed instanceof Error, true);
    assertEquals((await streamRow(f)).row.state, "open");
    const { target } = await streamRow(f);
    await f.content.revoke(f.owner, cleanupCaller, target, {
      outcome: "failed",
    });
    assertEquals((await streamRow(f)).row.outcome, "failed");
    assertEquals(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      [],
    );
  }));

Deno.test("owner seal status returns exact pending pointer under current producer authority", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    assertEquals(
      await f.content.sealStatus(f.owner, f.caller, opened.streamId),
      { state: "open", pending: null },
    );
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      3,
    );
    assertEquals(
      await f.content.sealStatus(f.owner, f.caller, opened.streamId),
      { state: "sealing", pending: null },
    );
    await f.content.revoke(f.owner, cleanupCaller, target);
    const before = await f.counts();
    const result = await f.content.sealStatus(
      f.owner,
      f.caller,
      opened.streamId,
    );
    assertEquals(result.state, "completed");
    assertEquals(Object.keys(result.pending!).sort(), [
      "byteLength",
      "digest",
      "mediaType",
      "pendingRef",
      "type",
    ]);
    assertEquals(result.pending?.byteLength, 3);
    assertEquals(
      result.pending?.digest,
      await digestContent(new TextEncoder().encode("abc")),
    );
    assertEquals(
      await f.content.sealStatus(f.owner, f.caller, opened.streamId),
      result,
    );
    assertEquals(await f.counts(), before);
    f.setActive(false);
    await assertRejects(() =>
      f.content.sealStatus(f.owner, f.caller, opened.streamId)
    );
  }));
Deno.test("owner seal status does not invent pending output after failed capture", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const { target } = await streamRow(f);
    await f.content.revoke(f.owner, cleanupCaller, target, {
      outcome: "failed",
    });
    assertEquals(
      await f.content.sealStatus(f.owner, f.caller, opened.streamId),
      { state: "failed", pending: null },
    );
  }));

Deno.test("owner seal stores placement-neutral producer facts independently of public metadata and scope rows", () =>
  fixture(async (f) => {
    const opened = await f.content.open(f.owner, f.caller, {
      ...input,
      metadata: {
        producer: { actionId: "forged" },
        sourceActionRunId: "forged",
      },
    });
    const { row: stream } = await streamRow(f);
    const binding = stream.placement_binding as Record<string, unknown>;
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      0,
    );
    await f.content.revoke(f.owner, cleanupCaller, target);
    const body = (await f.db.query(
      "SELECT producer,settlement_scope_id FROM copilotz_operation_bodies",
    )).rows[0];
    assertEquals(body.producer, {
      kind: "processor",
      processorId: "fixture",
      sourceEventId: binding.sourceEventId,
      deliveryId: binding.deliveryId,
      deliveryAttempt: 1,
    });
    assertEquals(body.settlement_scope_id, target.operationId);
    await f.db.query("DELETE FROM copilotz_operation_streams");
    await f.db.query("DELETE FROM copilotz_operations");
    assertEquals(
      (await f.db.query(
        "SELECT producer,settlement_scope_id FROM copilotz_operation_bodies",
      )).rows,
      [body],
    );
  }));
Deno.test("owner seal refuses substituted stream incarnation before physical cleanup", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      3,
    );
    const { row } = await streamRow(f);
    await f.db.query(
      "UPDATE copilotz_operation_streams SET placement_binding=jsonb_set(placement_binding,'{deliveryId}',$1::jsonb)",
      [JSON.stringify("other-delivery")],
    );
    let fences = 0;
    f.setFence((writer) => {
      fences++;
      return f.physical.fence(writer);
    });
    await assertRejects(() => f.content.revoke(f.owner, cleanupCaller, target));
    assertEquals(fences, 0);
    assertEquals(
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows,
      [],
    );
    await f.db.query(
      "UPDATE copilotz_operation_streams SET placement_binding=$1::jsonb",
      [JSON.stringify(row.placement_binding)],
    );
    await f.content.revoke(f.owner, cleanupCaller, target);
    assertEquals((await streamRow(f)).row.outcome, "completed");
  }));

Deno.test("owner seal status refuses contradictory retained body evidence", () =>
  fixture(async (f) => {
    const opened = await prepareSeal(f);
    const target = await f.content.beginSeal(
      f.owner,
      f.caller,
      opened.streamId,
      3,
    );
    await f.content.revoke(f.owner, cleanupCaller, target);
    const original =
      (await f.db.query("SELECT * FROM copilotz_operation_bodies")).rows[0];
    const patches = {
      digest: `sha256:${"b".repeat(64)}`,
      byte_length: 2,
      media_type: "image/png",
      pending_ref: "substituted",
      logical_body_id: "substituted",
      producer: JSON.stringify({ kind: "processor", processorId: "other" }),
    };
    for (const [field, value] of Object.entries(patches)) {
      const cast = field === "producer" ? "::jsonb" : "";
      await f.db.query(
        `UPDATE copilotz_operation_bodies SET ${field}=$1${cast}`,
        [value],
      );
      await assertRejects(() =>
        f.content.sealStatus(f.owner, f.caller, opened.streamId)
      );
      await f.db.query(
        `UPDATE copilotz_operation_bodies SET ${field}=$1${cast}`,
        [
          field === "producer"
            ? JSON.stringify(original[field])
            : original[field],
        ],
      );
    }
    assertEquals(
      (await f.content.sealStatus(f.owner, f.caller, opened.streamId)).state,
      "completed",
    );
  }));
