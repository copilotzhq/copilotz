import { assert, assertEquals, assertRejects } from "@std/assert";
import type {
  ApplicationOperationAttachInput,
  ApplicationOperationAttachment,
  ApplicationOperationStatus,
  InternalCopilotzApplication,
} from "../runtime/application/types.ts";
import type {
  OperationCatalog,
  OperationRecord,
  OperationStreamRecord,
} from "../runtime/streams/catalog.ts";
import {
  createOperationReplayCursorTracker,
  decodeOperationReplayCursor,
  encodeOperationReplayCursor,
} from "../runtime/streams/cursor.ts";
import type { HttpReadServices } from "../plugins/server/authoring/http-adapter/index.ts";
import type {
  ServerAuthorizedScope,
  ServerConstraints,
} from "../plugins/server/shared/contracts.ts";
import { createHttpOperations } from "./operations.ts";
import { createMemoryBodyStore } from "../runtime/content/body-store.ts";
import { applicationOutputsMultipartResponse } from "./multipart.ts";
import { decodeObservation } from "../client/protocol.ts";
import { createCopilotzClient, ProtocolError } from "../client/index.ts";
import { createSharedOperationReaders } from "../runtime/application/operation-readers.ts";
import { createHttpReads } from "./reads.ts";
import { watchSelection } from "./selection-watch.ts";
import { createTestDatabase } from "../runtime/testing/ominipg.ts";
import {
  createEventCoordinator,
  createEventStore,
  provisionCopilotzSchema,
} from "../runtime/events/index.ts";
import { createDeliveryExecutor } from "../runtime/execution/index.ts";
import { createPluginRegistry } from "../runtime/plugins/index.ts";
import { createTestProcessorContext } from "../runtime/testing/processor-context.ts";
import {
  createCollectionRuntime,
  defineCollection,
} from "../runtime/collections/index.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../runtime/streams/catalog.ts";
import { coreThreadObservationKey } from "../plugins/core/shared/events/index.ts";
import { resolveProcessorEvent } from "../runtime/plugins/event-data.ts";
import type { ApplicationOutput } from "../runtime/application/types.ts";

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
}>;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => resolve = next);
  return { promise, resolve };
}

