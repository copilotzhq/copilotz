import assert from "node:assert/strict";
import process from "node:process";
import { test } from "node:test";
import { encodeEventBody } from "../events/body-store.ts";
import {
  createCoreSchemaStatements,
  quoteEventIdentifier,
} from "../events/schema.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { ownerProcessorOperationKey } from "../execution/registered-processor.ts";
import { defineProcessor } from "../plugins/processor.ts";
import { createPluginRegistry } from "../plugins/registry.ts";
import { definePlugin } from "../plugins/types.ts";
import {
  createOperationCatalog,
  provisionOperationCatalog,
} from "../streams/catalog.ts";
import { createTestDatabase } from "../testing/ominipg.ts";
import { localPostgresUrl } from "../testing/owner-postgres-fixture.ts";
import {
  createOwnerAssignmentControl,
  type OwnerLocalProcessorAssignmentBinding,
  provisionOwnerAssignments,
} from "./assignments.ts";
import {
  createOwnerCommandBoundary,
  type OwnerCaller,
  type OwnerCommand,
  type OwnerCommandOutcome,
  type OwnerJson,
} from "./boundary.ts";
import {
  createOwnerProcessorCommands,
  type OwnerLocalProcessorAttemptReceipt,
  ownerLocalProcessorCompletionKey,
  type OwnerLocalProcessorOptions,
  type OwnerLocalProcessorProjection,
  type OwnerLocalProcessorStartFacts,
  ownerLocalProcessorStartKey,
} from "./processor.ts";
import { provisionOwnerCommandSchema } from "./schema.ts";

const start = "2020-01-01T00:00:00.000Z";
const lost = { code: "ActionOwnershipLost" };
const retryable: OwnerJson = {
  status: "failed",
  code: "processor_failed",
  retryable: true,
};
const postgres = process.env.COPILOTZ_TEST_POSTGRES_URL?.trim();
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => resolve = done);
  return { promise, resolve };
}
function sameBinding(
  left: OwnerLocalProcessorAssignmentBinding,
  right: OwnerLocalProcessorAssignmentBinding,
) {
  return Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(([key, value]) =>
      right[key as keyof OwnerLocalProcessorAssignmentBinding] === value
    );
}
type Entry = {
  binding: OwnerLocalProcessorAssignmentBinding;
  ordinal: number;
  witness: string;
  knownStart: boolean;
  knownEnd?: OwnerLocalProcessorAttemptReceipt;
  revoked: boolean;
  drained: boolean;
  quarantined: boolean;
  raw: Set<Promise<void>>;
  previous?: Entry;
};

/** This is a private host-ledger fixture, not a local execution driver. Only the
 * known-result observer activates an entry, and only an observed ended receipt
 * plus actual raw-promise drain releases its capacity. Transaction hooks below
 * touch SQL exclusively; they cannot activate or release that private entry. */
