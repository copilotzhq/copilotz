/** Private owner two-phase settlement on the existing operation catalog. Output
 * drains are host work outside the command loop; catalog state remains the only
 * operation terminal authority. This does not implement attempt/effect recovery. */
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { EventPublisher } from "../events/coordinator.ts";
import {
  type OperationCatalogCore,
  type OperationSettlementScope,
  type OperationSettlementSnapshot,
  publishCommittedOperationSettlement,
  readOperationSettlement,
  terminalizeOperationSettlement,
} from "../streams/catalog.ts";
import { ownerTableNames } from "./schema.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerCommandContext,
  OwnerCommandHandler,
  OwnerJson,
  OwnerProjectionHandler,
} from "./boundary.ts";

export const OWNER_OPERATION_SETTLEMENT = "operation.settlement";
export const OWNER_OPERATION_READINESS = "operation.settlement.readiness";
export const OWNER_OPERATION_SETTLED_EVENT = "copilotz.operation.settled.v1";
export type OwnerSettlementDrain = Readonly<{
  deliveryId: string;
  dispatchAttemptId: string;
}>;
type Ticket =
  & OperationSettlementScope
  & Readonly<{
    epoch: number;
    nextEventOrdinal: string;
    nextStreamOrdinal: string;
    drains: readonly OwnerSettlementDrain[];
  }>;
type Prepared =
  | Readonly<{ status: "missing" | "pending" }>
  | Readonly<{ status: "terminal"; state: string }>
  | Readonly<{ status: "ready"; ticket: Ticket }>;
function refuse(message: string): never {
  throw Object.assign(new Error(message), {
    name: "ActionOwnershipLost",
    code: "ActionOwnershipLost",
  });
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) {
    throw new TypeError("Invalid operation settlement identity.");
  }
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  ) {
    throw new TypeError("Invalid operation settlement data.");
  }
  return value as Record<string, unknown>;
}
function scope(value: unknown): OperationSettlementScope {
  const input = object(value, ["namespace", "operationId"]);
  text(input.namespace);
  text(input.operationId);
  return { namespace: input.namespace, operationId: input.operationId };
}
function drainReferences(
  value: unknown,
  limit: number,
): readonly OwnerSettlementDrain[] {
  if (!Array.isArray(value) || value.length > limit) {
    throw new TypeError("Operation drain exceeds its bounded capacity.");
  }
  const seen = new Set<string>();
  return value.map((entry) => {
    const item = object(entry, ["deliveryId", "dispatchAttemptId"]);
    text(item.deliveryId);
    text(item.dispatchAttemptId);
    if (seen.has(item.deliveryId)) {
      throw new TypeError("Duplicate operation drain.");
    }
    seen.add(item.deliveryId);
    return {
      deliveryId: item.deliveryId,
      dispatchAttemptId: item.dispatchAttemptId,
    };
  }).sort((a, b) => a.deliveryId.localeCompare(b.deliveryId));
}
function ticket(value: unknown, limit: number): Ticket {
  const input = object(value, [
    "namespace",
    "operationId",
    "epoch",
    "nextEventOrdinal",
    "nextStreamOrdinal",
    "drains",
  ]);
  const target = scope({
    namespace: input.namespace,
    operationId: input.operationId,
  });
  if (!Number.isSafeInteger(input.epoch) || Number(input.epoch) < 1) {
    throw new TypeError("Invalid operation settlement epoch.");
  }
  for (const key of ["nextEventOrdinal", "nextStreamOrdinal"]) {
    if (typeof input[key] !== "string" || !/^[1-9][0-9]*$/.test(input[key])) {
      throw new TypeError("Invalid operation settlement revision.");
    }
  }
  return {
    ...target,
    epoch: Number(input.epoch),
    nextEventOrdinal: input.nextEventOrdinal as string,
    nextStreamOrdinal: input.nextStreamOrdinal as string,
    drains: drainReferences(input.drains, limit),
  };
}
export function ownerOperationSettlementKey(
  ownerId: string,
  target: OperationSettlementScope,
  occurrence: string,
): string {
  return JSON.stringify([
    OWNER_OPERATION_SETTLEMENT,
    ownerId,
    target.namespace,
    target.operationId,
    occurrence,
  ]);
}
export function ownerOperationSettlementAlarm(
  target: OperationSettlementScope,
): string {
  return JSON.stringify([
    OWNER_OPERATION_SETTLEMENT,
    target.namespace,
    target.operationId,
  ]);
}
function live(snapshot: OperationSettlementSnapshot): boolean {
  return snapshot.state === "accepted" || snapshot.state === "running";
}