function operation(
  operationId: string,
  metadata: Readonly<Record<string, unknown>>,
): OperationRecord {
  return {
    operationId,
    namespace: "tenant",
    rootEventId: `event-${operationId}`,
    correlationId: `correlation-${operationId}`,
    metadata,
    state: "running",
    acceptedAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function closedAttachment(
  operationId: string,
  detach: () => void = () => undefined,
): ApplicationOperationAttachment {
  const outputs = new ReadableStream({
    start(controller) {
      controller.close();
    },
  });
  return {
    operationId,
    replayCursor: "{}",
    outputs,
    done: Promise.resolve(),
    drained: Promise.resolve(),
    detach() {
      detach();
      return Promise.resolve();
    },
  };
}

function testRead(): HttpReadServices {
  return {
    get(collection, id) {
      return Promise.resolve(
        collection === "thread"
          ? {
            id,
            namespace: "tenant",
            createdAt: "2026-09-16T00:00:00.000Z",
            updatedAt: "2026-09-16T00:00:00.000Z",
          }
          : null,
      );
    },
    list() {
      return Promise.resolve([]);
    },
    aggregate() {
      return Promise.resolve([]);
    },
    query() {
      return Promise.resolve([]);
    },
  };
}

function testScope(): ServerAuthorizedScope {
  return { namespace: "tenant", databaseSchema: "test" };
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withDeadline<T>(
  promise: Promise<T>,
  milliseconds: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout?.();
          reject(new Error(message));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function testApplication(
  options: Readonly<{
    operations?: Readonly<{
      list(input: unknown): Promise<readonly OperationRecord[]>;
      maxEventPosition(input: unknown): Promise<string | undefined>;
      listStreams(input: unknown): Promise<readonly OperationStreamRecord[]>;
      onChange?(listener: (operationId: string) => void): Promise<() => void>;
    }>;
    attach(input: unknown): Promise<ApplicationOperationAttachment>;
    operationStatus(input: unknown): Promise<ApplicationOperationStatus | null>;
  }>,
): InternalCopilotzApplication {
  const application = {
    config: {
      namespace: "tenant",
      databaseSchema: "test",
      pluginIds: [],
      databaseOwnership: "injected" as const,
    },
    operations: options.operations
      ? {
        ...options.operations,
        async listSelectionChanges(input: unknown) {
          return (await options.operations!.list(input)).map((
            record,
            index,
          ) => ({
            ...record,
            selectionKey: coreThreadObservationKey("thread"),
            changeOrdinal: String(index + 1),
          }));
        },
        async getSelectionHeads() {
          const head = await options.operations!.maxEventPosition({});
          return head
            ? [{
              selectionKey: coreThreadObservationKey("thread"),
              changeOrdinal: head,
            }]
            : [];
        },
        onChange: options.operations.onChange ??
          (() => Promise.resolve(() => undefined)),
      }
      : {
        list() {
          return Promise.resolve([]);
        },
        maxEventPosition() {
          return Promise.resolve(undefined);
        },
        listStreams() {
          return Promise.resolve([]);
        },
        onChange() {
          return Promise.resolve(() => undefined);
        },
      },
    databaseScope: () => Promise.resolve(application),
    attach: options.attach,
    operationStatus: options.operationStatus,
  };
  return application as unknown as InternalCopilotzApplication;
}

async function createOperations(
  application: InternalCopilotzApplication,
  constraints: ServerConstraints = {},
  read: HttpReadServices = testRead(),
) {
  return await createHttpOperations(
    application,
    testScope(),
    constraints,
    read,
  );
}

function terminalStream(
  operationId: string,
  streamOrdinal: number,
  sourceActionRunId: string,
): OperationStreamRecord {
  const ordinal = String(streamOrdinal);
  const streamId = `stream-${operationId}-${ordinal}`;
  return {
    operationId,
    namespace: "tenant",
    streamId,
    semanticStreamId: streamId,
    replayKey: ordinal,
    streamOrdinal: ordinal,
    bodyId: `body-${ordinal}`,
    descriptor: {
      type: "stream.output",
      namespace: "tenant",
      streamId,
      mediaType: "text/plain",
      kind: "text",
      role: "content",
      metadata: { sourceActionRunId },
    },
    state: "terminal",
    outcome: "completed",
    availability: "retained",
    committedOffset: 1,
    terminalAt: "2026-09-16T00:00:00.000Z",
    createdAt: "2026-09-16T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
  };
}

function checkpointApplication(
  streamsByOperation: Readonly<
    Record<string, readonly OperationStreamRecord[]>
  >,
) {
  const records = Object.keys(streamsByOperation).map((operationId) =>
    operation(operationId, { operationMetadata: { threadId: "thread" } })
  );
  return testApplication({
    attach: () => Promise.resolve(closedAttachment("unused")),
    operationStatus: () => Promise.resolve(null),
    operations: {
      list() {
        return Promise.resolve(records);
      },
      maxEventPosition() {
        return Promise.resolve("1");
      },
      listStreams(input) {
        const { operationId } = input as { operationId: string };
        return Promise.resolve(streamsByOperation[operationId] ?? []);
      },
    },
  });
}

Deno.test("history checkpoint bounds sparse coverage and replays deferred lanes", async () => {
  const coveredOrdinals = new Set([
    245,
    247,
    248,
    249,
    250,
    252,
    255,
    257,
    259,
    261,
    263,
    264,
    266,
    267,
    270,
    271,
    273,
    275,
    277,
    278,
    280,
    281,
    282,
    284,
    285,
  ]);
  const operationId = "synthetic-history-operation";
  const streams = Array.from({ length: 285 }, (_, index) => {
    const ordinal = index + 1;
    return terminalStream(
      operationId,
      ordinal,
      coveredOrdinals.has(ordinal) ? "covered-run" : "uncovered-run",
    );
  });
  const operations = await createOperations(
    checkpointApplication({ [operationId]: streams }),
  );
  const checkpoint = await operations.checkpoint("thread", {
    checkpoint: encodeOperationReplayCursor({ eventPosition: "1" }),
    actionRunIds: ["covered-run"],
  });
  const initialTracker = createOperationReplayCursorTracker(
    decodeOperationReplayCursor(checkpoint),
  );
  const initialPosition = decodeOperationReplayCursor(checkpoint)
    .operationStreamPositions?.[operationId];

  assertEquals(initialPosition?.highWatermark, 273);
  assertEquals(Object.keys(initialPosition?.offsets ?? {}).length, 256);
  const consumedAtCheckpoint = new Set<number>();
  let unsafeSkips = 0;
  for (const stream of streams) {
    const consumed = initialTracker.streamPosition({
      operationId,
      streamOrdinal: stream.streamOrdinal,
    }).consumed;
    const ordinal = Number(stream.streamOrdinal);
    if (consumed) {
      consumedAtCheckpoint.add(ordinal);
      if (!coveredOrdinals.has(ordinal)) unsafeSkips++;
    }
  }
  assertEquals(unsafeSkips, 0);
  assertEquals(consumedAtCheckpoint.size, 17);

  // Simulate normal multipart replay, settling every lane left uncovered by
  // the history page. Each pair mirrors stream registration and its terminal.
  const replayTracker = createOperationReplayCursorTracker(
    decodeOperationReplayCursor(checkpoint),
  );
  let replayed = 0;
  for (const stream of streams) {
    if (
      replayTracker.streamPosition({
        operationId,
        streamOrdinal: stream.streamOrdinal,
      }).consumed
    ) continue;
    replayed++;
    const mutations = [
      {
        kind: "operation-stream" as const,
        action: "register" as const,
        operationId,
        streamOrdinal: stream.streamOrdinal,
        offset: 0,
      },
      {
        kind: "operation-stream" as const,
        action: "end" as const,
        operationId,
        streamOrdinal: stream.streamOrdinal,
        offset: stream.committedOffset,
      },
    ];
    replayTracker.cursor(mutations);
    replayTracker.commit(mutations);
  }
  assertEquals(replayed, 268);
  assertEquals(
    replayTracker.streamPosition({
      operationId,
      streamOrdinal: "285",
    }).consumed,
    true,
  );
  assertEquals(
    decodeOperationReplayCursor(replayTracker.cursor())
      .operationStreamPositions?.[operationId],
    { highWatermark: 285, offsets: {} },
  );
});

Deno.test("history checkpoint enforces sparse capacity across operations", async () => {
  const firstId = "synthetic-operation-a";
  const secondId = "synthetic-operation-b";
  const operations = await createOperations(checkpointApplication({
    [firstId]: [terminalStream(firstId, 130, "covered-run")],
    [secondId]: [terminalStream(secondId, 129, "covered-run")],
  }));
  const checkpoint = await operations.checkpoint("thread", {
    checkpoint: encodeOperationReplayCursor({ eventPosition: "1" }),
    actionRunIds: ["covered-run"],
  });
  const position = decodeOperationReplayCursor(checkpoint)
    .operationStreamPositions;

  assertEquals(position?.[firstId].highWatermark, 130);
  assertEquals(Object.keys(position?.[firstId].offsets ?? {}).length, 129);
  assertEquals(position?.[secondId], undefined);
  const tracker = createOperationReplayCursorTracker(
    position ? { operationStreamPositions: position } : {},
  );
  assertEquals(
    tracker.streamPosition({
      operationId: secondId,
      streamOrdinal: "129",
    }).consumed,
    false,
  );
});

Deno.test("history checkpoint validates encoded cursor byte capacity before adoption", async () => {
  const streamsByOperation: Record<string, readonly OperationStreamRecord[]> =
    {};
  const operationIds = Array.from(
    { length: 32 },
    (_, index) => `${String(index).padStart(2, "0")}${"x".repeat(510)}`,
  );
  for (const operationId of operationIds) {
    streamsByOperation[operationId] = [
      terminalStream(operationId, 2, "covered-run"),
    ];
  }
  const operations = await createOperations(
    checkpointApplication(streamsByOperation),
  );
  const checkpoint = await operations.checkpoint("thread", {
    checkpoint: encodeOperationReplayCursor({ eventPosition: "1" }),
    actionRunIds: ["covered-run"],
  });
  const position = decodeOperationReplayCursor(checkpoint);
  const lanes = position.operationStreamPositions ?? {};
  const rejectedOperationId = operationIds.at(-1)!;

  assertEquals(Object.keys(lanes).length < operationIds.length, true);
  assertEquals(rejectedOperationId in lanes, false);
  // The returned last valid cursor remains encodable within the byte limit.
  assertEquals(typeof encodeOperationReplayCursor(position), "string");
  assertEquals(
    Object.keys(lanes).reduce(
      (total, id) => total + Object.keys(lanes[id].offsets).length,
      0,
    ),
    Object.keys(lanes).length,
  );
  const tracker = createOperationReplayCursorTracker(position);
  let capacityErrorMessage: string | undefined;
  try {
    tracker.cursor([{
      kind: "operation-stream",
      action: "end",
      operationId: rejectedOperationId,
      streamOrdinal: "2",
      offset: 1,
    }]);
  } catch (error) {
    capacityErrorMessage = (error as Error).message;
  }
  assertEquals(capacityErrorMessage, "Operation replay cursor is too large.");
});

Deno.test("history checkpoint propagates unrelated stream catalog errors", async () => {
  const operationId = "synthetic-error-operation";
  const storageError = Object.assign(new Error("catalog read failed"), {
    code: "storage_failure",
  });
  const application = testApplication({
    attach: () => Promise.resolve(closedAttachment("unused")),
    operationStatus: () => Promise.resolve(null),
    operations: {
      list() {
        return Promise.resolve([operation(operationId, {
          operationMetadata: { threadId: "thread" },
        })]);
      },
      maxEventPosition() {
        return Promise.resolve("1");
      },
      listStreams() {
        return Promise.reject(storageError);
      },
    },
  });
  const operations = await createOperations(application);
  const caught = await assertRejects(
    () =>
      operations.checkpoint("thread", {
        checkpoint: encodeOperationReplayCursor({ eventPosition: "1" }),
        actionRunIds: ["covered-run"],
      }),
    Error,
  );

  assertEquals((caught as { code?: string }).code, "storage_failure");
});

const threadDefinition = defineCollection({
  name: "thread",
  schema: {
    type: "object",
    properties: { id: { type: "string" }, owner: { type: "string" } },
    required: ["owner"],
  },
});

async function observationFixture(options: { suppressHints?: boolean } = {}) {
  const db = await createTestDatabase({ url: ":memory:" });
  const schema = `http_observe_${crypto.randomUUID().replaceAll("-", "")}`;
  await provisionCopilotzSchema(db, schema);
  await provisionOperationCatalog(db, schema);
  const rawCatalog = createOperationCatalog(db, schema);
  const bodies = createMemoryBodyStore();
  const counts = {
    heads: [] as readonly string[][],
    changes: 0,
    streams: 0,
    status: 0,
    subscriptions: 0,
    removed: 0,
    watches: 0,
    closed: 0,
    resources: [] as readonly string[][],
  };
  let delaySubscription: Promise<void> | undefined;
  let delayOperationWatch: Promise<void> | undefined;
  let failureSelection: Error | undefined;
  const operations: OperationCatalog = {
    ...rawCatalog,
    async onChange(listener, input) {
      counts.subscriptions++;
      await delaySubscription;
      const remove = options.suppressHints
        ? () => undefined
        : await rawCatalog.onChange(listener, input);
      return () => {
        counts.removed++;
        remove();
      };
    },
    async getSelectionHeads(input) {
      counts.heads = [...counts.heads, [...input.selectionKeys]];
      return await rawCatalog.getSelectionHeads(input);
    },
    async listSelectionChanges(input) {
      counts.changes++;
      if (failureSelection) throw failureSelection;
      return await rawCatalog.listSelectionChanges(input);
    },
    async listStreams(input) {
      counts.streams++;
      return await rawCatalog.listStreams(input);
    },
    async watch(id, input) {
      counts.watches++;
      await delayOperationWatch;
      const watch = await rawCatalog.watch(id, input);
      return {
        ...watch,
        close() {
          counts.closed++;
          watch.close();
        },
      };
    },
  };
  let id = 0;
  const events = createEventStore({
    session: db,
    schema,
    createId: () => `event-${++id}`,
    indexOperationEventSql: (input, param) =>
      operations.indexEventSql(input, param),
  });
  const registry = await createPluginRegistry();
  const executor = createDeliveryExecutor({
    store: events,
    registry,
    workerId: "http-observe-test",
    createContext: createTestProcessorContext,
  });
  const coordinator = createEventCoordinator({
    store: events,
    registry,
    executor,
  });
  const collections = createCollectionRuntime({
    coordinator,
    session: db,
    eventStore: events,
  });
  collections.bind(threadDefinition);
  const scoped = collections.withScope({ namespace: "tenant" });
  const application = {
    config: { namespace: "tenant", databaseSchema: schema },
    plugins: { collections: { thread: threadDefinition } },
    operations,
    events: {
      ...events,
      async resolve(namespace: string, id: string) {
        const event = await events.getEvent(id);
        return event?.namespace === namespace
          ? await resolveProcessorEvent(events, event)
          : null;
      },
    },
    streams: {
      readCommittedRange: (
        input: { bodyId: string; offset: number; end: number },
      ) => bodies.readRange(input),
    },
    collections: {
      withScope(input: { namespace: string }) {
        const values = collections.withScope(input);
        return {
          ...values,
          thread: {
            ...values.thread,
            async aggregate(
              query:
                import("../runtime/collections/types.ts").CollectionAggregateQuery,
            ) {
              const filter = query.filter as
                | { in?: readonly string[] }
                | undefined;
              counts.resources = [...counts.resources, [...filter?.in ?? []]];
              return await values.thread.aggregate(query);
            },
          },
        };
      },
    },
    async operationStatus(input: { namespace: string; operationId: string }) {
      counts.status++;
      const record = await operations.get(input.namespace, input.operationId);
      if (!record) return null;
      return { ...record, metadata: record.metadata.operationMetadata ?? {} };
    },
    databaseScope: () => Promise.resolve(application),
    attach: (input: ApplicationOperationAttachInput) => readers.attach(input),
  } as unknown as InternalCopilotzApplication;
  const readers = createSharedOperationReaders(application);
  const scope: ServerAuthorizedScope = {
    namespace: "tenant",
    databaseSchema: schema,
  };
  const create = async (constraints: ServerConstraints = {}) => {
    const read = await createHttpReads(application, scope, constraints);
    return await createHttpOperations(application, scope, constraints, read);
  };
  const selected: Awaited<ReturnType<typeof createHttpOperations>>[] = [];
  const observations: Awaited<
    ReturnType<Awaited<ReturnType<typeof createHttpOperations>>["observe"]>
  >[] = [];
  const start = async (
    input: Parameters<
      Awaited<ReturnType<typeof createHttpOperations>>["observe"]
    >[0],
    constraints: ServerConstraints = {},
  ) => {
    const api = await create(constraints);
    selected.push(api);
    const observation = await api.observe(input);
    observations.push(observation);
    const outputs: (ApplicationOutput & {
      operationId?: string;
      replayPosition?: string;
    })[] = [];
    const consumed = (async () => {
      for await (const output of observation.outputs) {
        outputs.push(
          output as ApplicationOutput & {
            operationId?: string;
            replayPosition?: string;
          },
        );
      }
    })();
    void consumed.catch(() => undefined);
    return { observation, outputs, consumed };
  };
  return {
    db,
    schema,
    counts,
    operations,
    rawCatalog,
    scoped,
    events,
    application,
    create,
    start,
    delayWatch(value: Promise<void>) {
      delayOperationWatch = value;
    },
    delaySubscription(value: Promise<void>) {
      delaySubscription = value;
    },
    failSelection(error: Error) {
      failureSelection = error;
    },
    async thread(threadId = "thread", owner = "owner") {
      return await scoped.thread.create({ id: threadId, owner });
    },
    async operation(
      threadId = "thread",
      state: "running" | "completed" = "running",
      metadata: Record<string, unknown> = {},
    ) {
      const root = await events.append({
        namespace: "tenant",
        type: "test.work",
        payload: {},
        metadata: {
          observationKeys: [coreThreadObservationKey(threadId)],
          operationMetadata: metadata,
        },
      });
      if (state === "completed") {
        await operations.reconcile({
          namespace: "tenant",
          operationId: root.event.id,
        });
      }
      return root.event.id;
    },
    async stream(operationId: string, bytes: Uint8Array) {
      const streamId = `stream-${operationId}`;
      const bodyId = `body-${operationId}`;
      const writer = await bodies.reserve({
        bodyId,
        mediaType: "application/octet-stream",
      });
      await bodies.append({
        writer,
        expectedOffset: 0,
        appendId: "initial",
        bytes,
      });
      await operations.openStream({
        namespace: "tenant",
        operationId,
        semanticStreamId: streamId,
        bodyId,
        descriptor: {
          type: "stream.output",
          namespace: "tenant",
          streamId,
          mediaType: "application/octet-stream",
          kind: "file",
          role: "content",
          metadata: {},
        },
      });
      await operations.commitStreamOffset({
        namespace: "tenant",
        operationId,
        streamId,
        committedOffset: bytes.length,
      });
      await operations.retainStream({
        namespace: "tenant",
        operationId,
        streamId,
        retention: "observation",
      });
      const body = await bodies.seal({
        writer,
        expectedByteLength: bytes.length,
      });
      await operations.sealStream({
        namespace: "tenant",
        operationId,
        streamId,
        body,
      });
      await operations.reconcile({ namespace: "tenant", operationId });
      return streamId;
    },
    async close() {
      for (const observation of observations) {
        await observation.cancel(
          "test_finished",
        );
      }
      await Promise.allSettled(
        observations.map((observation) => observation.done),
      );
      await readers.close();
      await executor.shutdown();
      await db.close();
    },
  };
}

async function until(check: () => boolean, milliseconds = 3000) {
  const deadline = performance.now() + milliseconds;
  while (!check()) {
    if (performance.now() >= deadline) {
      throw new Error("Timed out waiting for observation state.");
    }
    await pause(5);
  }
}

async function waitOutput(
  observation: { done: Promise<void> },
  check: () => boolean,
  ms = 3000,
) {
  await Promise.race([
    until(check, ms),
    observation.done.then(() => {
      throw new Error("Observation ended before expected output.");
    }),
  ]);
}

Deno.test("initial thread boundary skips completed history and follows earlier active operations", async () => {
  const f = await observationFixture();
  try {
    await f.thread();
    const history = await f.operation("thread", "completed");
    const active = await f.operation();
    const { observation, outputs } = await f.start({ threadId: "thread" });
    await until(() => outputs.some((output) => output.operationId === active));
    assertEquals(
      decodeOperationReplayCursor(observation.replayCursor).selectionPosition,
      "2",
    );
    assertEquals(
      outputs.some((output) => output.operationId === history),
      false,
    );
    assertEquals(f.counts.watches, 1);
    await observation.cancel();
    await Promise.allSettled([observation.done]);
    assertEquals(f.counts.closed, 1);
    // Selection discovery and the operation hub each own one hint subscription.
    assertEquals(f.counts.removed, 2);
  } finally {
    await f.close();
  }
});

Deno.test("thread cursor authorization checks each indexed member and nested operation metadata", async () => {
  const f = await observationFixture();
  try {
    await f.thread();
    await f.thread("other");
    const permitted = await f.operation("thread", "completed", {
      access: { roles: ["owner", "editor"] },
    });
    const outside = await f.operation("other", "completed");
    const api = await f.create({
      operations: { metadata: { access: { roles: ["owner", "editor"] } } },
    });
    const cursor = (id: string) =>
      encodeOperationReplayCursor({
        selectionPosition: "0",
        operationSelectionPositions: { [id]: "1" },
      });
    const denied = await assertRejects(() =>
      api.observe({ threadId: "thread", checkpoint: cursor(outside) })
    );
    assertEquals((denied as { code: string }).code, "invalid_replay_cursor");
    const controller = new AbortController();
    const allowed = await api.observe({
      threadId: "thread",
      checkpoint: cursor(permitted),
      signal: controller.signal,
    });
    const reading = (async () => {
      for await (const _output of allowed.outputs) { /* drain */ }
    })();
    void reading.catch(() => undefined);
    controller.abort();
    await Promise.allSettled([allowed.done]);
    const wrongMetadata = await f.operation("thread", "running", {
      access: { roles: ["viewer"] },
    });
    const rejected = await assertRejects(() =>
      api.observe({ threadId: "thread" })
    );
    assertEquals((rejected as { code: string }).code, "operation_not_found");
    assert(wrongMetadata);
  } finally {
    await f.close();
  }
});

Deno.test("retirement cursor tombstones cannot authorize unrelated operations", async () => {
  const f = await observationFixture();
  try {
    await f.thread();
    await f.thread("other");
    const outside = await f.operation("other", "completed");
    const api = await f.create();
    const error = await assertRejects(() =>
      api.observe({
        threadId: "thread",
        checkpoint: encodeOperationReplayCursor({
          selectionPosition: "0",
          operationRetirementPositions: { [outside]: "1" },
        }),
      })
    );
    assertEquals((error as { code: string }).code, "invalid_replay_cursor");
  } finally {
    await f.close();
  }
});

Deno.test("thread changes use indexed hints and idle followers avoid rediscovery", async () => {
  const f = await observationFixture();
  try {
    await f.thread();
    const { observation, outputs } = await f.start({ threadId: "thread" });
    await until(() => outputs.length > 0);
    await pause(80);
    const before = f.counts.changes;
    await pause(700);
    assertEquals(f.counts.changes, before);
    const id = await f.operation("thread", "completed");
    await waitOutput(
      observation,
      () =>
        outputs.some((output) =>
          output.type === "operation.completed" && output.operationId === id
        ),
    );
    const requests = f.counts.changes;
    await pause(350);
    assertEquals(f.counts.changes, requests);
    await observation.cancel();
    await observation.done;
    assertEquals(f.counts.subscriptions, 2);
    assertEquals(f.counts.removed, 2);
  } finally {
    await f.close();
  }
});

Deno.test("120 completed operations paginate discovery and retire replay state without capacity overflow", async () => {
  const f = await observationFixture();
  try {
    await f.thread();
    const ids: string[] = [];
    for (let index = 0; index < 120; index++) {
      ids.push(await f.operation("thread", "completed"));
    }
    const { observation, outputs } = await f.start({
      threadId: "thread",
      checkpoint: encodeOperationReplayCursor({ selectionPosition: "0" }),
    });
    await waitOutput(
      observation,
      () =>
        outputs.filter((output) => output.type === "operation.completed")
          .length === 120,
      6000,
    );
    const completed = outputs.filter((output) =>
      output.type === "operation.completed"
    ).map((output) => output.operationId);
    assertEquals(new Set(completed), new Set(ids));
    const tracker = createOperationReplayCursorTracker({
      selectionPosition: "0",
    });
    let maxMembers = 0;
    for (const output of outputs) {
      if (output.type === "observation.selection") {
        const frame = output as unknown as {
          selectionPosition: string;
          operationIds: readonly string[];
        };
        tracker.commit([{
          kind: "selection",
          position: frame.selectionPosition,
          operationIds: frame.operationIds,
        }]);
      } else if (output.type === "operation.completed") {
        tracker.commit([{
          kind: "retire",
          operationId: output.operationId!,
          position: String(
            (output as unknown as { finalSelectionPosition?: string })
              .finalSelectionPosition ?? "0",
          ),
        }]);
      } else if (output.replayPosition) {
        tracker.commit([{
          kind: "event",
          operationId: output.operationId,
          position: output.replayPosition,
        }]);
      }
      maxMembers = Math.max(
        maxMembers,
        Object.keys(
          decodeOperationReplayCursor(tracker.cursor())
            .operationSelectionPositions ?? {},
        ).length,
      );
    }
    assert(maxMembers <= 32);
    assertEquals(
      Object.keys(
        decodeOperationReplayCursor(tracker.cursor())
          .operationSelectionPositions ?? {},
      ).length,
      0,
    );
    await observation.cancel();
    await observation.done;
    assertEquals(f.counts.closed, 120);
  } finally {
    await f.close();
  }
});

Deno.test("missed selection hints recover through the five-second safety head batch", async () => {
  const f = await observationFixture({ suppressHints: true });
  try {
    await f.thread();
    const { observation, outputs } = await f.start({ threadId: "thread" });
    await until(() => outputs.length > 0);
    await pause(100);
    const id = await f.operation("thread", "completed");
    const began = performance.now();
    await until(
      () =>
        outputs.some((output) =>
          output.type === "operation.completed" && output.operationId === id
        ),
      6000,
    );
    assert(performance.now() - began < 5750);
    assert(f.counts.heads.some((batch) => batch.length === 1));
    await observation.cancel();
    await observation.done;
  } finally {
    await f.close();
  }
});

Deno.test("thread access revocation closes observation using the scoped collection predicate", async () => {
  const f = await observationFixture();
  try {
    await f.thread("thread", "owner");
    const { consumed } = await f.start({ threadId: "thread" }, {
      collections: { thread: { where: { owner: "owner" } } },
    });
    await f.scoped.thread.update({ id: "thread", set: { owner: "other" } });
    await withDeadline(
      assertRejects(() => consumed),
      1500,
      "Revoked observation did not close.",
    );
    assertEquals(f.counts.removed, 1);
    assert(f.counts.resources.length >= 1);
  } finally {
    await f.close();
  }
});

Deno.test("initial discovery failure releases selection and resource subscriptions", async () => {
  const f = await observationFixture();
  try {
    await f.thread();
    f.failSelection(new Error("discovery failed"));
    const api = await f.create();
    await assertRejects(
      () => api.observe({ threadId: "thread" }),
      Error,
      "discovery failed",
    );
    assertEquals(f.counts.removed, 1);
    const queries = f.counts.resources.length;
    await pause(300);
    assertEquals(f.counts.resources.length, queries);
  } finally {
    await f.close();
  }
});

Deno.test("late acquired selection subscriptions are released after initial observation abort", async () => {
  const f = await observationFixture();
  try {
    await f.thread();
    const subscription = deferred<void>();
    f.delaySubscription(subscription.promise);
    const api = await f.create();
    const controller = new AbortController();
    const starting = api.observe({
      threadId: "thread",
      signal: controller.signal,
    });
    await until(() => f.counts.subscriptions === 1);
    controller.abort("client_closed");
    subscription.resolve();
    await assertRejects(() => starting);
    assertEquals(f.counts.removed, 1);
    const reads = f.counts.resources.length;
    await pause(300);
    assertEquals(f.counts.resources.length, reads);
  } finally {
    await f.close();
  }
});

Deno.test("late shared operation readers are released when an explicit observation aborts", async () => {
  const f = await observationFixture();
  try {
    const id = await f.operation();
    const gate = deferred<void>();
    f.delayWatch(gate.promise);
    const controller = new AbortController();
    const { observation } = await f.start({
      operationIds: [id],
      signal: controller.signal,
    });
    await until(() => f.counts.watches === 1);
    controller.abort("client_closed");
    gate.resolve();
    await withDeadline(
      observation.done,
      1500,
      "Late shared reader did not detach.",
    );
    await until(() => f.counts.closed === 1);
    assertEquals(f.counts.watches, 1);
    assertEquals(f.counts.closed, 1);
  } finally {
    await f.close();
  }
});

Deno.test("1000 distinct idle observations share batched selection heads and scoped existence reads", async () => {
  const f = await observationFixture();
  try {
    const ids = Array.from({ length: 1000 }, (_, index) => `thread-${index}`);
    for (const id of ids) await f.thread(id);
    const views = await Promise.all(
      ids.map((threadId) => f.start({ threadId })),
    );
    await until(() => views.every((view) => view.outputs.length > 0), 10000);
    await pause(100);
    f.counts.heads = [];
    f.counts.resources = [];
    f.counts.changes = 0;
    await pause(5250);
    assertEquals(f.counts.subscriptions, 1);
    assertEquals(
      f.counts.changes,
      0,
      "idle selections must not re-read operation associations",
    );
    assert(f.counts.heads.length >= 1 && f.counts.heads.length <= 2);
    assert(f.counts.heads.every((batch) => batch.length === 1000));
    assert(f.counts.resources.length >= 18 && f.counts.resources.length <= 24);
    assert(f.counts.resources.every((batch) => batch.length === 1000));
    await Promise.all(views.map((view) => view.observation.cancel()));
    await Promise.all(views.map((view) => view.observation.done));
    assertEquals(f.counts.removed, 1);
    const queries = f.counts.resources.length;
    const heads = f.counts.heads.length;
    await pause(350);
    assertEquals(f.counts.resources.length, queries);
    assertEquals(f.counts.heads.length, heads);
  } finally {
    await f.close();
  }
});

Deno.test("last detach racing a new selection subscription retains a live notification hub", async () => {
  const f = await observationFixture();
  let second: Awaited<ReturnType<typeof watchSelection>> | undefined;
  try {
    const first = await watchSelection(
      f.operations,
      "tenant",
      coreThreadObservationKey("thread"),
      () => undefined,
    );
    const acquiring = watchSelection(
      f.operations,
      "tenant",
      coreThreadObservationKey("thread"),
      () => undefined,
    );
    first.close();
    second = await acquiring;
    assertEquals(
      f.counts.subscriptions,
      2,
      "new follower must reacquire a hub closed while it awaited acquisition",
    );
    assertEquals(f.counts.removed, 1);
    second.close();
    assertEquals(f.counts.removed, 2);
  } finally {
    second?.close();
    await f.close();
  }
});

Deno.test("fixed operation selection rejects event and retirement cursors outside the authorized ids", async () => {
  const f = await observationFixture();
  try {
    const permitted = await f.operation("thread", "completed", {
      owner: "owner",
    });
    const outside = await f.operation("other", "completed", { owner: "owner" });
    const api = await f.create({
      operations: { metadata: { owner: "owner" } },
    });
    for (
      const checkpoint of [
        encodeOperationReplayCursor({
          operationEventPositions: { [outside]: "1" },
        }),
        encodeOperationReplayCursor({
          selectionPosition: "0",
          operationRetirementPositions: { [outside]: "1" },
        }),
      ]
    ) {
      const rejected = await assertRejects(() =>
        api.observe({ operationIds: [permitted], checkpoint })
      );
      assertEquals(
        (rejected as { code: string }).code,
        "invalid_replay_cursor",
      );
    }
    const denied = await f.operation("thread", "completed", { owner: "other" });
    const rejected = await assertRejects(() =>
      api.observe({ operationIds: [denied] })
    );
    assertEquals((rejected as { code: string }).code, "operation_not_found");
    assertEquals(f.counts.watches, 0);
  } finally {
    await f.close();
  }
});

Deno.test("thread discovery authorizes nested metadata without per-operation status probes", async () => {
  const f = await observationFixture();
  try {
    await f.thread();
    for (let index = 0; index < 16; index++) {
      await f.operation("thread", "running", {
        access: { roles: ["owner", "editor"] },
      });
    }
    const api = await f.create({
      operations: { metadata: { access: { roles: ["owner", "editor"] } } },
    });
    const observation = await api.observe({ threadId: "thread" });
    assertEquals(
      f.counts.status,
      0,
      "indexed operation records must carry their authorization metadata",
    );
    assertEquals(
      f.counts.watches,
      0,
      "reader attachment follows the first consumed selection frame",
    );
    await observation.cancel();
    await Promise.allSettled([observation.done]);
    assertEquals(f.counts.removed, 1);
  } finally {
    await f.close();
  }
});

Deno.test("operation terminal forwarding preserves queued payloads until drain or observation cancellation", async () => {
  for (const action of ["drain", "cancel"] as const) {
    const f = await observationFixture();
    let observation:
      | Awaited<ReturnType<Awaited<ReturnType<typeof f.create>>["observe"]>>
      | undefined;
    const release = deferred<void>();
    try {
      await f.thread();
      const operationId = await f.operation();
      const bytes = new Uint8Array(768 * 1024).fill(7);
      await f.stream(operationId, bytes);
      const attached = deferred<ApplicationOperationAttachment>();
      const original = f.application.attach;
      Object.assign(f.application, {
        async attach(input: ApplicationOperationAttachInput) {
          const attachment = await original(input);
          attached.resolve(attachment);
          return attachment;
        },
      });
      const api = await f.create();
      observation = await api.observe({
        threadId: "thread",
        checkpoint: encodeOperationReplayCursor({ selectionPosition: "0" }),
      });
      const response = applicationOutputsMultipartResponse(observation);
      const blocked = deferred<void>();
      let total = 0;
      let terminal = false;
      const consuming = (async () => {
        for await (const frame of decodeObservation(response)) {
          if (
            frame.kind === "output" && frame.output.type === "stream.output"
          ) {
            blocked.resolve();
            await release.promise;
          }
          if (frame.kind === "stream-chunk") {
            assertEquals(frame.bytes.every((value) => value === 7), true);
            total += frame.bytes.length;
          }
          if (
            frame.kind === "output" &&
            frame.output.type === "operation.completed"
          ) {
            terminal = true;
            break;
          }
        }
      })();
      void consuming.catch(() => undefined);
      await withDeadline(
        blocked.promise,
        1500,
        "Stream descriptor was not delivered.",
      );
      const attachment = await attached.promise;
      await withDeadline(
        attachment.done,
        1500,
        "Operation outputs did not finish.",
      );
      let drained = false;
      void attachment.drained.then(() => drained = true);
      await pause(25);
      assertEquals(drained, false);
      assertEquals(f.counts.closed, 0);
      if (action === "cancel") {
        await observation.cancel("client_closed");
        await attachment.drained;
        assertEquals(drained, true);
        release.resolve();
        await assertRejects(() => consuming);
      } else {
        release.resolve();
        await withDeadline(
          consuming,
          2000,
          "Queued terminal bytes did not drain.",
        );
        assertEquals(total, bytes.length);
        assertEquals(terminal, true);
        await attachment.drained;
      }
      assertEquals(f.counts.closed, 1);
    } finally {
      release.resolve();
      await observation?.cancel("test_finished");
      await f.close();
    }
  }
});

for (
  const { sequence, byteLength = 0 } of [
    { sequence: ["large-1", "large-2", "large-3", "small-last"] },
    {
      sequence: ["small-first", "large-1", "large-2", "large-3", "small-last"],
    },
    {
      sequence: ["small-first", "large-1", "large-2", "large-3", "small-last"],
      byteLength: 3 * 1024 * 1024,
    },
  ]
) {
  Deno.test(`retained logical events advance each renewal checkpoint${byteLength ? " with a partial binary lane" : ""}: ${sequence.join(",")}`, async () => {
    const f = await observationFixture();
    const observations: Awaited<
      ReturnType<Awaited<ReturnType<typeof f.create>>["observe"]>
    >[] = [];
    const abort = new AbortController();
    try {
      const operationId = await f.operation();
      const value = "x".repeat(1024 * 1024 + 4096);
      for (const id of sequence) {
        await f.events.append({
          type: "test.logical",
          namespace: "tenant",
          settlementScopeId: operationId,
          causationId: operationId,
          correlationId: operationId,
          payload: { id, value: id.startsWith("large") ? value : "small" },
        });
      }
      if (byteLength) {
        await f.stream(operationId, new Uint8Array(byteLength).fill(7));
      }
      await f.operations.reconcile({ namespace: "tenant", operationId });
      const api = await f.create();
      const checkpoints: (string | undefined)[] = [];
      const received: string[] = [];
      let binaryTotal = 0;
      const client = createCopilotzClient({
        baseUrl: "/api",
        fetch: (async (_url, init) => {
          const checkpoint = JSON.parse(String(init?.body)).checkpoint;
          checkpoints.push(checkpoint);
          if (checkpoints.length > sequence.length + 8) {
            throw new ProtocolError(
              "Retained replay renewed without progress.",
            );
          }
          const observation = await api.observe({
            operationIds: [operationId],
            checkpoint,
            signal: abort.signal,
          });
          observations.push(observation);
          return applicationOutputsMultipartResponse(observation, {
            signal: abort.signal,
          });
        }) as typeof fetch,
      });
      await withDeadline(
        client.operations.observe({
          operationIds: [operationId],
          signal: abort.signal,
          async onFrame(frame) {
            if (frame.kind === "stream-chunk") {
              assert(frame.bytes.every((value) => value === 7));
              binaryTotal += frame.bytes.length;
            }
            if (
              frame.kind === "output" && frame.output.type === "test.logical"
            ) {
              const data = frame.output.data as { id: string; value: string };
              received.push(data.id);
              assertEquals(
                data.value,
                data.id.startsWith("large") ? value : "small",
              );
              await pause(20);
            }
          },
        }),
        5000,
        "Retained logical replay did not finish.",
        () => abort.abort(),
      );
      assertEquals(received, sequence);
      assertEquals(binaryTotal, byteLength);
      let previous = 0n;
      let previousBytes = 0;
      for (const checkpoint of checkpoints.slice(1)) {
        const cursor = decodeOperationReplayCursor(checkpoint);
        const position = BigInt(
          cursor.operationEventPositions?.[operationId] ?? "0",
        );
        const stream = cursor.operationStreamPositions?.[operationId];
        const bytes = stream?.highWatermark
          ? byteLength
          : stream?.offsets["1"] ?? 0;
        assert(
          position > previous || bytes > previousBytes,
          "Every renewal must acknowledge a larger retained prefix.",
        );
        previous = position;
        previousBytes = bytes;
      }
      assertEquals(f.counts.closed, f.counts.watches);
    } finally {
      abort.abort();
      await Promise.allSettled(
        observations.map((observation) => observation.cancel()),
      );
      await f.close();
    }
  });
}