async function fixture(options: {
  localDisabled?: boolean;
  detached?: boolean;
  data?: OwnerJson;
  sourceMetadata?: Readonly<Record<string, OwnerJson>>;
  maxAttempts?: number;
  postgres?: string;
} = {}) {
  const db = await createTestDatabase(
    options.postgres
      ? { url: localPostgresUrl(options.postgres), pgPoolMax: 1 }
      : { pgliteMemoryProfile: "low-memory" },
  );
  const schema = `processor_local_${crypto.randomUUID().replaceAll("-", "")}`;
  const q = quoteEventIdentifier(schema);
  for (const sql of createCoreSchemaStatements(schema)) await db.query(sql);
  await provisionOperationCatalog(db, schema);
  await provisionOwnerCommandSchema(db, schema);
  await provisionOwnerAssignments(db, schema);
  const state = {
    time: start,
    control: true,
    current: true,
    ctx: true,
    settlement: true,
    event: true,
    rollback: false,
    failRetirement: false,
    unknown: "" as "" | "committed" | "aborted",
    entry: undefined as Entry | undefined,
    capacityWitness: "",
    reservations: 0,
    retirements: 0,
    executions: 0,
    workerResolutions: 0,
    workerPolicies: 0,
    startChecks: [] as OwnerLocalProcessorStartFacts[],
    refusals: [] as string[],
    schedules: [] as string[],
    retryWakes: [] as string[],
    eventPrincipals: [] as string[],
    ordinalOverride: undefined as number | undefined,
    startResult: undefined as undefined | (() => unknown),
    witnessResult: undefined as undefined | (() => unknown),
    witnessChecks: [] as string[],
    startPolicy: undefined as
      | undefined
      | ((
        tx: SqlExecutor,
        facts: OwnerLocalProcessorStartFacts,
      ) => Promise<void>),
    eventPolicy: undefined as undefined | ((tx: SqlExecutor) => Promise<void>),
    afterRead: undefined as undefined | ((sql: string) => void | Promise<void>),
    beforeCommit: undefined as undefined | (() => Promise<void>),
    schedulePolicy: undefined as
      | undefined
      | ((
        kind: "settlement" | "retry",
      ) => Promise<void>),
  };
  const controlWitness = crypto.randomUUID();
  const controlCaller = (): OwnerCaller => ({
    principal: {
      kind: "owner-control",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
    },
    ownerEpoch: 1,
    privateControl: controlWitness,
  });
  const caller = (entry = state.entry!): OwnerCaller => ({
    principal: {
      kind: "owner-local",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
      deliveryId: entry.binding.deliveryId,
      attemptId: entry.binding.attemptId,
    },
    ownerEpoch: 1,
    privateAttempt: entry.witness,
  });
  const privateCurrent = (who: OwnerCaller): Entry | undefined => {
    const entry = state.entry;
    return state.current && entry && entry.knownStart && !entry.revoked &&
        !entry.quarantined && who.privateAttempt === entry.witness &&
        state.capacityWitness === entry.witness
      ? entry
      : undefined;
  };
  const assignments = createOwnerAssignmentControl({
    ownerId: "owner",
    schema,
    maxActive: 1,
    authorizeControl(_tx, who) {
      if (!state.control || who.privateControl !== controlWitness) {
        throw new Error("private control revoked");
      }
    },
    isCurrentStarted: () => false,
    resolveCurrentLocal: (who) => privateCurrent(who)?.binding,
    hasProcessor: (id) => id === "fixture.observe",
  });
  const session: SqlSession = {
    query: db.query,
    async transaction(run) {
      const unknown = state.unknown;
      state.unknown = "";
      const result = await db.transaction(async (tx) => {
        const result = await run({
          async query<Row extends Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ) {
            if (state.rollback && sql === "RELEASE SAVEPOINT owner_command_0") {
              state.rollback = false;
              throw new Error("injected command rollback");
            }
            const result = await tx.query<Row>(sql, params);
            await state.afterRead?.(sql);
            return result;
          },
        });
        await state.beforeCommit?.();
        if (unknown === "aborted") {
          throw Object.assign(new Error("unknown aborted commit"), {
            code: "persistence_indeterminate",
          });
        }
        return result;
      });
      if (unknown === "committed") {
        throw Object.assign(new Error("unknown committed reply"), {
          code: "persistence_indeterminate",
        });
      }
      return result;
    },
  };
  const processor = defineProcessor({
    id: "fixture.observe",
    on: [{ eventType: "fixture.source" }],
    handle() {
      state.executions++;
      throw new Error("Durable commands must never invoke authored code");
    },
  });
  const registry = createPluginRegistry({
    plugins: [definePlugin({
      id: "fixture",
      version: "1",
      processors: { observe: processor },
    })],
  });
  const catalog = createOperationCatalog(db, schema);
  const commands = createOwnerProcessorCommands({
    ownerId: "owner",
    schema,
    session,
    registry,
    catalog,
    resolveAssignment() {
      state.workerResolutions++;
      return undefined;
    },
    authorizeEvent() {
      state.workerPolicies++;
      throw new Error("A local command reached worker policy");
    },
    ...(options.localDisabled ? {} : {
      local: {
        isCurrent(who, binding, attemptOrdinal, phase) {
          state.witnessChecks.push(phase);
          if (state.witnessResult) return state.witnessResult() as boolean;
          const entry = state.entry;
          if (
            !entry || !state.current || entry.revoked || entry.quarantined ||
            !sameBinding(binding, entry.binding) ||
            attemptOrdinal !== entry.ordinal ||
            state.capacityWitness !== entry.witness
          ) return false;
          if (phase === "start") {
            return state.control && state.ctx && !entry.knownStart &&
              who.principal.kind === "owner-control" &&
              who.privateControl === controlWitness;
          }
          return privateCurrent(who) === entry &&
            (phase === "ctx" ? state.ctx : state.settlement);
        },
        async resolveAssignment(tx, who) {
          const entry = privateCurrent(who);
          if (!entry) return undefined;
          const resolved = await assignments.resolveLocal(tx, who);
          if (!resolved || resolved.kind !== "processor") return undefined;
          return {
            ...resolved,
            ctxGranted: state.ctx,
            settlementGranted: state.settlement,
            attemptOrdinal: state.ordinalOverride ?? entry.ordinal,
          };
        },
        async authorizeStart(tx, who, binding, facts) {
          state.startChecks.push(structuredClone(facts));
          const deny = (reason: string) => {
            state.refusals.push(reason);
            return undefined;
          };
          const entry = state.entry;
          if (
            !entry || !state.control || !state.current ||
            who.principal.kind !== "owner-control" ||
            who.privateControl !== controlWitness ||
            !sameBinding(binding, entry.binding) || entry.revoked ||
            entry.quarantined || entry.knownStart
          ) return deny("private control");
          if (entry.previous) {
            const previous = entry.previous;
            const receipt = previous.knownEnd;
            if (!receipt || receipt.status !== "retry_wait") {
              return deny("known predecessor receipt");
            }
            if (
              !previous.revoked || !previous.drained || previous.quarantined ||
              previous.raw.size
            ) return deny("revoked and drained predecessor");
            if (
              facts.status !== "retry_wait" ||
              facts.attempts !== receipt.attempts ||
              facts.availableAt !== receipt.availableAt ||
              entry.ordinal !== receipt.attempts + 1
            ) return deny("exact predecessor facts");
            const retired = await tx.query<{ retired: boolean }>(
              `SELECT retired FROM ${q}.owner_assignments WHERE binding->>'attemptId'=$1`,
              [previous.binding.attemptId],
            );
            if (retired.rows.length !== 1 || !retired.rows[0].retired) {
              return deny("retired predecessor reservation");
            }
          } else if (facts.status !== "pending" || facts.attempts !== 0) {
            return deny("initial pending attempt");
          }
          if (state.capacityWitness !== entry.witness) {
            return deny("private capacity");
          }
          await state.startPolicy?.(tx, facts);
          if (!state.control || !state.current) return deny("revoked control");
          // Malformed callback outputs are deliberate decoder probes, never a
          // source of the fixture's expected ordinal or durable attempts count.
          if (state.startResult) {
            return state.startResult() as
              | { attemptOrdinal: number }
              | undefined;
          }
          return { attemptOrdinal: state.ordinalOverride ?? entry.ordinal };
        },
        async authorizeEvent(tx, assignment, _event, data) {
          state.eventPrincipals.push(assignment.placement);
          assert.deepEqual(data, options.data ?? { title: "hello" });
          await state.eventPolicy?.(tx);
          if (!state.event) throw new Error("local event authority revoked");
        },
        async reserveLocal(context, binding) {
          const entry = state.entry!;
          assert.equal(entry.knownStart, false);
          assert.equal(state.capacityWitness, entry.witness);
          state.reservations++;
          await assignments.reserveLocal(context, binding);
          assert.equal(entry.knownStart, false);
          assert.equal(state.capacityWitness, entry.witness);
        },
        async retireLocal(context, binding) {
          const entry = state.entry!;
          assert.equal(state.capacityWitness, entry.witness);
          assert.equal(entry.knownEnd, undefined);
          state.retirements++;
          await assignments.retireLocal(context, binding);
          assert.equal(state.capacityWitness, entry.witness);
          assert.equal(entry.knownEnd, undefined);
          if (state.failRetirement) throw new Error("retirement failed");
        },
      } satisfies OwnerLocalProcessorOptions,
    }),
    async scheduleSettlement(context, scope) {
      await state.schedulePolicy?.("settlement");
      context.afterCommit(() => {
        state.schedules.push(scope.operationId);
      });
    },
    async scheduleRetry(context, delivery) {
      const result = await context.tx.query<{ available_at: string }>(
        `SELECT available_at::text AS available_at FROM ${q}.event_deliveries WHERE id=$1`,
        [delivery.id],
      );
      const exact = result.rows[0].available_at;
      assert.equal(delivery.availableAt, exact);
      await state.schedulePolicy?.("retry");
      context.afterCommit(() => {
        state.retryWakes.push(exact);
      });
    },
  });
  const boundary = createOwnerCommandBoundary({
    session,
    schema,
    ownerId: "owner",
    holderId: "holder",
    now: () => state.time,
    handlers: {
      ...commands.handlers,
      async seed(_intent, context) {
        const store = createEventStore({
          schema,
          session: db,
          ownerCommit: context.ownerCommit,
          admitOperationEventSql: (value, param) =>
            catalog.admitEventSql(value, param),
          indexOperationEventSql: (value, param) =>
            catalog.indexEventSql(value, param),
          indexOperationEvent: (tx, value) => catalog.indexEvent(tx, value),
        });
        const result = await store.commitMutation({
          transaction: context.tx,
          draft: {
            type: "fixture.source",
            namespace: "space",
            payload: {
              dataRef: {
                eventBodyId: "source-body",
                schemaVersion: 1,
                mediaType: "application/json",
              },
            },
            metadata: options.sourceMetadata ?? { origin: "ordinary-source" },
            deduplicationId: "source",
            correlationId: "correlation",
          },
          body: { id: "source-body", json: options.data ?? { title: "hello" } },
          consumers: [{
            consumerId: "processor:fixture.observe",
            settlement: options.detached ? "detached" : "inherit",
          }],
          maxAttempts: options.maxAttempts ?? 3,
        });
        return {
          eventId: result.event.id,
          deliveryId: result.deliveries[0].id,
        };
      },
    },
    projections: commands.projections,
    async authorize(tx, who, command, time) {
      if (command.kind === "seed") {
        assert.equal(who.privateControl, controlWitness);
        return;
      }
      await commands.authorize(tx, who, command, time);
    },
    authenticateReceipt() {
      throw new Error("Generic local receipt lookup is forbidden");
    },
  });
  await boundary.acquire(0);
  const seeded = await boundary.execute(controlCaller(), {
    kind: "seed",
    domain: "logical",
    key: "seed",
    intent: null,
  });
  const source = seeded.result as { eventId: string; deliveryId: string };
  const first: Entry = {
    binding: {
      placement: "owner-local",
      ownerId: "owner",
      epoch: 1,
      holderId: "holder",
      attemptId: "attempt-1",
      namespace: "space",
      sourceEventId: source.eventId,
      deliveryId: source.deliveryId,
      kind: "processor",
      processorId: "fixture.observe",
      consumerId: "processor:fixture.observe",
    },
    ordinal: 1,
    witness: crypto.randomUUID(),
    knownStart: false,
    revoked: false,
    drained: false,
    quarantined: false,
    raw: new Set(),
  };
  state.entry = first;
  state.capacityWitness = first.witness;
  const startCommand = (binding = state.entry!.binding): OwnerCommand => ({
    kind: "owner.local-processor-start",
    domain: "incarnation",
    key: ownerLocalProcessorStartKey(binding),
    intent: binding,
  });
  const completeCommand = (
    completion: OwnerJson = { status: "succeeded" },
    binding = state.entry!.binding,
  ): OwnerCommand => ({
    kind: "processor.local-complete",
    domain: "incarnation",
    key: ownerLocalProcessorCompletionKey(binding),
    intent: { reference: binding, completion },
  });
  function observeStart(result: OwnerCommandOutcome, entry = state.entry!) {
    assert.equal(result.status, "committed");
    assert.deepEqual(result.result, {
      binding: entry.binding,
      attempts: entry.ordinal,
    });
    assert.equal(entry.revoked, false);
    assert.equal(entry.quarantined, false);
    entry.knownStart = true;
  }
  function observeEnd(result: OwnerCommandOutcome, entry = state.entry!) {
    assert.equal(result.status, "committed");
    const receipt = result.result as OwnerLocalProcessorAttemptReceipt;
    assert.deepEqual(receipt.reference, entry.binding);
    assert.equal(receipt.attempts, entry.ordinal);
    entry.knownEnd = structuredClone(receipt);
    entry.revoked = true;
    return receipt;
  }
  async function known<T>(run: () => Promise<T>, entry = state.entry!) {
    try {
      return await run();
    } catch (error) {
      if (boundary.state === "stopped") {
        entry.revoked = true;
        entry.quarantined = true;
      }
      throw error;
    }
  }
  return {
    db,
    q,
    schema,
    state,
    first,
    source,
    processor,
    assignments,
    commands,
    boundary,
    controlCaller,
    caller,
    startCommand,
    completeCommand,
    observeStart,
    observeEnd,
    store: createEventStore({ schema, session: db }),
    async start() {
      return await known(async () => {
        const result = await boundary.execute(controlCaller(), startCommand());
        observeStart(result);
        return result;
      });
    },
    async complete(completion?: OwnerJson) {
      return await known(async () => {
        const result = await boundary.execute(
          caller(),
          completeCommand(completion),
        );
        observeEnd(result);
        return result;
      });
    },
    project: (who = caller(), binding = state.entry!.binding) =>
      boundary.project(who, "processor.local-input", binding),
    settlementState: () =>
      boundary.project(
        caller(),
        "processor.local-settlement-state",
        state.entry!.binding,
      ),
    async exactDelivery() {
      const result = await db.query<{
        status: string;
        attempts: number;
        available_at: string;
        lease_owner: string | null;
        lease_expires_at: string | null;
      }>(
        `SELECT status,attempts,available_at::text AS available_at,lease_owner,lease_expires_at::text AS lease_expires_at FROM ${q}.event_deliveries WHERE id=$1`,
        [source.deliveryId],
      );
      return result.rows[0];
    },
    async snapshot() {
      const result: Record<string, unknown> = {};
      for (
        const name of [
          "events",
          "event_bodies",
          "event_deliveries",
          "open_actions",
          "copilotz_operations",
          "owner_assignments",
          "owner_receipts",
          "owner_receipt_readers",
        ]
      ) {
        result[name] = (await db.query(
          `SELECT row_to_json(t) AS row FROM ${q}.${name} t ORDER BY row_to_json(t)::text`,
        )).rows;
      }
      return result;
    },
    trackRaw(task: Promise<void>, entry = state.entry!) {
      const tracked = task.finally(() => entry.raw.delete(tracked));
      entry.raw.add(tracked);
      return tracked;
    },
    async drain(entry = state.entry!) {
      assert.equal(entry.revoked, true);
      await Promise.all([...entry.raw]);
      entry.drained = true;
      if (entry.knownEnd && !entry.quarantined) {
        if (state.capacityWitness === entry.witness) state.capacityWitness = "";
        const next = state.entry;
        if (next?.previous === entry) state.capacityWitness = next.witness;
      }
    },
    next() {
      const previous = state.entry!;
      const entry: Entry = {
        binding: {
          ...previous.binding,
          attemptId: `attempt-${previous.ordinal + 1}`,
        },
        ordinal: previous.ordinal + 1,
        witness: crypto.randomUUID(),
        knownStart: false,
        revoked: false,
        drained: false,
        quarantined: false,
        raw: new Set(),
        previous,
      };
      state.entry = entry;
      if (previous.drained && previous.knownEnd && !previous.quarantined) {
        state.capacityWitness = entry.witness;
      }
      return entry;
    },
    async close() {
      boundary.stop();
      await db.query(`DROP SCHEMA ${q} CASCADE`);
      await db.close();
    },
  };
}

