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
  OWNER_STREAM_CONFIRM,
  OWNER_STREAM_RESERVE,
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
) {
  const f = await setup();
  try {
    await run(f);
  } finally {
    f.owner.stop();
    await f.db.close();
  }
}
async function setup() {
  const db = await createTestDatabase({ url: ":memory:" });
  try {
    return await initialize(db);
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
async function initialize(db: TestDatabase) {
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
  const published: unknown[] = [];
  const content = createOwnerStreamReservations({
    ownerId: "owner",
    schema: "public",
    session: db,
    backendId: "memory",
    physical: {
      ...physical,
      reserve(identity) {
        physicalCalls++;
        return reserve(identity);
      },
    },
    protectionMs: 1000,
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
  const owner = createOwnerCommandBoundary({
    session: db,
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
    currentAuthorizationKinds: [OWNER_STREAM_RESERVE, OWNER_STREAM_CONFIRM],
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
    await assertRejects(() =>
      f.owner.execute(f.caller, {
        kind: OWNER_STREAM_RESERVE,
        domain: "occurrence",
        key: "fake",
        intent: input,
      })
    );
    await assertRejects(() =>
      f.owner.project(f.caller, OWNER_STREAM_CONFIRM, { open: input, head: {} })
    );
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