export function createOwnerOperationSettlement(
  options: Readonly<{
    ownerId: string;
    schema: string;
    session: SqlSession;
    catalog: OperationCatalogCore;
    /** Private opt-in; unconfigured owners refuse all stream history. */
    contentLifecycle?: "owner";
    maxDrains?: number;
    maxOutstandingDrains?: number;
    maxConcurrentChecks?: number;
    drainTimeoutMs?: number;
    /** Current host settlement/control authority, not worker ctx or ingress grants.
     * It must remain available for safe settlement after ingress/ctx revocation. */
    authorizeControl(
      tx: SqlExecutor,
      caller: OwnerCaller,
      target: OperationSettlementScope,
      commandTime: string,
    ): boolean | Promise<boolean>;
    /** SQL-only host selection of successful current attempt output reservations.
     * Return an exhaustive bounded list; fail rather than truncate. Pending/lost
     * attempts are never drain targets. This must not await transport or output. */
    selectDrains(
      tx: SqlExecutor,
      caller: OwnerCaller,
      target: OperationSettlementScope,
      commandTime: string,
    ):
      | readonly OwnerSettlementDrain[]
      | Promise<readonly OwnerSettlementDrain[]>;
    /** Recheck the exact current host assignment/session/attempt and success. A
     * payload reference alone never authorizes output. Called before and after drain. */
    authorizeDrain(
      tx: SqlExecutor,
      caller: OwnerCaller,
      target: OperationSettlementScope,
      drain: OwnerSettlementDrain,
      commandTime: string,
    ): boolean | Promise<boolean>;
    /** Outside the command loop. Wait for the existing relay reservation; never
     * initiate or replay business dispatch. Validate current output authority while
     * flushing; return false on replacement/revocation. Keep the same reservation
     * identifiable through terminal settlement, even after its buffer is consumed. */
    drain(
      target: OperationSettlementScope,
      ref: OwnerSettlementDrain,
      options: Readonly<{ epoch: number; signal?: AbortSignal }>,
    ): Promise<boolean>;
    /** Nonblocking bounded host queue admission only. Persisted alarms are the
     * fallback if enqueue fails; this callback must not await dependent execution. */
    wake(target: OperationSettlementScope): void;
    publish?: EventPublisher;
  }>,
) {
  // SQL/catalog/boundary ports remain trusted capabilities. Snapshot their
  // identities and give policy/relay callbacks only independent data copies.
  const {
    ownerId,
    schema,
    session,
    catalog,
    contentLifecycle: contentMode,
    authorizeControl,
    selectDrains,
    authorizeDrain,
    drain,
    wake,
    publish,
  } = options;
  text(ownerId);
  if (contentMode !== undefined && contentMode !== "owner") {
    throw new TypeError("Unsupported owner content lifecycle.");
  }
  const contentLifecycle = contentMode === "owner"
    ? Object.freeze({ ownerId })
    : undefined;
  if (catalog.databaseSchema !== schema) {
    throw new TypeError("Settlement catalog schema does not match.");
  }
  for (
    const name of [
      "authorizeControl",
      "selectDrains",
      "authorizeDrain",
      "drain",
      "wake",
    ] as const
  ) {
    if (
      typeof {
        authorizeControl,
        selectDrains,
        authorizeDrain,
        drain,
        wake,
      }[name] !== "function"
    ) {
      throw new TypeError(`${name} is required.`);
    }
  }
  const maxDrains = options.maxDrains ?? 128;
  if (!Number.isSafeInteger(maxDrains) || maxDrains < 1) {
    throw new RangeError("Invalid operation drain capacity.");
  }
  const maxOutstandingDrains = options.maxOutstandingDrains ?? 128;
  const maxConcurrentChecks = options.maxConcurrentChecks ?? 32;
  const drainTimeoutMs = options.drainTimeoutMs ?? 30_000;
  for (
    const value of [maxOutstandingDrains, maxConcurrentChecks, drainTimeoutMs]
  ) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new RangeError("Invalid settlement capacity or timeout.");
    }
  }
  if (drainTimeoutMs > 2_147_483_647) {
    throw new RangeError("Settlement timeout exceeds the timer range.");
  }
  let activeChecks = 0;
  type DrainEntry = {
    target: OperationSettlementScope;
    promise: Promise<boolean>;
    settled: boolean;
    terminalized: boolean;
  };
  const drains = new Map<string, DrainEntry>();
  function drainOnce(
    target: OperationSettlementScope,
    ref: OwnerSettlementDrain,
    epoch: number,
  ): Promise<boolean> {
    const key = JSON.stringify([
      target.namespace,
      target.operationId,
      epoch,
      ref.deliveryId,
      ref.dispatchAttemptId,
    ]);
    const existing = drains.get(key);
    if (existing) return existing.promise;
    if (drains.size >= maxOutstandingDrains) {
      throw Object.assign(
        new Error("Operation output drain capacity is occupied."),
        { code: "owner_admission_refused" },
      );
    }
    const entry: DrainEntry = {
      target: { ...target },
      settled: false,
      terminalized: false,
      promise: Promise.resolve(false),
    };
    // Caller cancellation detaches its wait, not another caller's shared relay.
    // The host must independently fence its transport/attempt throughout drain.
    entry.promise = Promise.resolve().then(() =>
      drain({ ...target }, { ...ref }, { epoch })
    ).then((success) => {
      entry.settled = true;
      if (entry.terminalized) drains.delete(key);
      return success;
    }, (error) => {
      entry.settled = true;
      // A rejection can follow partial/ambiguous relay progress. Retain its
      // tombstone until authoritative scope settlement, never blindly flush again.
      if (entry.terminalized) drains.delete(key);
      throw error;
    });
    void entry.promise.catch(() => {});
    drains.set(key, entry);
    return entry.promise;
  }
  function releaseSettled(target: OperationSettlementScope) {
    for (const [key, entry] of drains) {
      if (
        entry.target.namespace !== target.namespace ||
        entry.target.operationId !== target.operationId
      ) continue;
      entry.terminalized = true;
      if (entry.settled) drains.delete(key);
    }
  }
  async function waitForSignal<T>(
    promise: Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    signal.throwIfAborted();
    let abort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      return await Promise.race([promise, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  const tables = ownerTableNames(schema);
  const core = createCoreTableNames(schema);
  const authorized = new WeakMap<
    SqlExecutor,
    { kind: string; target: OperationSettlementScope }
  >();
  function bound(tx: SqlExecutor, kind: string): OperationSettlementScope {
    const current = authorized.get(tx);
    if (!current || current.kind !== kind) {
      refuse("Settlement requires current boundary authorization.");
    }
    return current.target;
  }
  async function currentDrains(
    tx: SqlExecutor,
    caller: OwnerCaller,
    current: OperationSettlementSnapshot,
    time: string,
  ) {
    // A failed sibling does not discard another successful current attempt's
    // final output. Eligibility belongs to each attempt, not the scope outcome.
    const refs = drainReferences(
      await selectDrains(tx, structuredClone(caller), {
        namespace: current.namespace,
        operationId: current.operationId,
      }, time),
      maxDrains,
    );
    for (const ref of refs) {
      const success = await tx.query(
        `SELECT delivery.id FROM ${core.event_deliveries} AS delivery
         JOIN ${tables.events} AS event ON event.id=delivery.event_id
         WHERE delivery.id=$1 AND delivery.settlement_scope_id=$2 AND event.namespace=$3 AND delivery.status='succeeded'`,
        [ref.deliveryId, current.operationId, current.namespace],
      );
      if (
        !success.rows.length ||
        await authorizeDrain(
            tx,
            structuredClone(caller),
            {
              namespace: current.namespace,
              operationId: current.operationId,
            },
            { ...ref },
            time,
          ) !== true
      ) {
        refuse("Operation output attempt is no longer successful and current.");
      }
    }
    return refs;
  }
  async function fence(context: OwnerCommandContext) {
    const commit = context.ownerCommit;
    if (
      commit.transaction !== context.tx || commit.ownerId !== ownerId ||
      commit.commandTime !== context.commandTime
    ) {
      refuse("Settlement must join its owner command.");
    }
    const current = await context.tx.query(
      `SELECT owner FROM ${tables.epochs} WHERE owner=$1 AND epoch=$2 AND holder=$3 FOR UPDATE`,
      [ownerId, commit.epoch, commit.holderId],
    );
    if (!current.rows.length) {
      refuse("Operation settlement owner is no longer current.");
    }
  }
  async function schedule(
    context: OwnerCommandContext,
    input: OperationSettlementScope,
  ): Promise<void> {
    const target = scope(input);
    await fence(context);
    const current = await readOperationSettlement(
      context.tx,
      schema,
      target,
      contentLifecycle,
    );
    if (!current || !live(current)) return;
    await context.tx.query(
      `INSERT INTO ${tables.alarms}(owner,name,due_at) VALUES($1,$2,$3::timestamptz)
       ON CONFLICT(owner,name) DO UPDATE SET due_at=LEAST(${tables.alarms}.due_at,excluded.due_at)`,
      [
        ownerId,
        ownerOperationSettlementAlarm(target),
        context.commandTime,
      ],
    );
    context.afterCommit(() => {
      wake({ ...target });
    });
  }
  const readiness: OwnerProjectionHandler = async (
    _input,
    context,
  ): Promise<OwnerJson> => {
    const target = bound(context.tx, OWNER_OPERATION_READINESS);
    const current = await readOperationSettlement(
      context.tx,
      schema,
      target,
      contentLifecycle,
    );
    if (!current) return { status: "missing" };
    if (live(current) && !current.ready) return { status: "pending" };
    return {
      status: "ready",
      ticket: {
        ...target,
        epoch: context.caller.ownerEpoch,
        nextEventOrdinal: current.nextEventOrdinal,
        nextStreamOrdinal: current.nextStreamOrdinal,
        drains: live(current)
          ? await currentDrains(
            context.tx,
            context.caller,
            current,
            context.commandTime,
          )
          : [],
      },
    };
  };
  const terminalize: OwnerCommandHandler = async (
    input,
    context,
  ): Promise<OwnerJson> => {
    const target = bound(context.tx, OWNER_OPERATION_SETTLEMENT);
    await fence(context);
    const data = object(input, ["occurrence", "ticket"]);
    const expected = ticket(data.ticket, maxDrains);
    if (expected.epoch !== context.ownerCommit.epoch) {
      refuse("Settlement drain belongs to a retired owner epoch.");
    }
    let emitted = false;
    const current = await terminalizeOperationSettlement(
      context.tx,
      schema,
      target,
      {
        commandTime: context.commandTime,
        contentLifecycle,
        expected,
        async beforeTerminal(snapshot) {
          const refs = await currentDrains(
            context.tx,
            context.caller,
            snapshot,
            context.commandTime,
          );
          if (
            JSON.stringify(refs) !== JSON.stringify(expected.drains)
          ) {
            refuse("Operation output reservations changed during drain.");
          }
          const store = createEventStore({
            session: session,
            schema: schema,
            ownerCommit: {
              ...context.ownerCommit,
              afterCommit: context.afterCommit,
            },
            assertOperationCatalog: catalog.assertFormat,
            admitOperationEventSql: (value, param) =>
              catalog.admitEventSql(value, param),
            indexOperationEventSql: (value, param) =>
              catalog.indexEventSql(value, param),
            indexOperationEvent: (tx, value) => catalog.indexEvent(tx, value),
          });
          const result = await store.commitMutation({
            transaction: context.tx,
            admission: { cancellation: snapshot.outcome === "cancelled" },
            draft: {
              type: OWNER_OPERATION_SETTLED_EVENT,
              namespace: target.namespace,
              subject: { type: "operation", id: target.operationId },
              payload: {
                operationId: target.operationId,
                state: snapshot.outcome,
              },
              causationId: snapshot.rootEventId,
              correlationId: snapshot.correlationId,
              settlementScopeId: target.operationId,
              deduplicationId: JSON.stringify([
                OWNER_OPERATION_SETTLED_EVENT,
                ownerId,
                target.namespace,
                target.operationId,
              ]),
            },
            consumers: [],
          });
          if (result.deduplicated) {
            throw new Error(
              "A live operation already has a settlement event.",
            );
          }
          emitted = true;
          context.afterCommit(async () => {
            store.confirmCommitted?.(result.event.id);
            await publishCommittedOperationSettlement(
              session,
              schema,
              snapshot,
            );
            await publish?.(result.event, {
              databaseSchema: schema,
              settlementScopeId: target.operationId,
            });
          });
        },
      },
    );
    if (!current || !live(current)) {
      await context.tx.query(
        `DELETE FROM ${tables.alarms} WHERE owner=$1 AND name=$2`,
        [ownerId, ownerOperationSettlementAlarm(target)],
      );
      return current
        ? { status: "terminal", state: current.state }
        : { status: "missing" };
    }
    if (emitted) {
      throw new Error("Settlement did not commit its terminal state.");
    }
    // New work may have both entered and finished during the drain; its counters
    // force a fresh projection and output drain, not a cached readiness receipt.
    return { status: "pending" };
  };
  return {
    handlers: { [OWNER_OPERATION_SETTLEMENT]: terminalize } as Readonly<
      Record<string, OwnerCommandHandler>
    >,
    projections: { [OWNER_OPERATION_READINESS]: readiness } as Readonly<
      Record<string, OwnerProjectionHandler>
    >,
    schedule,
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      commandTime: string,
    ) {
      if (caller.principal.kind !== "owner-control") {
        refuse("Operation settlement requires owner control.");
      }
      const kind = command.kind;
      let target: OperationSettlementScope;
      if (kind === OWNER_OPERATION_READINESS) {
        target = scope(command.intent);
      } else if (kind === OWNER_OPERATION_SETTLEMENT) {
        const data = object(command.intent, ["occurrence", "ticket"]);
        text(data.occurrence);
        const plan = ticket(data.ticket, maxDrains);
        target = scope({
          namespace: plan.namespace,
          operationId: plan.operationId,
        });
        if (
          command.domain !== "occurrence" ||
          command.key !==
            ownerOperationSettlementKey(
              ownerId,
              target,
              data.occurrence,
            )
        ) {
          refuse("Settlement occurrence identity does not match.");
        }
      } else throw new TypeError("Unknown operation settlement command.");
      if (
        await authorizeControl(
          tx,
          structuredClone(caller),
          { ...target },
          commandTime,
        ) !== true
      ) refuse("Operation settlement control authority was revoked.");
      authorized.set(tx, { kind, target });
    },
    /** One bounded check, invoked by host scheduling/alarm work. A failed drain or
     * pending check keeps its durable alarm. The next check needs a new occurrence.
     * Receipts remain recoverable on unknown commit; this method never retries it. */
    async run(
      input: Readonly<
        {
          boundary: Pick<OwnerCommandBoundary, "project" | "execute">;
          caller: OwnerCaller;
          target: OperationSettlementScope;
          occurrence: string;
          signal?: AbortSignal;
        }
      >,
    ): Promise<OwnerJson> {
      const target = scope(input.target);
      const occurrence = input.occurrence;
      text(occurrence);
      const caller = structuredClone(input.caller);
      const boundary = input.boundary;
      const project = boundary.project.bind(boundary);
      const execute = boundary.execute.bind(boundary);
      const callerSignal = input.signal;
      const commandKey = ownerOperationSettlementKey(
        ownerId,
        target,
        occurrence,
      );
      if (activeChecks >= maxConcurrentChecks) {
        throw Object.assign(
          new Error("Operation settlement check capacity is occupied."),
          { code: "owner_admission_refused" },
        );
      }
      activeChecks++;
      const deadline = new AbortController();
      const timer = setTimeout(
        () =>
          deadline.abort(
            Object.assign(new Error("Operation settlement check timed out."), {
              code: "owner_settlement_timeout",
            }),
          ),
        drainTimeoutMs,
      );
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, deadline.signal])
        : deadline.signal;
      let submitted = false;
      const task = (async (): Promise<OwnerJson> => {
        try {
          signal.throwIfAborted();
          const prepared = await project(
            structuredClone(caller),
            OWNER_OPERATION_READINESS,
            { ...target },
            { signal },
          ) as Prepared;
          signal.throwIfAborted();
          if (prepared.status !== "ready") return prepared;
          const plan = ticket(prepared.ticket, maxDrains);
          for (const ref of plan.drains) {
            signal.throwIfAborted();
            if (
              !await waitForSignal(drainOnce(target, ref, plan.epoch), signal)
            ) {
              refuse("Operation output drain lost its current attempt.");
            }
          }
          signal.throwIfAborted();
          submitted = true;
          const result = (await execute(structuredClone(caller), {
            kind: OWNER_OPERATION_SETTLEMENT,
            domain: "occurrence",
            key: commandKey,
            intent: { occurrence, ticket: plan },
          }, { signal })).result;
          if ((result as { status?: unknown })?.status === "terminal") {
            releaseSettled(target);
          }
          return result;
        } finally {
          // A noncooperative projection/COMMIT keeps its check slot charged,
          // even after the caller's bounded wait has stopped.
          activeChecks--;
        }
      })();
      void task.catch(() => {});
      try {
        return await waitForSignal(task, signal);
      } catch (error) {
        if (signal.aborted && submitted) {
          throw Object.assign(
            new Error(
              "Operation settlement outcome is unknown; resolve its receipt before another check.",
              { cause: error },
            ),
            {
              code: "owner_settlement_unknown",
              indeterminate: true,
              commandKey,
            },
          );
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