test("local Processor constructor captures a closed own-data callback set without opening a database", async () => {
  let queries = 0;
  let originalResolutions = 0;
  let replacedResolutions = 0;
  let accessorReads = 0;
  const session: SqlSession = {
    async query() {
      queries++;
      throw new Error("The constructor probe must not open a database");
    },
    async transaction() {
      throw new Error("The constructor probe must not open a transaction");
    },
  };
  const base = {
    ownerId: "owner",
    schema: "public",
    session,
    registry: createPluginRegistry(),
    catalog: createOperationCatalog(session, "public"),
    resolveAssignment: () => undefined,
    authorizeEvent() {},
    scheduleSettlement() {},
    scheduleRetry() {},
  };
  const callbacks = () => ({
    resolveAssignment() {
      originalResolutions++;
      return undefined;
    },
    authorizeStart: () => ({ attemptOrdinal: 1 }),
    authorizeEvent() {},
    isCurrent: () => true,
    async reserveLocal() {},
    async retireLocal() {},
  } satisfies OwnerLocalProcessorOptions);
  const construct = (local: unknown) =>
    createOwnerProcessorCommands({
      ...base,
      local: local as OwnerLocalProcessorOptions,
    });
  assert.doesNotThrow(() => createOwnerProcessorCommands(base));
  const { isCurrent: _missingWitness, ...missing } = callbacks();
  const accessor = Object.defineProperty(callbacks(), "isCurrent", {
    enumerable: true,
    get() {
      accessorReads++;
      return () => true;
    },
  });
  for (
    const malformed of [
      null,
      undefined,
      missing,
      accessor,
      { ...callbacks(), extra: () => true },
      Object.defineProperty(callbacks(), "hidden", { value: true }),
      Object.defineProperty(callbacks(), "isCurrent", {
        value: () => true,
        enumerable: false,
      }),
      Object.assign(callbacks(), { [Symbol("extra")]: true }),
      Object.setPrototypeOf(callbacks(), { inherited: true }),
      Object.create(callbacks()),
    ]
  ) {
    assert.throws(() => construct(malformed), TypeError);
  }
  const outerAccessor = Object.defineProperty({ ...base }, "local", {
    enumerable: true,
    get() {
      accessorReads++;
      return callbacks();
    },
  });
  assert.throws(() => createOwnerProcessorCommands(outerAccessor), TypeError);
  assert.equal(accessorReads, 0);
  const supplied = callbacks();
  const options = { ...base, local: supplied };
  const commands = createOwnerProcessorCommands(options);
  supplied.resolveAssignment = () => {
    replacedResolutions++;
    return undefined;
  };
  options.local = callbacks();
  options.local.resolveAssignment = supplied.resolveAssignment;
  const binding: OwnerLocalProcessorAssignmentBinding = {
    placement: "owner-local",
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    attemptId: "attempt",
    namespace: "space",
    sourceEventId: "source",
    deliveryId: "delivery",
    kind: "processor",
    processorId: "fixture.observe",
    consumerId: "processor:fixture.observe",
  };
  await assert.rejects(
    commands.authorize(session, {
      principal: {
        kind: "owner-local",
        ownerId: "owner",
        epoch: 1,
        holderId: "holder",
        deliveryId: "delivery",
        attemptId: "attempt",
      },
      ownerEpoch: 1,
    }, {
      kind: "processor.local-input",
      domain: "occurrence",
      key: "projection",
      intent: binding,
    }, start),
    lost,
  );
  assert.equal(originalResolutions, 1);
  assert.equal(replacedResolutions, 0);
  assert.equal(queries, 0);
});

