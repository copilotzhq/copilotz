import { assert, assertEquals, assertRejects } from "@std/assert";
import { createMemoryBodyStore } from "../runtime/content/body-store.ts";
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import type {
  OperationChangeDetail,
  OperationStreamRecord,
} from "../runtime/streams/catalog.ts";
import { encodeOperationReplayCursor } from "../runtime/streams/cursor.ts";
import type { StreamOutput } from "../runtime/streams/types.ts";
import { createSharedOperationReaders } from "../runtime/application/operation-readers.ts";
import { createCopilotzApplication } from "../runtime/application/application.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import { definePlugin, defineProcessor } from "../runtime/plugins/index.ts";
import type { ContentStreamWriter } from "../runtime/streams/types.ts";
import {
  MAX_LOGICAL_OUTPUT_BYTES,
  OBSERVATION_FRAME_CAPACITY_CODE,
} from "../runtime/streams/limits.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => resolve = next);
  return { promise, resolve };
}

async function until(check: () => boolean) {
  const deadline = performance.now() + 2_000;
  while (!check()) {
    if (performance.now() > deadline) {
      throw new Error("Timed out waiting for reader.");
    }
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function fixture() {
  const body = createMemoryBodyStore();
  const writer = await body.reserve({
    bodyId: "body",
    mediaType: "text/plain",
  });
  const counts = {
    watches: 0,
    closes: 0,
    bodyReads: 0,
    eventReads: 0,
    status: 0,
    streams: 0,
  };
  let record: OperationStreamRecord = {
    namespace: "tenant",
    operationId: "op",
    streamId: "lane",
    semanticStreamId: "lane",
    replayKey: "lane",
    streamOrdinal: "1",
    bodyId: "body",
    state: "open",
    availability: "retained",
    committedOffset: 0,
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
    descriptor: {
      type: "stream.output",
      namespace: "tenant",
      streamId: "lane",
      mediaType: "text/plain",
      kind: "text",
      role: "assistant",
      metadata: {},
    },
  };
  let onRange: ((offset: number, end: number) => Promise<void>) | undefined;
  let completed = false;
  let eventData: (id: string) => unknown = (id) => ({ id });
  const indexed: { eventId: string; eventOrdinal: string }[] = [];
  const wakes = new Set<() => void>();
  const hints = new Set<(id: string, detail: OperationChangeDetail) => void>();
  const notify = (kind: OperationChangeDetail["kind"] = "stream-offset") => {
    for (const hint of hints) {
      hint("op", {
        namespace: "tenant",
        selectionKeys: [],
        kind,
        streamId: "lane",
        committedOffset: record.committedOffset,
      });
    }
    for (const wake of [...wakes]) wake();
  };
  const operations = {
    onChange(listener: (id: string, detail: OperationChangeDetail) => void) {
      hints.add(listener);
      return Promise.resolve(() => {
        hints.delete(listener);
      });
    },
    async watch() {
      counts.watches++;
      let closed = false;
      let pending = false;
      let finish: (() => void) | undefined;
      const notified = () => {
        pending = true;
        finish?.();
      };
      hints.add(notified);
      return {
        wait(
          { timeoutMs = 50, signal }: {
            timeoutMs?: number;
            signal?: AbortSignal;
          } = {},
        ) {
          if (closed || signal?.aborted) return Promise.resolve(false);
          if (pending) {
            pending = false;
            return Promise.resolve(true);
          }
          return new Promise<boolean>((resolve) => {
            const end = () => {
              clearTimeout(timer);
              wakes.delete(end);
              signal?.removeEventListener("abort", end);
              finish = undefined;
              const changed = pending;
              pending = false;
              resolve(changed);
            };
            const timer = setTimeout(end, timeoutMs);
            finish = end;
            wakes.add(end);
            signal?.addEventListener("abort", end, { once: true });
          });
        },
        close() {
          if (!closed) {
            closed = true;
            counts.closes++;
            hints.delete(notified);
            finish?.();
          }
        },
      };
    },
    async listStreams(input: { afterStreamOrdinal?: string }) {
      counts.streams++;
      return input.afterStreamOrdinal ? [] : [record];
    },
    async getStream() {
      return record;
    },
    async get() {
      return {
        operationId: "op",
        namespace: "tenant",
        correlationId: "correlation",
        rootEventId: "root",
        state: completed ? "completed" : "running",
        metadata: {},
        acceptedAt: "2026-10-06T00:00:00Z",
        updatedAt: "2026-10-06T00:00:00Z",
      };
    },
    async listOperationEventIds(input: { afterEventOrdinal?: string }) {
      return indexed.filter((row) =>
        !input.afterEventOrdinal ||
        BigInt(row.eventOrdinal) > BigInt(input.afterEventOrdinal)
      );
    },
  };
  const application = {
    config: { namespace: "tenant", databaseSchema: "scope" },
    operations,
    events: {
      async resolve(_namespace: string, id: string) {
        counts.eventReads++;
        const row = indexed.find((entry) => entry.eventId === id)!;
        return {
          durable: true,
          id,
          position: String(1000 + Number(row.eventOrdinal)),
          schemaVersion: 1,
          type: "test.event",
          namespace: "tenant",
          payload: {},
          data: eventData(id),
          metadata: {},
          correlationId: "correlation",
          createdAt: "2026-10-06T00:00:00Z",
        };
      },
    },
    streams: {
      async readCommittedRange(
        input: { bodyId: string; offset: number; end: number },
      ) {
        counts.bodyReads++;
        await onRange?.(input.offset, input.end);
        return body.readRange(input);
      },
    },
    async operationStatus() {
      counts.status++;
      return {
        operationId: "op",
        namespace: "tenant",
        correlationId: "correlation",
        state: completed ? "completed" : "running",
        metadata: {},
        acceptedAt: "2026-10-06T00:00:00Z",
        updatedAt: "2026-10-06T00:00:00Z",
      };
    },
  } as unknown as InternalCopilotzApplication;
  return {
    application,
    counts,
    eventData(next: typeof eventData) {
      eventData = next;
    },
    gateRange(next: typeof onRange) {
      onRange = next;
    },
    async append(text: string) {
      const next = await body.append({
        writer,
        expectedOffset: record.committedOffset,
        appendId: crypto.randomUUID(),
        bytes: new TextEncoder().encode(text),
      });
      record = { ...record, committedOffset: next.endOffset };
      notify("stream-offset");
    },
    event(id: string) {
      indexed.push({ eventId: id, eventOrdinal: String(indexed.length + 1) });
      notify("event");
    },
    async complete() {
      await body.seal({ writer, expectedByteLength: record.committedOffset });
      record = {
        ...record,
        state: "terminal",
        outcome: "completed",
        capture: "complete",
        terminalAt: "2026-10-06T00:00:01Z",
      };
      completed = true;
      notify("stream");
    },
  };
}

const fast = { minimumScanMs: 0, safetyScanMs: 10 };
const text = (bytes?: Uint8Array) => new TextDecoder().decode(bytes);
const cursor = (offset: number) =>
  encodeOperationReplayCursor({
    operationStreamPositions: {
      op: { highWatermark: 0, offsets: { "1": offset } },
    },
  });

Deno.test("byte-only hints share reads without repeating topology or settlement reconciliation", async () => {
  const f = await fixture();
  const readers = createSharedOperationReaders(f.application, {
    minimumScanMs: 50,
    safetyScanMs: 5000,
  });
  const attachment = await readers.attach({ operationId: "op" });
  const output = (await attachment.outputs.getReader().read())
    .value as StreamOutput;
  const payload = output.payload.getReader();
  await until(() => f.counts.streams === 1);
  for (let i = 0; i < 4; i++) {
    const read = payload.read();
    await f.append("byte");
    assertEquals(text((await read).value), "byte");
    await new Promise((resolve) => setTimeout(resolve, 55));
  }
  assertEquals(f.counts.streams, 1);
  assertEquals(f.counts.status, 1);
  await f.complete();
  assertEquals((await payload.read()).done, true);
  await attachment.done;
  assertEquals(f.counts.status, 2, "terminal lanes reconcile promptly");
  await readers.close();
  await assertRejects(() => readers.attach({ operationId: "op" }));
});

Deno.test("shared operation readers fan out real BodyStore bytes once and keep independent offsets", async () => {
  const f = await fixture();
  const readers = createSharedOperationReaders(f.application, fast);
  await f.append("abcdef");
  const [first, second] = await Promise.all([
    readers.attach({ operationId: "op" }),
    readers.attach({ operationId: "op", cursor: cursor(3) }),
  ]);
  const a = first.outputs.getReader();
  const b = second.outputs.getReader();
  const streamA = (await a.read()).value as StreamOutput;
  const streamB = (await b.read()).value as StreamOutput;
  assert(streamA.payload !== streamB.payload);
  const payloadA = streamA.payload.getReader();
  const payloadB = streamB.payload.getReader();
  assertEquals(text((await payloadA.read()).value), "abcdef");
  assertEquals(text((await payloadB.read()).value), "def");
  assertEquals(f.counts.bodyReads, 1);
  assertEquals(f.counts.watches, 1);
  const nextA = payloadA.read();
  const nextB = payloadB.read();
  await f.append("ghi");
  assertEquals(text((await nextA).value), "ghi");
  assertEquals(text((await nextB).value), "ghi");
  assertEquals(f.counts.bodyReads, 2);
  await first.detach();
  assertEquals(f.counts.closes, 0);
  await second.detach();
  assertEquals(f.counts.closes, 1);
});

Deno.test("late operation replay joins live writes during a gated catch-up without gaps", async () => {
  const f = await fixture();
  const readers = createSharedOperationReaders(f.application, fast);
  const first = await readers.attach({ operationId: "op" });
  const a = first.outputs.getReader();
  const stream = (await a.read()).value as StreamOutput;
  const payloadA = stream.payload.getReader();
  const initial = payloadA.read();
  await f.append("abcdef");
  await initial;
  const second = await readers.attach({ operationId: "op", cursor: cursor(2) });
  const b = second.outputs.getReader();
  const replay = (await b.read()).value as StreamOutput;
  const payloadB = replay.payload.getReader();
  const gated = deferred<void>();
  const entered = deferred<void>();
  f.gateRange(async (offset, end) => {
    if (offset === 2 && end === 6) {
      entered.resolve();
      await gated.promise;
    }
  });
  const history = payloadB.read();
  await entered.promise;
  const liveA = payloadA.read();
  await f.append("ghi");
  await liveA;
  gated.resolve();
  assertEquals(text((await history).value), "cdef");
  assertEquals(text((await payloadB.read()).value), "ghi");
  await f.complete();
  assertEquals((await payloadB.read()).done, true);
  assertEquals((await replay.terminal).offset, 9);
  await first.detach();
  await second.detach();
});

Deno.test("slow operation subscribers renew at a bounded queue while healthy viewer continues", async () => {
  const f = await fixture();
  const readers = createSharedOperationReaders(f.application, {
    ...fast,
    maxQueuedBytes: 512,
    maxQueuedOutputs: 32,
    bodyReadBytes: 64,
  });
  const healthy = await readers.attach({ operationId: "op" });
  const slow = await readers.attach({ operationId: "op" });
  const a = healthy.outputs.getReader();
  const b = slow.outputs.getReader();
  const streamA = (await a.read()).value as StreamOutput;
  const streamB = (await b.read()).value as StreamOutput;
  const payloadA = streamA.payload.getReader();
  const received = (async () => {
    let bytes = 0;
    while (bytes < 2048) bytes += (await payloadA.read()).value!.length;
    return bytes;
  })();
  await f.append("x".repeat(2048));
  assertEquals(await received, 2048);
  const error = await assertRejects(() => slow.done);
  assertEquals(
    (error as Error & { code: string }).code,
    "observation_renewal_required",
  );
  const slowPayload = streamB.payload.getReader();
  let prefixBytes = 0;
  const interrupted = await assertRejects(async () => {
    while (true) prefixBytes += (await slowPayload.read()).value!.length;
  });
  assertEquals(
    (interrupted as Error & { code: string }).code,
    "observation_renewal_required",
  );
  assert(prefixBytes > 0 && prefixBytes <= 512);
  await slow.drained;
  assertEquals(f.counts.closes, 0);
  await healthy.detach();
  assertEquals(f.counts.closes, 1);
});

Deno.test("operation events hydrate once live, retain global fact positions, and replay local cursors", async () => {
  const f = await fixture();
  const readers = createSharedOperationReaders(f.application, fast);
  const first = await readers.attach({ operationId: "op" });
  const second = await readers.attach({ operationId: "op" });
  const a = first.outputs.getReader();
  const b = second.outputs.getReader();
  await a.read();
  await b.read();
  const nextA = a.read();
  const nextB = b.read();
  f.event("one");
  const eventA = (await nextA).value as unknown as {
    position: string;
    replayPosition: string;
  };
  const eventB = (await nextB).value as unknown as {
    position: string;
    replayPosition: string;
  };
  assertEquals(eventA.position, "1001");
  assertEquals(eventA.replayPosition, "1");
  assertEquals(eventB, eventA);
  assertEquals(f.counts.eventReads, 1);
  const late = await readers.attach({
    operationId: "op",
    cursor: encodeOperationReplayCursor({
      operationEventPositions: { op: "1" },
      operationStreamPositions: { op: { highWatermark: 1, offsets: {} } },
    }),
  });
  const c = late.outputs.getReader();
  const nextC = c.read();
  f.event("two");
  const eventC = (await nextC).value as unknown as { replayPosition: string };
  assertEquals(eventC.replayPosition, "2");
  assertEquals(f.counts.eventReads, 2);
  await first.detach();
  await second.detach();
  await late.detach();
});

Deno.test("large logical outputs pass an empty reader queue while subsequent backlog stays bounded", async () => {
  const f = await fixture();
  const value = "x".repeat(1024 * 1024 + 4096);
  f.eventData(() => ({ value }));
  const readers = createSharedOperationReaders(f.application, fast);
  const healthy = await readers.attach({ operationId: "op" });
  const outputs = healthy.outputs.getReader();
  await outputs.read();
  const first = outputs.read();
  f.event("large-one");
  assertEquals(((await first).value as { data: unknown }).data, { value });
  const next = outputs.read();
  f.event("large-two");
  assertEquals(((await next).value as { data: unknown }).data, { value });

  // A slow subscriber can retain one large envelope, but no further backlog.
  const slow = await readers.attach({
    operationId: "op",
    cursor: encodeOperationReplayCursor({
      operationEventPositions: { op: "2" },
      operationStreamPositions: { op: { highWatermark: 1, offsets: {} } },
    }),
  });
  const third = outputs.read();
  f.event("large-three");
  assertEquals(((await third).value as { data: unknown }).data, { value });
  const fourth = outputs.read();
  f.event("large-four");
  assertEquals(((await fourth).value as { data: unknown }).data, { value });
  const error = await assertRejects(() => slow.done);
  assertEquals(
    (error as Error & { code: string }).code,
    "observation_renewal_required",
  );
  assertEquals(f.counts.closes, 0);
  await healthy.detach();
  assertEquals(f.counts.closes, 1);
});

Deno.test("outputs above the logical protocol ceiling fail deterministically", async () => {
  const f = await fixture();
  // Envelope encoding adds bytes, so this cannot fit the protocol ceiling.
  const value = "x".repeat(MAX_LOGICAL_OUTPUT_BYTES);
  f.eventData(() => ({ value }));
  const readers = createSharedOperationReaders(f.application, fast);
  const attachment = await readers.attach({ operationId: "op" });
  const outputs = attachment.outputs.getReader();
  await outputs.read();
  const next = outputs.read();
  f.event("oversized");
  const error = await assertRejects(() => next, Error, "capacity");
  assertEquals(
    (error as Error & { code: string }).code,
    OBSERVATION_FRAME_CAPACITY_CODE,
  );
  await assertRejects(() => attachment.done);
  await attachment.drained;
  assertEquals(f.counts.closes, 1);
  await readers.close();
});

Deno.test("slow subscriber resumes from its own processed offset and recovers every byte", async () => {
  const f = await fixture();
  const readers = createSharedOperationReaders(f.application, {
    ...fast,
    maxQueuedBytes: 512,
    bodyReadBytes: 64,
  });
  const first = await readers.attach({ operationId: "op" });
  const output = (await first.outputs.getReader().read()).value as StreamOutput;
  const payload = output.payload.getReader();
  const initial = payload.read();
  await f.append("a".repeat(64));
  assertEquals((await initial).value!.byteLength, 64);
  await f.append("b".repeat(1024));
  const error = await assertRejects(() => first.done);
  assertEquals(
    (error as Error & { code: string }).code,
    "observation_renewal_required",
  );
  // Reopen using bytes actually read by this viewer, rather than the hub's read frontier.
  const resumed = await readers.attach({
    operationId: "op",
    cursor: cursor(64),
  });
  const replay = (await resumed.outputs.getReader().read())
    .value as StreamOutput;
  const next = replay.payload.getReader();
  let received = "";
  while (received.length < 1024) received += text((await next.read()).value);
  assertEquals(received, "b".repeat(1024));
  await resumed.detach();
});

Deno.test("an ahead replay cursor fails only that viewer", async () => {
  const f = await fixture();
  const readers = createSharedOperationReaders(f.application, fast);
  const healthy = await readers.attach({ operationId: "op" });
  const output = (await healthy.outputs.getReader().read())
    .value as StreamOutput;
  const payload = output.payload.getReader();
  const ahead = await readers.attach({ operationId: "op", cursor: cursor(1) });
  const error = await assertRejects(() => ahead.done);
  assertEquals((error as Error & { code: string }).code, "replay_cursor_ahead");
  const read = payload.read();
  await f.append("healthy");
  assertEquals(text((await read).value), "healthy");
  assertEquals(f.counts.closes, 0);
  await healthy.detach();
});

Deno.test("the last operation detach releases readers and a later attach replays durably", async () => {
  const f = await fixture();
  const readers = createSharedOperationReaders(f.application, fast);
  const first = await readers.attach({ operationId: "op" });
  const output = (await first.outputs.getReader().read()).value as StreamOutput;
  const payload = output.payload.getReader();
  const read = payload.read();
  await f.append("kept");
  await read;
  await first.detach();
  await until(() => f.counts.closes === 1);
  const later = await readers.attach({ operationId: "op", cursor: cursor(2) });
  const replay = (await later.outputs.getReader().read()).value as StreamOutput;
  assertEquals(text((await replay.payload.getReader().read()).value), "pt");
  assertEquals(f.counts.watches, 2);
  await later.detach();
  assertEquals(f.counts.closes, 2);
});

Deno.test("shared readers integrate real application catalog settlement and database BodyStore", async () => {
  const db = await createTestDatabase({ url: ":memory:" });
  const opened = deferred<void>();
  const finished = deferred<void>();
  let writer!: ContentStreamWriter;
  let reads = 0;
  const application = await createCopilotzApplication({
    database: db,
    namespace: "tenant",
    databaseSchema: "shared_reader_integration",
    plugins: [definePlugin({
      id: "shared-reader",
      version: "1",
      processors: {
        stream: defineProcessor<
          import("../runtime/plugins/index.ts").ProcessorContext
        >({
          id: "shared-reader.stream",
          on: [{ eventType: "test.stream" }],
          async handle(_event, context) {
            writer = await context.streams.open({
              mediaType: "text/plain",
              role: "assistant",
            });
            opened.resolve();
            await finished.promise;
            await writer.close({ assetId: "shared-reader-asset" });
          },
        }),
      },
    })],
  });
  const runtime = application as unknown as InternalCopilotzApplication;
  const range = runtime.streams.readCommittedRange;
  const instrumented = {
    ...runtime,
    streams: {
      ...runtime.streams,
      readCommittedRange(input: Parameters<typeof range>[0]) {
        reads++;
        return range(input);
      },
    },
  };
  const readers = createSharedOperationReaders(instrumented, {
    ...fast,
    safetyScanMs: 20,
  });
  const attached: Awaited<ReturnType<typeof readers.attach>>[] = [];
  try {
    const sent = await application.send({ type: "test.stream" });
    await opened.promise;
    attached.push(
      ...await Promise.all([
        readers.attach({ operationId: sent.operationId }),
        readers.attach({ operationId: sent.operationId }),
      ]),
    );
    const outputs = attached.map((attachment) =>
      attachment.outputs.getReader()
    );
    const streams = await Promise.all(outputs.map(async (output) => {
      while (true) {
        const next = await output.read();
        if (next.value?.type === "stream.output") {
          return next.value as StreamOutput;
        }
      }
    }));
    const payloads = streams.map((stream) => stream.payload.getReader());
    const bytes = payloads.map((payload) => payload.read());
    await writer.append({
      bytes: new TextEncoder().encode("actual database body"),
      appendId: "shared-reader-1",
    });
    assertEquals((await Promise.all(bytes)).map((next) => text(next.value)), [
      "actual database body",
      "actual database body",
    ]);
    assertEquals(reads, 1);
    finished.resolve();
    await sent.done;
    assertEquals(
      (await Promise.all(payloads.map((payload) => payload.read()))).map((
        next,
      ) => next.done),
      [true, true],
    );
    assertEquals(
      (await Promise.all(streams.map((stream) => stream.terminal))).map((
        terminal,
      ) => terminal.offset),
      [20, 20],
    );
    await Promise.all(outputs.map(async (output) => {
      while (!(await output.read()).done) { /* drain settlement events */ }
    }));
    await Promise.all(attached.map((attachment) => attachment.done));
  } finally {
    finished.resolve();
    await Promise.all(attached.map((attachment) => attachment.detach()));
    await application.shutdown();
    await db.close();
  }
});

Deno.test("shared reader scope inputs normalize before cache keys, queries and replay lookup", async () => {
  const f = await fixture();
  const seen: unknown[] = [];
  const application = {
    ...f.application,
    operationStatus(input: unknown) {
      seen.push(input);
      return f.application.operationStatus(
        input as Parameters<typeof f.application.operationStatus>[0],
      );
    },
  } as InternalCopilotzApplication;
  const readers = createSharedOperationReaders(application, fast);
  try {
    const [first, second] = await Promise.all([
      readers.attach({
        operationId: " op ",
        namespace: " tenant ",
        databaseSchema: " scope ",
      }),
      readers.attach({
        operationId: "op",
        namespace: "tenant",
        databaseSchema: "scope",
      }),
    ]);
    assertEquals(first.operationId, "op");
    assertEquals(second.operationId, "op");
    assertEquals(f.counts.watches, 1);
    assertEquals(seen[0], {
      operationId: "op",
      namespace: "tenant",
      databaseSchema: "scope",
    });
    const calls = seen.length;
    for (
      const input of [
        { operationId: " " },
        { operationId: "op", namespace: " " },
        { operationId: "op", databaseSchema: " " },
      ]
    ) {
      await assertRejects(
        () => readers.attach(input),
        TypeError,
        "must be non-empty",
      );
    }
    assertEquals(seen.length, calls);
    await first.detach();
    await second.detach();
  } finally {
    await readers.close();
  }
});

Deno.test("shutdown rejects delayed acquisitions and releases only resources already acquired", async () => {
  for (
    const stage of ["databaseScope", "status", "watch", "onChange"] as const
  ) {
    const f = await fixture();
    const gate = deferred<void>();
    const entered = deferred<void>();
    let subscriptions = 0;
    let removed = 0;
    const application = {
      ...f.application,
      async databaseScope() {
        entered.resolve();
        await gate.promise;
        return application;
      },
      async operationStatus(
        input: Parameters<typeof f.application.operationStatus>[0],
      ) {
        if (stage === "status") {
          entered.resolve();
          await gate.promise;
        }
        return await f.application.operationStatus(input);
      },
      operations: {
        ...f.application.operations,
        async watch(
          ...args: Parameters<typeof f.application.operations.watch>
        ) {
          if (stage === "watch") {
            entered.resolve();
            await gate.promise;
          }
          return await f.application.operations.watch(...args);
        },
        async onChange(
          ...args: Parameters<typeof f.application.operations.onChange>
        ) {
          subscriptions++;
          if (stage === "onChange") {
            entered.resolve();
            await gate.promise;
          }
          const remove = await f.application.operations.onChange(...args);
          return () => {
            removed++;
            remove();
          };
        },
      },
    } as InternalCopilotzApplication;
    const readers = createSharedOperationReaders(application, fast);
    const attaching = readers.attach({
      operationId: "op",
      ...(stage === "databaseScope" ? { databaseSchema: "other" } : {}),
    });
    void attaching.catch(() => undefined);
    await entered.promise;
    const closing = readers.close();
    gate.resolve();
    const error = await assertRejects(() => attaching);
    assertEquals((error as { code?: string }).code, "application_closed");
    await closing;
    assertEquals(
      f.counts.watches,
      stage === "status" || stage === "databaseScope" ? 0 : 1,
    );
    assertEquals(
      f.counts.closes,
      stage === "status" || stage === "databaseScope" ? 0 : 1,
    );
    assertEquals(subscriptions, stage === "onChange" ? 1 : 0);
    assertEquals(removed, stage === "onChange" ? 1 : 0);
    await assertRejects(
      () => readers.attach({ operationId: "op" }),
      Error,
      "closed",
    );
  }
});

Deno.test("failed hint subscription closes the previously acquired operation watch", async () => {
  const f = await fixture();
  const application = {
    ...f.application,
    operations: {
      ...f.application.operations,
      onChange() {
        return Promise.reject(new Error("hint connection unavailable"));
      },
    },
  } as InternalCopilotzApplication;
  const readers = createSharedOperationReaders(application, fast);
  try {
    await assertRejects(
      () => readers.attach({ operationId: "op" }),
      Error,
      "hint connection unavailable",
    );
    assertEquals(f.counts.watches, 1);
    assertEquals(f.counts.closes, 1);
  } finally {
    await readers.close();
  }
});

Deno.test("detachment and shutdown discard undrained renewal prefixes after releasing upstream immediately", async () => {
  for (const action of ["detach", "shutdown"] as const) {
    const f = await fixture();
    const readers = createSharedOperationReaders(f.application, {
      ...fast,
      maxQueuedBytes: 512,
      bodyReadBytes: 64,
    });
    const attachment = await readers.attach({ operationId: "op" });
    const outputs = attachment.outputs.getReader();
    const stream = (await outputs.read()).value as StreamOutput;
    await f.append("x".repeat(2048));
    await assertRejects(() => attachment.done);
    assertEquals(
      f.counts.closes,
      1,
      "Network drainage cannot defer the operation watch release.",
    );
    let drained = false;
    void attachment.drained.then(() => drained = true);
    await Promise.resolve();
    assertEquals(drained, false, "The bounded byte prefix is still unread.");
    if (action === "detach") await attachment.detach();
    else await readers.close();
    await attachment.drained;
    assertEquals(drained, true);
    await assertRejects(() => stream.payload.getReader().read());
    await readers.close();
  }
});