test("local Processor keys bind the exact owner incarnation and reject non-data coordinates", () => {
  const binding: OwnerLocalProcessorAssignmentBinding = {
    placement: "owner-local",
    ownerId: "owner",
    epoch: 1,
    holderId: "holder",
    attemptId: "attempt",
    namespace: "space",
    sourceEventId: "source",
    deliveryId: "delivery",
    kind: "processor",
    processorId: "fixture.observe",
    consumerId: "processor:fixture.observe",
  };
  for (
    const [key, kind] of [
      [ownerLocalProcessorStartKey, "owner.local-processor-start"],
      [ownerLocalProcessorCompletionKey, "processor.local-complete"],
    ] as const
  ) {
    assert.equal(
      key(binding),
      JSON.stringify([
        kind,
        1,
        "owner",
        1,
        "holder",
        "delivery",
        "attempt",
      ]),
    );
    for (const name of Object.keys(binding)) {
      let read = false;
      const altered = Object.defineProperty({ ...binding }, name, {
        enumerable: true,
        get() {
          read = true;
          throw new Error("Accessor evaluated");
        },
      });
      assert.throws(() => key(altered));
      assert.equal(read, false);
    }
    assert.throws(() => key({ ...binding, attemptId: " padded " }));
    assert.notEqual(key(binding), key({ ...binding, attemptId: "next" }));
    assert.notEqual(key(binding), key({ ...binding, holderId: "next" }));
    assert.notEqual(key(binding), key({ ...binding, epoch: 2 }));
  }
});

test("local Processor claims a real NULL-deadline delivery and projects ordinary inherited and detached identity without Action frames", async () => {
  for (const detached of [false, true]) {
    const f = await fixture({ detached });
    try {
      await assert.rejects(f.project(), lost);
      const receipt = await f.start();
      assert.deepEqual(receipt.result, {
        binding: f.first.binding,
        attempts: 1,
      });
      const row = await f.exactDelivery();
      assert.equal(row.status, "leased");
      assert.equal(row.attempts, 1);
      assert.equal(row.lease_owner, "attempt-1");
      assert.equal(row.lease_expires_at, null);
      f.state.time = "2040-01-01T00:00:00.000Z";
      const projection = await f.project() as OwnerLocalProcessorProjection;
      assert.deepEqual(projection.reference, f.first.binding);
      assert.equal(projection.processorId, "fixture.observe");
      assert.equal(projection.deliveryId, f.source.deliveryId);
      assert.equal(projection.attempts, 1);
      assert.equal(projection.maxAttempts, 3);
      assert.equal(
        projection.operationKey,
        ownerProcessorOperationKey(f.source.deliveryId),
      );
      assert.deepEqual(projection.event.data, { title: "hello" });
      assert.ok(projection.event.durable);
      assert.equal(projection.event.id, f.source.eventId);
      assert.equal(projection.identity.causationId, f.source.eventId);
      assert.equal(projection.identity.correlationId, "correlation");
      const delivery = await f.store.getDelivery(f.source.deliveryId);
      assert.equal(
        projection.identity.settlementScopeId,
        delivery!.settlementScopeId,
      );
      if (detached) {
        assert.notEqual(delivery!.settlementScopeId, f.source.eventId);
      } else assert.equal(delivery!.settlementScopeId, f.source.eventId);
      for (
        const name of [
          "workerId",
          "lease",
          "assignmentId",
          "sessionId",
          "dispatchAttemptId",
        ]
      ) {
        assert.equal(Object.hasOwn(projection, name), false);
      }
      assert.equal(f.state.executions, 0);
      assert.equal(f.state.workerResolutions, 0);
      assert.equal(f.state.workerPolicies, 0);
      assert.ok(
        f.state.eventPrincipals.every((placement) =>
          placement === "owner-local"
        ),
      );
      assert.deepEqual((await f.complete()).result, {
        reference: f.first.binding,
        attempts: 1,
        status: "succeeded",
      });
      assert.equal((await f.exactDelivery()).status, "succeeded");
      assert.equal(f.state.capacityWitness, f.first.witness);
      await f.drain();
      assert.equal(f.state.capacityWitness, "");
      assert.equal(
        (await f.db.query(`SELECT * FROM ${f.q}.open_actions`)).rows.length,
        0,
      );
      assert.deepEqual(
        (await f.db.query<{ type: string }>(
          `SELECT type FROM ${f.q}.events ORDER BY seq`,
        )).rows.map((row) => row.type),
        ["fixture.source"],
      );
      assert.deepEqual(
        (await f.db.query<{ kind: string; principal_kind: string }>(
          `SELECT kind,principal_kind FROM ${f.q}.owner_receipts WHERE kind IN ('owner.local-processor-start','processor.local-complete') ORDER BY kind`,
        )).rows,
        [
          {
            kind: "owner.local-processor-start",
            principal_kind: "owner-control",
          },
          { kind: "processor.local-complete", principal_kind: "owner-local" },
        ],
      );
      await assert.rejects(f.project(), lost);
      await assert.rejects(f.start(), lost);
      await assert.rejects(
        f.boundary.execute(f.caller(), f.completeCommand()),
        lost,
      );
    } finally {
      await f.close();
    }
  }
});

test("local Processor routes default closed and require owner-control start plus private attempt witness", async () => {
  const disabled = await fixture({ localDisabled: true });
  try {
    const before = await disabled.snapshot();
    await assert.rejects(disabled.start());
    await assert.rejects(disabled.project());
    await assert.rejects(disabled.settlementState());
    await assert.rejects(disabled.complete());
    assert.deepEqual(await disabled.snapshot(), before);
  } finally {
    await disabled.close();
  }
  const f = await fixture();
  try {
    await assert.rejects(
      f.boundary.execute(f.caller(), f.startCommand()),
      lost,
    );
    await assert.rejects(
      f.boundary.execute({
        ...f.controlCaller(),
        privateControl: "forged",
      }, f.startCommand()),
      lost,
    );
    await f.start();
    for (
      const who of [
        f.controlCaller(),
        { ...f.caller(), privateAttempt: "forged" },
        {
          principal: { kind: "worker" as const, workerId: "worker" },
          ownerEpoch: 1,
        },
        ...[{ attemptId: "stale" }, { deliveryId: "other" }, {
          holderId: "other",
        }, { epoch: 2 }]
          .map((change) => ({
            ...f.caller(),
            principal: { ...f.caller().principal, ...change },
          } as OwnerCaller)),
      ]
    ) {
      await assert.rejects(f.project(who));
      await assert.rejects(f.boundary.execute(who, f.completeCommand()));
    }
    f.state.current = false;
    await assert.rejects(f.project(), lost);
    f.state.current = true;
    f.state.ordinalOverride = 2;
    await assert.rejects(f.project(), lost);
    await assert.rejects(f.complete(), lost);
    f.state.ordinalOverride = undefined;
    await assert.rejects(
      f.project(f.caller(), { ...f.first.binding, sourceEventId: "other" }),
      lost,
    );
    await assert.rejects(
      f.boundary.project(f.caller(), "processor.input", f.first.binding),
    );
    await assert.rejects(f.boundary.execute(f.caller(), {
      kind: "processor.renew",
      domain: "occurrence",
      key: "renew",
      intent: { reference: f.first.binding, sequence: 1 },
    }));
    const before = await f.snapshot();
    await assert.rejects(f.boundary.readReceipt(f.caller(), {
      domain: "incarnation",
      key: f.startCommand().key,
    }));
    assert.deepEqual(await f.snapshot(), before);
    await f.complete();
  } finally {
    await f.close();
  }
});

test("local Processor start accepts only an exact closed own-data ordinal result", async () => {
  const f = await fixture();
  try {
    let accessorRead = false;
    const invalid = [
      () => undefined,
      () => true,
      () => ({ attemptOrdinal: 0 }),
      () => ({ attemptOrdinal: 2 }),
      () => ({ attemptOrdinal: 1, extra: true }),
      () => Object.create({ attemptOrdinal: 1 }),
      () =>
        Object.defineProperty({}, "attemptOrdinal", {
          enumerable: true,
          get() {
            accessorRead = true;
            return 1;
          },
        }),
    ];
    const before = await f.snapshot();
    for (const result of invalid) {
      f.state.startResult = result;
      await assert.rejects(f.start());
      assert.deepEqual(await f.snapshot(), before);
    }
    assert.equal(accessorRead, false);
    assert.equal(f.state.reservations, 0);
    f.state.startResult = undefined;
    await f.start();
  } finally {
    await f.close();
  }
});

test("local Processor private current witness refuses false, throws, promises and truthy nonbooleans", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    for (
      const witness of [
        () => false,
        () => "true",
        () => 1,
        () => Promise.resolve(true),
        () => {
          throw new Error("private witness revoked");
        },
      ]
    ) {
      f.state.witnessResult = witness;
      await assert.rejects(f.start(), lost);
      assert.deepEqual(await f.snapshot(), before);
    }
    assert.equal(f.state.reservations, 0);
    f.state.witnessResult = undefined;
    await f.start();
    f.state.witnessResult = () => false;
    await assert.rejects(f.project(), lost);
    await assert.rejects(f.settlementState(), lost);
    await assert.rejects(f.complete(), lost);
    f.state.witnessResult = undefined;
    await f.complete();
  } finally {
    await f.close();
  }
});

test("local Processor rechecks private authority on handler consumption after the actual receipt read", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    f.state.afterRead = (sql) => {
      if (
        /SELECT kind,intent,result FROM/.test(sql) &&
        sql.includes("owner_receipts")
      ) {
        f.state.control = false;
      }
    };
    await assert.rejects(f.start(), lost);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.state.reservations, 0);
    f.state.afterRead = undefined;
    f.state.control = true;
    await f.start();
    const leased = await f.snapshot();
    f.state.afterRead = (sql) => {
      if (
        /SELECT kind,intent,result FROM/.test(sql) &&
        sql.includes("owner_receipts")
      ) {
        f.state.settlement = false;
      }
    };
    await assert.rejects(f.complete(), lost);
    assert.deepEqual(await f.snapshot(), leased);
    assert.equal(f.state.retirements, 0);
    f.state.afterRead = undefined;
    f.state.settlement = true;
    await f.complete();
  } finally {
    await f.close();
  }
});

test("local Processor ordinary failure, exhaustion, capability refusal and cancellation use the safe completion decoder", async () => {
  for (
    const [completion, maxAttempts, expected] of [
      [retryable, 3, "retry_wait"],
      [retryable, 1, "dead_letter"],
      [
        { status: "failed", code: "processor_failed", retryable: false },
        3,
        "dead_letter",
      ],
      [
        {
          status: "failed",
          code: "processor_capability_unsupported",
          retryable: false,
        },
        3,
        "dead_letter",
      ],
      [{ status: "cancelled", code: "processor_cancelled" }, 3, "cancelled"],
    ] as const
  ) {
    const f = await fixture({ maxAttempts });
    try {
      await f.start();
      const result = (await f.complete(completion))
        .result as OwnerLocalProcessorAttemptReceipt;
      const row = await f.exactDelivery();
      assert.equal(result.status, expected);
      assert.equal(result.attempts, 1);
      assert.equal(row.status, expected);
      assert.equal(
        (await f.db.query<{ retired: boolean }>(
          `SELECT retired FROM ${f.q}.owner_assignments`,
        )).rows[0].retired,
        true,
      );
      if (result.status === "retry_wait") {
        assert.equal(result.availableAt, row.available_at);
        assert.deepEqual(f.state.retryWakes, [row.available_at]);
      } else assert.deepEqual(f.state.retryWakes, []);
      assert.equal(f.state.executions, 0);
    } finally {
      await f.close();
    }
  }
});

test("local Processor current cancellation takes precedence and settlement stays separately granted", async () => {
  const f = await fixture();
  try {
    await f.start();
    assert.deepEqual(await f.settlementState(), {
      reference: f.first.binding,
      cancellationRequested: false,
    });
    f.state.ctx = false;
    f.state.event = false;
    await assert.rejects(f.project(), lost);
    assert.deepEqual(await f.settlementState(), {
      reference: f.first.binding,
      cancellationRequested: false,
    });
    await f.db.query(
      `UPDATE ${f.q}.copilotz_operations SET cancellation_requested_at=$1::timestamptz WHERE operation_id=$2`,
      [start, f.source.eventId],
    );
    assert.deepEqual(await f.settlementState(), {
      reference: f.first.binding,
      cancellationRequested: true,
    });
    await assert.rejects(f.complete(), /cancellation/i);
    await assert.rejects(f.complete(retryable), /cancellation/i);
    f.state.settlement = false;
    await assert.rejects(f.settlementState(), lost);
    await assert.rejects(
      f.complete({ status: "cancelled", code: "processor_cancelled" }),
      lost,
    );
    f.state.settlement = true;
    assert.equal(
      ((await f.complete({
        status: "cancelled",
        code: "processor_cancelled",
      })).result as OwnerLocalProcessorAttemptReceipt).status,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("local Processor completion rejects arbitrary output and unsafe failure data without mutation", async () => {
  const f = await fixture();
  try {
    await f.start();
    const before = await f.snapshot();
    for (
      const completion of [
        { status: "succeeded", output: "forged" },
        { status: "failed", code: "private exception", retryable: true },
        {
          status: "failed",
          code: "processor_capability_unsupported",
          retryable: true,
        },
        { status: "failed", code: "processor_failed", retryable: "true" },
        { status: "cancelled", code: "other" },
      ] as OwnerJson[]
    ) {
      await assert.rejects(f.complete(completion));
      assert.deepEqual(await f.snapshot(), before);
    }
    await f.complete();
  } finally {
    await f.close();
  }
});

test("local Processor post-policy and post-read revocation cannot leak input or commit a fresh start", async () => {
  const f = await fixture();
  try {
    const before = await f.snapshot();
    f.state.eventPolicy = async () => {
      await Promise.resolve();
      f.state.control = false;
    };
    await assert.rejects(f.start(), lost);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.state.reservations, 0);
    f.state.control = true;
    f.state.eventPolicy = undefined;
    await f.start();
    for (const mode of ["policy", "body-read"] as const) {
      if (mode === "policy") {
        f.state.eventPolicy = async () => {
          await Promise.resolve();
          f.state.current = false;
        };
      } else {
        f.state.afterRead = (sql) => {
          if (sql.includes("event_bodies") && /^\s*SELECT/i.test(sql)) {
            f.state.current = false;
          }
        };
      }
      await assert.rejects(f.project(), lost);
      f.state.current = true;
      f.state.eventPolicy = undefined;
      f.state.afterRead = undefined;
    }
    f.state.eventPolicy = async () => {
      await Promise.resolve();
      f.state.ctx = false;
    };
    await assert.rejects(f.project(), lost);
    f.state.eventPolicy = undefined;
    await f.complete();
  } finally {
    await f.close();
  }
});

test("local Processor exact NULL representation, source consumer and owner fence remain necessary", async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.db.query(
      `UPDATE ${f.q}.event_deliveries SET lease_expires_at=$1 WHERE id=$2`,
      [
        "2040-01-01T00:00:00Z",
        f.source.deliveryId,
      ],
    );
    await assert.rejects(f.project(), lost);
    await assert.rejects(f.complete(), lost);
    await f.db.query(
      `UPDATE ${f.q}.event_deliveries SET lease_expires_at=NULL WHERE id=$1`,
      [f.source.deliveryId],
    );
    await f.db.query(
      `UPDATE ${f.q}.event_deliveries SET consumer_id='processor:other' WHERE id=$1`,
      [f.source.deliveryId],
    );
    await assert.rejects(f.project());
    await f.db.query(
      `UPDATE ${f.q}.event_deliveries SET consumer_id='processor:fixture.observe' WHERE id=$1`,
      [f.source.deliveryId],
    );
    f.processor.on = [{ eventType: "fixture.other" }];
    await assert.rejects(f.project(), /no longer matches/);
    f.processor.on = [{ eventType: "fixture.source" }];
    await f.db.query(
      `UPDATE ${f.q}.owner_epochs SET epoch=2,holder='next' WHERE owner='owner'`,
    );
    await assert.rejects(f.project(), lost);
    await assert.rejects(f.complete(), lost);
  } finally {
    await f.close();
  }
});

test("local Processor final held SQL read cannot return input after private authority is revoked", async () => {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  try {
    await f.start();
    let reads = 0;
    f.state.afterRead = async (sql) => {
      if (sql.includes("AS reserved") && ++reads === 3) {
        entered.resolve();
        await release.promise;
      }
    };
    const projected = f.project();
    await entered.promise;
    f.state.current = false;
    release.resolve();
    await assert.rejects(projected, lost);
    assert.equal(reads, 3);
    assert.equal((await f.exactDelivery()).status, "leased");
    assert.equal(f.state.capacityWitness, f.first.witness);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("local Processor dependent-authority seam requires fresh local input policy and grants", async () => {
  const f = await fixture();
  try {
    await f.start();
    const live = await f.db.transaction((tx) =>
      f.commands.authorizeLocalLive(tx, f.caller(), f.state.time)
    );
    assert.deepEqual(live.assignment, {
      ...f.first.binding,
      attemptOrdinal: 1,
      ctxGranted: true,
      settlementGranted: true,
    });
    assert.equal(live.delivery.id, f.source.deliveryId);
    assert.equal(live.event.id, f.source.eventId);
    f.state.event = false;
    await assert.rejects(
      f.db.transaction((tx) =>
        f.commands.authorizeLocalLive(tx, f.caller(), f.state.time)
      ),
      /local event authority revoked/,
    );
    f.state.event = true;
    f.state.eventPolicy = async () => {
      await Promise.resolve();
      f.state.ctx = false;
    };
    await assert.rejects(
      f.db.transaction((tx) =>
        f.commands.authorizeLocalLive(tx, f.caller(), f.state.time)
      ),
      lost,
    );
    f.state.eventPolicy = undefined;
    await f.complete();
  } finally {
    await f.close();
  }
});

test("local Processor policy cannot replace its already-authorized ordinary body across an await", async () => {
  const f = await fixture();
  try {
    for (const phase of ["start", "input"] as const) {
      if (phase === "input") await f.start();
      for (
        const replacement of [
          { title: "changed ordinary body" },
          { nested: { schema: "copilotz.event.protected-value.v99" } },
        ]
      ) {
        const encoded = await encodeEventBody(replacement);
        const before = await f.snapshot();
        let changed = false;
        f.state.eventPolicy = async (tx) => {
          await Promise.resolve();
          changed = true;
          await tx.query(
            `UPDATE ${f.q}.event_bodies SET body=$1::jsonb,digest=$2 WHERE namespace='space' AND event_body_id='source-body'`,
            [encoded.body, encoded.digest],
          );
        };
        await assert.rejects(phase === "start" ? f.start() : f.project());
        assert.equal(changed, true);
        assert.deepEqual(await f.snapshot(), before);
        assert.equal(f.first.knownStart, phase === "input");
        f.state.eventPolicy = undefined;
      }
    }
    await f.project();
    await f.complete();
  } finally {
    await f.close();
  }
});

test("local Processor start facts are detached data and cannot supply a different persisted ordinal", async () => {
  const f = await fixture();
  try {
    f.state.startPolicy = async (_tx, facts) => {
      const detached = facts as { attempts: number; availableAt: string };
      detached.attempts = 999;
      detached.availableAt = "2040-01-01T00:00:00Z";
      await Promise.resolve();
    };
    await f.start();
    assert.equal((await f.exactDelivery()).attempts, 1);
    assert.ok(f.state.startChecks.every((facts) => facts.attempts === 0));
    assert.equal(
      (await f.project() as OwnerLocalProcessorProjection).attempts,
      1,
    );
  } finally {
    await f.close();
  }
});

test("local Processor start and completion rollback atomically with reservation retirement and receipts", async () => {
  for (const phase of ["start", "complete", "retire"] as const) {
    const f = await fixture();
    try {
      if (phase !== "start") await f.start();
      const before = await f.snapshot();
      const schedules = [...f.state.schedules];
      if (phase === "retire") f.state.failRetirement = true;
      else f.state.rollback = true;
      await assert.rejects(
        phase === "start" ? f.start() : f.complete(retryable),
        /rollback|retirement failed/,
      );
      assert.deepEqual(await f.snapshot(), before);
      assert.deepEqual(f.state.schedules, schedules);
      assert.deepEqual(f.state.retryWakes, []);
      assert.equal(f.first.knownEnd, undefined);
      assert.equal(f.first.knownStart, phase !== "start");
      assert.equal(f.state.capacityWitness, f.first.witness);
    } finally {
      await f.close();
    }
  }
});

async function finalWindowRevocation(
  mode: "start-schedule" | "complete-schedule" | "retry-schedule" | "ended-row",
) {
  const f = await fixture();
  const entered = deferred();
  const release = deferred();
  try {
    if (mode !== "start-schedule") await f.start();
    const before = await f.snapshot();
    const schedules = [...f.state.schedules];
    const retries = [...f.state.retryWakes];
    if (mode === "ended-row") {
      f.state.afterRead = async (sql) => {
        if (
          sql.includes("AS retired") && sql.includes("d.lease_owner IS NULL")
        ) {
          entered.resolve();
          await release.promise;
        }
      };
    } else {
      f.state.schedulePolicy = async (kind) => {
        if (kind === (mode === "retry-schedule" ? "retry" : "settlement")) {
          entered.resolve();
          await release.promise;
        }
      };
    }
    const pending = mode === "start-schedule" ? f.start() : f.complete(
      mode === "complete-schedule" ? { status: "succeeded" } : retryable,
    );
    await entered.promise;
    if (mode === "start-schedule") f.state.control = false;
    else f.state.settlement = false;
    release.resolve();
    await assert.rejects(pending, lost);
    assert.deepEqual(await f.snapshot(), before);
    assert.deepEqual(f.state.schedules, schedules);
    assert.deepEqual(f.state.retryWakes, retries);
    assert.equal(f.first.knownStart, mode !== "start-schedule");
    assert.equal(f.first.knownEnd, undefined);
    assert.equal(f.first.drained, false);
    assert.equal(f.state.capacityWitness, f.first.witness);
  } finally {
    release.resolve();
    await f.close();
  }
}

test("local Processor final start scheduling revocation rolls back before its fresh start receipt", async () => {
  await finalWindowRevocation("start-schedule");
});
test("local Processor final completion scheduling revocation rolls back before its ended receipt", async () => {
  await finalWindowRevocation("complete-schedule");
});
test("local Processor final retry scheduling revocation rolls back before its ended receipt", async () => {
  await finalWindowRevocation("retry-schedule");
});
test("local Processor final ended-row read revocation rolls back before its ended receipt", async () => {
  await finalWindowRevocation("ended-row");
});

test("local Processor unknown committed and aborted outcomes never activate or release private capacity", async () => {
  for (const phase of ["start", "complete"] as const) {
    for (const unknown of ["committed", "aborted"] as const) {
      const f = await fixture();
      try {
        if (phase === "complete") await f.start();
        f.state.unknown = unknown;
        await assert.rejects(
          phase === "start" ? f.start() : f.complete(retryable),
        );
        assert.equal(f.boundary.state, "stopped");
        assert.equal(f.first.knownStart, phase === "complete");
        assert.equal(f.first.knownEnd, undefined);
        assert.equal(f.first.revoked, true);
        assert.equal(f.first.quarantined, true);
        await f.drain();
        assert.equal(f.state.capacityWitness, f.first.witness);
        const row = await f.exactDelivery();
        assert.equal(
          row.attempts,
          phase === "start" && unknown === "aborted" ? 0 : 1,
        );
        assert.equal(
          row.status,
          phase === "start"
            ? unknown === "committed" ? "leased" : "pending"
            : unknown === "committed"
            ? "retry_wait"
            : "leased",
        );
        await assert.rejects(f.project());
        await assert.rejects(f.start());
      } finally {
        await f.close();
      }
    }
  }
});

test("local Processor held known start reply keeps capacity charged and cannot project before observation", async () => {
  const f = await fixture();
  const gate = deferred();
  try {
    const result = await f.boundary.execute(
      f.controlCaller(),
      f.startCommand(),
    );
    const held = f.trackRaw(gate.promise);
    assert.equal((await f.exactDelivery()).status, "leased");
    assert.equal(f.first.knownStart, false);
    assert.equal(f.state.capacityWitness, f.first.witness);
    await assert.rejects(f.project(), lost);
    gate.resolve();
    await held;
    f.observeStart(result);
    await f.project();
    await assert.rejects(f.start(), lost);
    assert.equal(f.state.reservations, 1);
    assert.equal(f.state.executions, 0);
  } finally {
    gate.resolve();
    await f.close();
  }
});

test("local Processor retry requires genuine failure, known exact receipt, irreversible revocation and actual predecessor drain", async () => {
  const f = await fixture();
  const gate = deferred();
  try {
    await f.start();
    const initial = await f.project() as OwnerLocalProcessorProjection;
    f.trackRaw(gate.promise);
    const ended = (await f.complete(retryable))
      .result as OwnerLocalProcessorAttemptReceipt;
    assert.equal(ended.status, "retry_wait");
    if (ended.status !== "retry_wait") {
      throw new Error("Expected genuine retry");
    }
    const row = await f.exactDelivery();
    assert.equal(ended.availableAt, row.available_at);
    assert.deepEqual(f.state.retryWakes, [row.available_at]);
    const predecessor = f.first;
    const next = f.next();
    f.state.time = row.available_at;
    await assert.rejects(f.start(), lost);
    assert.equal(f.state.refusals.at(-1), "revoked and drained predecessor");
    const draining = f.drain(predecessor);
    assert.equal(predecessor.drained, false);
    assert.equal(f.state.capacityWitness, predecessor.witness);
    await assert.rejects(f.start(), lost);
    gate.resolve();
    await draining;
    assert.equal(predecessor.drained, true);
    const known = predecessor.knownEnd;
    predecessor.knownEnd = undefined;
    await assert.rejects(f.start(), lost);
    assert.equal(f.state.refusals.at(-1), "known predecessor receipt");
    predecessor.knownEnd = known;
    f.state.time = start;
    await assert.rejects(f.start(), lost);
    assert.equal((await f.exactDelivery()).attempts, 1);
    f.state.time = row.available_at;
    await f.start();
    assert.equal((await f.exactDelivery()).attempts, 2);
    assert.equal((await f.exactDelivery()).lease_owner, next.binding.attemptId);
    const invocation = await f.project() as OwnerLocalProcessorProjection;
    assert.equal(invocation.operationKey, initial.operationKey);
    assert.equal(invocation.deliveryId, initial.deliveryId);
    assert.deepEqual(invocation.identity, initial.identity);
    assert.deepEqual(invocation.event, initial.event);
    await assert.rejects(
      f.project(f.caller(predecessor), predecessor.binding),
      lost,
    );
    await assert.rejects(
      f.boundary.execute(
        f.caller(predecessor),
        f.completeCommand(retryable, predecessor.binding),
      ),
      lost,
    );
    assert.deepEqual((await f.complete()).result, {
      reference: next.binding,
      attempts: 2,
      status: "succeeded",
    });
    assert.deepEqual(
      (await f.db.query<{ retired: boolean }>(
        `SELECT retired FROM ${f.q}.owner_assignments ORDER BY created_at,assignment_key`,
      )).rows.map((row) => row.retired),
      [true, true],
    );
  } finally {
    gate.resolve();
    await f.close();
  }
});

async function dueMutationRegression(postgresUrl?: string) {
  const f = await fixture({ postgres: postgresUrl });
  try {
    await f.start();
    await f.complete(retryable);
    await f.drain();
    f.next();
    const row = await f.exactDelivery();
    f.state.time = "2040-01-01T00:00:00.000Z";
    const before = await f.snapshot();
    let changed = false;
    f.state.eventPolicy = async (tx) => {
      if (changed) return;
      changed = true;
      await tx.query(
        `UPDATE ${f.q}.event_deliveries SET available_at=available_at + INTERVAL '1 microsecond' WHERE id=$1`,
        [f.source.deliveryId],
      );
    };
    // Both timestamps remain due and normalize to the same JavaScript
    // millisecond. Only a lossless persisted-value comparison detects this.
    await assert.rejects(f.start(), lost);
    assert.equal(changed, true);
    assert.deepEqual(await f.snapshot(), before);
    assert.equal((await f.exactDelivery()).available_at, row.available_at);
    f.state.eventPolicy = undefined;
    f.state.time = row.available_at;
    await f.start();
    assert.equal((await f.exactDelivery()).attempts, 2);
  } finally {
    await f.close();
  }
}
test("local Processor retry start refuses a policy-time microsecond due-instant change even within the same millisecond", async () => {
  await dueMutationRegression();
});
test(
  "PostgreSQL local Processor retry preserves lossless due timestamps across policy awaits",
  {
    skip: !postgres,
  },
  async () => {
    await dueMutationRegression(postgres!);
  },
);

test("local Processor rejects future and malformed protected families and partial references before any claim", async () => {
  for (
    const data of [
      { nested: [{ schema: "copilotz.event.protected-value.v99" }] },
      { nested: [{ schema: ["copilotz.action.protected-value.v2"] }] },
      { nested: [{ schema: "copilotz.action.lifecycle.protected" }] },
      { nested: [{ assetId: "partial" }] },
      { nested: [{ bodyId: "partial" }] },
    ]
  ) {
    const f = await fixture({ data });
    try {
      const before = await f.snapshot();
      await assert.rejects(f.start(), { code: "ordinary_value_unsupported" });
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(f.state.reservations, 0);
      assert.equal(f.first.knownStart, false);
      assert.equal(f.state.executions, 0);
    } finally {
      await f.close();
    }
  }
  const f = await fixture({
    sourceMetadata: {
      nested: { schema: ["copilotz.action.protected-value-aad.v99"] },
    },
  });
  try {
    const before = await f.snapshot();
    await assert.rejects(f.start(), { code: "ordinary_value_unsupported" });
    assert.deepEqual(await f.snapshot(), before);
    assert.equal(f.state.reservations, 0);
  } finally {
    await f.close();
  }
});

test("local Processor raw nonobject metadata cannot hide protected or reference markers behind reader normalization", async () => {
  const f = await fixture();
  const original: OwnerJson = { origin: "ordinary-source" };
  // Deliberate corruption fixture only. Disabling, editing and re-enabling the
  // immutable-event trigger is one transaction, so an error also restores the
  // trigger state. The normal command path never bypasses event immutability.
  const replaceRawMetadata = (metadata: OwnerJson) =>
    f.db.transaction(async (tx) => {
      await tx.query(
        `ALTER TABLE ${f.q}.events DISABLE TRIGGER copilotz_events_immutable`,
      );
      await tx.query(
        `UPDATE ${f.q}.events SET metadata=$1::jsonb WHERE id=$2`,
        [JSON.stringify(metadata), f.source.eventId],
      );
      await tx.query(
        `ALTER TABLE ${f.q}.events ENABLE TRIGGER copilotz_events_immutable`,
      );
    });
  try {
    for (
      const metadata of [
        [{ schema: "copilotz.event.protected-value.v99" }],
        [{ assetId: "partial-reference" }],
      ] as OwnerJson[]
    ) {
      await replaceRawMetadata(metadata);
      const raw = await f.db.query<{ metadata: OwnerJson }>(
        `SELECT metadata FROM ${f.q}.events WHERE id=$1`,
        [f.source.eventId],
      );
      assert.deepEqual(raw.rows[0].metadata, metadata);
      // This existing general-purpose reader intentionally normalizes metadata.
      // Local authorization must independently inspect the actual SQL value.
      assert.deepEqual(
        (await f.store.getEvent(f.source.eventId))!.metadata,
        {},
      );
      const before = await f.snapshot();
      await assert.rejects(f.start());
      assert.deepEqual(await f.snapshot(), before);
      assert.equal(f.state.reservations, 0);
      assert.equal(f.first.knownStart, false);
      assert.equal((await f.exactDelivery()).attempts, 0);
      await replaceRawMetadata(original);
    }
    await f.start();
    await f.complete();
  } finally {
    try {
      await replaceRawMetadata(original);
    } finally {
      await f.close();
    }
  }
});
