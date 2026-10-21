import { encodeJsonValue } from "../json.ts";
import {
  isOwnerAuthorizationRefusal,
  markOwnerAuthorizationRefusal,
} from "./authorization-refusal.ts";
import {
  createAsyncContextStorage,
  runIndependentAsyncContext,
} from "../../dependencies/async-hooks.ts";
import {
  authorizeOwnerCommand,
  captureOwnerCommandAuthorization,
  type OwnerCommandAuthorization,
  withOwnerCommandAuthorization,
} from "./command-authorization.ts";
import {
  createOwnerAlarmDriver,
  type OwnerAlarmScheduler,
  type OwnerAlarmSource,
} from "./alarms.ts";
import {
  createCoreTableNames,
  provisionCopilotzSchema,
} from "../events/schema.ts";
import {
  afterSqlCommit,
  afterSqlSettlement,
  bindSqlTransactionAlias,
  runSqlCommandScope,
  runSqlTransaction,
  sqlCommitGate,
  type SqlExecutor,
  type SqlSession,
} from "../events/session.ts";

export type CommandJson =
  | null
  | boolean
  | number
  | string
  | readonly CommandJson[]
  | { readonly [key: string]: CommandJson };

export type CommandIdentity = Readonly<{
  domain: "logical" | "incarnation" | "occurrence";
  key: string;
}>;

/** Authority is supplied by the host, separately from replay identity. */
export type CommandCaller = Readonly<{
  principal: string;
  epoch: number;
  /** Authenticated physical caller; separate from the logical invocation principal. */
  receiptReader?: string;
}>;
export type CommandContext = Readonly<{
  transaction: SqlExecutor;
  authorizationGuards: Set<OwnerCommandAuthorization>;
  caller: CommandCaller;
  commandTime: string;
  signal: AbortSignal;
  afterCommit(callback: () => void | Promise<void>): void;
}>;
export type CommandDefinition<Input, Output> = Readonly<{
  authorize(input: Input, context: CommandContext): void | Promise<void>;
  authorizeResult?(input: Input, context: CommandContext): void | Promise<void>;
  execute(input: Input, context: CommandContext): Output | Promise<Output>;
}>;
export type CommandTypes = Record<string, { input: unknown; output: unknown }>;
export type CommandDefinitions<T extends CommandTypes> = {
  readonly [K in keyof T]: CommandDefinition<T[K]["input"], T[K]["output"]>;
};
export type CommandRequest<Input> = Readonly<{
  input: Input;
  /** Durable replay is requested explicitly by trusted command registrations. */
  receipt?: Readonly<{ identity: CommandIdentity; intent: CommandJson }>;
}>;

const executingCommand = /* @__PURE__ */ createAsyncContextStorage<
  CommandContext
>();
/** Capabilities with external effects cannot join an owner transaction. */
export const currentOwnerCommand = () => executingCommand.getStore();

/** Join an already attached local owner through its durable database identity. */
export async function attachedDatabaseOwner(
  transaction: SqlExecutor,
  schema: string,
): Promise<DatabaseOwner> {
  const row =
    (await transaction.query<{ epoch: number | string; holder: string }>(
      `UPDATE "${schema}".owner_epochs SET holder=holder WHERE owner='schema' RETURNING epoch,holder`,
    )).rows[0];
  const owner = row && localOwners.get(row.holder)?.deref()?.owner;
  if (
    !owner || owner.state === "stopped" || owner.epoch !== Number(row.epoch)
  ) {
    throw new Error("Directory owner is not attached to this database.");
  }
  owner.signal.throwIfAborted();
  return owner;
}

type JoinOwner = <T>(
  source: CommandContext,
  execute: (command: CommandContext) => Promise<T>,
) => Promise<T>;
const ownerJoins = new WeakMap<DatabaseOwner, JoinOwner>();
/** Private owner-to-owner admission. The destination creates its own real context. */
export async function joinDatabaseOwnerCommand<T>(
  source: CommandContext,
  owner: DatabaseOwner,
  execute: (command: CommandContext) => Promise<T>,
): Promise<T> {
  assertCommandTransaction(source.transaction);
  const join = ownerJoins.get(owner);
  if (!join) throw new Error("Destination owner cannot join commands.");
  return await join(source, execute);
}

function failure(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code });
}

function canonical(value: CommandJson): string {
  return encodeJsonValue(value, { label: "Command receipts" });
}

/** Detach command data while retaining local publication promises/capabilities. */
function captureCommandData<T>(value: T): T {
  if (Array.isArray(value)) return value.map(captureCommandData) as T;
  if (value instanceof Uint8Array) return value.slice() as T;
  if (value instanceof Date) return new Date(value) as T;
  if (value instanceof Error) {
    const captured = Object.assign(
      structuredClone(value),
      captureCommandData({ ...value }),
    );
    // Owner classifications are private identity, never inferred from fields.
    return isOwnerAuthorizationRefusal(value)
      ? markOwnerAuthorizationRefusal(captured)
      : captured;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype === Object.prototype || prototype === null) {
      // Spread defines data properties (including __proto__) without setters.
      const captured = { ...value } as Record<string, unknown>;
      for (const key of Object.keys(captured)) {
        captured[key] = captureCommandData(captured[key]);
      }
      return captured as T;
    }
  }
  return value;
}

// Schema runners capture synchronously, before awaiting owner acquisition.
const capturedInput = Symbol("captured-command-input");

type Pending = {
  bytes: number;
  run(transaction: SqlExecutor, joined?: CommandContext): Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
};

/** Typed local owner surface used by package composition and registered handlers. */
export type OwnerCommands<T extends CommandTypes> = Readonly<{
  state: "unacquired" | "acquiring" | "acquired" | "ready" | "stopped";
  epoch: number | undefined;
  ownerId: string;
  holderId: string;
  signal: AbortSignal;
  stopped: Promise<void>;
  ready: Promise<void>;
  acquire(expectedEpoch: number): Promise<number>;
  execute<K extends keyof T & string>(
    kind: K,
    caller: CommandCaller,
    request: CommandRequest<T[K]["input"]>,
  ): Promise<T[K]["output"]>;
  register<Input, Output>(
    kind: string,
    handler: CommandDefinition<Input, Output>,
  ): (caller: CommandCaller, request: CommandRequest<Input>) => Promise<Output>;
  registerAlarmSource(source: OwnerAlarmSource): () => void;
  rearmAlarms(): Promise<void>;
  wakeAlarms(): Promise<void>;
  pauseAlarms(): void;
  drainAlarms(): Promise<void>;
  activate(): void;
  /** Wait for admitted commands and all committed publications. */
  drain(): Promise<void>;
  /** Retain asynchronous work started by a synchronous SQL commit observer. */
  trackPublication(callback: () => Promise<void>): void;
  /** Graceful final attachment shutdown. */
  close(): Promise<void>;
  stop(error?: unknown): void;
}>;

/** One database-schema owner. Only registered local handlers receive SQL authority. */
export function createOwnerCommands<T extends CommandTypes>(options: {
  session: SqlSession;
  schema: string;
  handlers: CommandDefinitions<T>;
  ownerId?: string;
  holderId?: string;
  maxQueue?: number;
  maxGroupCount?: number;
  /** Coalescing budget; an oversized input runs alone. */
  maxGroupBytes?: number;
  maxPublications?: number;
  now?: () => Date;
  alarmScheduler?: OwnerAlarmScheduler;
  onPublicationError?: (error: unknown) => void;
}): OwnerCommands<T> {
  const tables = createCoreTableNames(options.schema);
  const owner = options.ownerId ?? "schema";
  const holder = options.holderId ?? crypto.randomUUID();
  const capacity = options.maxQueue ?? 1024;
  const groupCount = options.maxGroupCount ?? 32;
  const groupBytes = options.maxGroupBytes ?? 1024 * 1024;
  const commandStorage = createAsyncContextStorage<CommandContext>();
  const activeCommand = {
    getStore: () => commandStorage.getStore(),
    run: <T>(context: CommandContext, run: () => T): Promise<Awaited<T>> =>
      commandStorage.run(context, () => executingCommand.run(context, run)),
  };
  const publicationCapacity = options.maxPublications ?? 1024;
  if (
    !Number.isSafeInteger(groupCount) || groupCount < 1 ||
    !Number.isSafeInteger(groupBytes) || groupBytes < 1 ||
    !Number.isSafeInteger(capacity) || capacity < 1 ||
    !Number.isSafeInteger(publicationCapacity) || publicationCapacity < 1
  ) {
    throw new TypeError("Owner queue capacities must be positive integers.");
  }
  let state: "unacquired" | "acquiring" | "acquired" | "ready" | "stopped" =
    "unacquired";
  let epoch: number | undefined;
  let reason: unknown;
  let running = false;
  let acquiring = false;
  let inFlight = 0;
  let joinedInFlight = 0;
  let stagedPublications = 0;
  let joinedPublications = 0;
  let publishing = false;
  let publicationCount = 0;
  let idle = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  const publicationErrors: unknown[] = [];
  const isIdle = () =>
    !acquiring && !running && !publishing && publicationCount === 0 &&
    joinedInFlight === 0;
  function signalIdle() {
    if (isIdle()) {
      idle.resolve();
      idle = Promise.withResolvers<void>();
    }
  }
  async function waitIdle(): Promise<void> {
    while (!isIdle()) await idle.promise;
  }
  async function drainWork(): Promise<void> {
    await waitIdle();
    if (publicationErrors.length) {
      throw new AggregateError(
        publicationErrors.splice(0),
        "Owner publication failed.",
      );
    }
  }
  const pending: Pending[] = [];
  const publications: Array<Array<() => void | Promise<void>>> = [];
  const lifetime = new AbortController();
  const stopped = Promise.withResolvers<void>();
  const readiness = Promise.withResolvers<void>();
  // Admission may not yet be waiting when acquisition fails.
  void readiness.promise.catch(() => undefined);

  const alarms = createOwnerAlarmDriver({
    session: options.session,
    schema: options.schema,
    owner,
    now: options.now ?? (() => new Date()),
    ready: () => state === "ready",
    stopped: () => state === "stopped",
    fail: (error) => stop(error),
    scheduler: options.alarmScheduler,
  });

  function stop(
    error: unknown = failure("owner_stopped", "The database owner stopped."),
  ) {
    if (state === "stopped") return;
    state = "stopped";
    try {
      alarms.cancel();
    } catch { /* Cancellation must not skip authority invalidation. */ }
    reason = error;
    lifetime.abort(error);
    readiness.reject(error);
    for (const item of pending.splice(0)) item.reject(error);
    // Authority is revoked synchronously; completion includes all SQL and output
    // work already admitted. The signal is the immediate invalidation boundary.
    void Promise.allSettled([waitIdle(), alarms.drain()]).then(() =>
      stopped.resolve()
    );
  }
  function assertAcquired() {
    if (state !== "acquired" && state !== "ready") {
      throw reason ??
        failure("owner_not_acquired", "The database owner is not acquired.");
    }
  }
  function runPublication(callback: () => void | Promise<void>): void {
    void runIndependentAsyncContext(callback).catch((error) => {
      publicationErrors.push(error);
      try {
        options.onPublicationError?.(error);
      } catch { /* observer only */ }
    }).finally(() => {
      publicationCount--;
      signalIdle();
    });
  }
  function publish() {
    // Invoke in commit order, but do not serialize completion: a callback can
    // await another command's publication. Both remain charged until complete.
    for (const batch of publications.splice(0)) {
      for (const callback of batch) runPublication(callback);
    }
    publishing = false;
    signalIdle();
  }
  async function runGroup(group: Pending[]): Promise<void> {
    if (state === "stopped") {
      for (const item of group) item.reject(reason);
      return;
    }
    let callbackFinished = false;
    let rollbackConfirmed = false;
    stagedPublications = 0;
    try {
      const outcomes = await runSqlTransaction(
        options.session,
        async (outer) => {
          try {
            // First statement, once per group: takeover waits on this row lock.
            const fence = await outer.query(
              `UPDATE ${tables.owner_epochs} SET holder=holder WHERE owner=$1 AND epoch=$2 AND holder=$3 RETURNING epoch`,
              [owner, epoch, holder],
            );
            if (!fence.rows.length) {
              const error = failure(
                "ActionOwnershipLost",
                "The owner epoch or holder is no longer current.",
              );
              stop(error);
              throw error;
            }
            assertAcquired();
            const outcomes = [];
            for (const item of group) {
              assertAcquired();
              const before = stagedPublications;
              const outcome = await runIndependentAsyncContext(() =>
                runSqlCommandScope(
                  outer,
                  (tx) => item.run(tx),
                  group.length > 1,
                )
              );
              if (!outcome.ok) {
                stagedPublications = before;
              }
              outcomes.push(outcome);
            }
            callbackFinished = true;
            return outcomes;
          } catch (error) {
            // A05: the adapter may hide failed rollback cleanup behind the original
            // error. Only this acknowledged ROLLBACK on the pinned executor proves
            // the group had no effect. Failed cleanup still stops the owner.
            // AND CHAIN retains the adapter's pinned lane for its own final
            // cleanup; a plain ROLLBACK releases it too early on PostgreSQL.
            // The replacement transaction is empty and receives no callbacks.
            await outer.query("ROLLBACK AND CHAIN");
            rollbackConfirmed = true;
            throw error;
          }
        },
      );
      assertAcquired();
      for (let i = 0; i < group.length; i++) {
        const outcome = outcomes[i];
        if (outcome.ok) group[i].resolve(outcome.value);
        else group[i].reject(outcome.error);
      }
    } catch (error) {
      if (rollbackConfirmed && !lifetime.signal.aborted) {
        if (group.length > 1) {
          // No speculative result or callback survives an outer rollback.
          // Retry each command separately, in its original queue position.
          for (const item of group) await runGroup([item]);
        } else group[0].reject(error);
      } else {
        stop(
          callbackFinished
            ? failure(
              "owner_commit_unknown",
              "The command commit outcome is unknown.",
              error,
            )
            : error,
        );
        for (const item of group) item.reject(reason);
      }
    } finally {
      stagedPublications = 0;
    }
  }

  async function drain() {
    try {
      while (pending.length && state !== "stopped") {
        let count = 1;
        let bytes = pending[0].bytes;
        while (
          count < pending.length && count < groupCount &&
          bytes + pending[count].bytes <= groupBytes
        ) {
          bytes += pending[count++].bytes;
        }
        const group = pending.splice(0, count);
        inFlight = group.length;
        await runIndependentAsyncContext(() => runGroup(group));
        inFlight = 0;
      }
    } finally {
      inFlight = 0;
      running = false;
      signalIdle();
    }
  }

  async function acquire(expectedEpoch: number): Promise<number> {
    if (state !== "unacquired") {
      throw failure(
        "owner_already_acquired",
        "Owner acquisition is single-use.",
      );
    }
    if (!Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) {
      throw new TypeError("Invalid expected owner epoch.");
    }
    state = "acquiring";
    acquiring = true;
    let callbackFinished = false;
    try {
      const acquired = await runSqlTransaction(options.session, async (tx) => {
        await tx.query(
          `INSERT INTO ${tables.owner_epochs} (owner,epoch,holder) VALUES ($1,0,'') ON CONFLICT DO NOTHING`,
          [owner],
        );
        const result = await tx.query<{ epoch: string | number }>(
          `UPDATE ${tables.owner_epochs} SET epoch=epoch+1, holder=$3 WHERE owner=$1 AND epoch=$2 RETURNING epoch`,
          [owner, expectedEpoch, holder],
        );
        if (!result.rows.length) {
          throw failure(
            "owner_acquisition_conflict",
            "Another owner acquired this database schema.",
          );
        }
        const value = Number(result.rows[0].epoch);
        if (!Number.isSafeInteger(value)) {
          throw new RangeError("Owner epoch exceeds the safe integer range.");
        }
        callbackFinished = true;
        return value;
      });
      if (state as string === "stopped") throw reason;
      epoch = acquired;
      state = "acquired";
      return acquired;
    } catch (error) {
      stop(
        callbackFinished
          ? failure(
            "owner_commit_unknown",
            "Owner acquisition commit is unknown.",
            error,
          )
          : error,
      );
      throw reason;
    } finally {
      acquiring = false;
      signalIdle();
    }
  }

  function submit<Input, Output>(
    kind: string,
    caller: CommandCaller,
    request: CommandRequest<Input> & { [capturedInput]?: true },
    handler: CommandDefinition<Input, Output>,
    adopted?: CommandContext,
  ): Promise<Output> {
    const joined = activeCommand.getStore();
    try {
      assertAcquired();
      if (joined) sqlCommitGate(joined.transaction);
      if (!joined && pending.length + inFlight >= capacity) {
        throw failure("owner_queue_full", "The owner command queue is full.");
      }
      if (caller.epoch !== epoch || !caller.principal) {
        throw failure(
          "ActionOwnershipLost",
          "Command authority belongs to another owner epoch.",
        );
      }
    } catch (error) {
      return Promise.reject(error);
    }
    const completion = Promise.withResolvers<Output>();
    const receipt = request.receipt && {
      identity: { ...request.receipt.identity },
      intent: canonical(request.receipt.intent),
    };
    // Receipt intent is not generally the input. Reuse its canonical capture
    // when it is; otherwise detach data, including local byte-buffer commands.
    const admittedInput: Input = request[capturedInput]
      ? request.input
      : receipt && request.receipt!.intent === request.input
      ? JSON.parse(receipt.intent)
      : captureCommandData(request.input);
    const inputView = (): Input => captureCommandData(admittedInput);
    const binding = { ...caller };
    const item: Pending = {
      bytes: 0,
      resolve: (value) => completion.resolve(value as Output),
      reject: completion.reject,
      async run(tx, joined) {
        const callbacks: Array<() => void | Promise<void>> = [];
        const finalizers: Array<() => Promise<void>> = [];
        const commandTime = joined?.commandTime ?? adopted?.commandTime ??
          (options.now?.() ?? new Date())
            .toISOString();
        const context: CommandContext = {
          transaction: tx,
          authorizationGuards: joined?.authorizationGuards ?? new Set(),
          caller: binding,
          commandTime,
          signal: lifetime.signal,
          afterCommit(callback) {
            if (joined) return joined.afterCommit(callback);
            assertAcquired();
            sqlCommitGate(tx);
            if (
              publicationCount + stagedPublications + joinedPublications >=
                publicationCapacity
            ) {
              throw failure(
                "owner_publication_queue_full",
                "The owner publication queue is full.",
              );
            }
            callbacks.push(callback);
            if (!adopted) stagedPublications++;
            else {
              joinedPublications++;
              afterSqlSettlement(tx, () => {
                joinedPublications--;
              });
            }
          },
        };
        if (!joined) {
          commandContexts.set(tx, {
            schema: options.schema,
            ownerId: owner,
            holderId: holder,
            context,
            finalizers,
          });
        }
        return await activeCommand.run(context, async () => {
          // Authority is checked even when returning a durable duplicate.
          await handler.authorize(inputView(), context);
          assertAcquired();
          if (receipt) {
            const existing = (await tx.query<{
              principal: string;
              kind: string;
              intent: CommandJson;
              result: CommandJson;
              readers: string[];
            }>(
              `SELECT principal,kind,intent,result,readers FROM ${tables.owner_receipts} WHERE owner=$1 AND domain=$2 AND key=$3`,
              [owner, receipt.identity.domain, receipt.identity.key],
            )).rows[0];
            if (existing) {
              if (
                existing.principal !== binding.principal ||
                existing.kind !== kind ||
                canonical(existing.intent) !== receipt.intent
              ) {
                throw failure(
                  "owner_intent_conflict",
                  "The command identity is bound to another principal, kind or intent.",
                );
              }

              await handler.authorizeResult?.(inputView(), context);
              assertAcquired();
              // Recovery rights become durable with the same outer commit
              // as this currently authorized replay, never on admission.
              if (
                !existing.readers.includes(
                  binding.receiptReader ?? binding.principal,
                )
              ) {
                await tx.query(
                  `UPDATE ${tables.owner_receipts} SET readers=array_append(readers,$4) WHERE owner=$1 AND domain=$2 AND key=$3 AND NOT ($4=ANY(readers))`,
                  [
                    owner,
                    receipt.identity.domain,
                    receipt.identity.key,
                    binding.receiptReader ?? binding.principal,
                  ],
                );
              }
              return existing.result as Output;
            }
          }
          if (adopted) {
            afterCommandAuthorization(adopted.transaction, async () => {
              assertAcquired();
              await authorizeOwnerCommand(undefined, context, "result");
            });
          }
          const produced = await handler.execute(inputView(), context);
          const outputText = receipt
            ? canonical(produced as CommandJson)
            : undefined;
          const output: Output = outputText === undefined
            ? captureCommandData(produced)
            : JSON.parse(outputText);
          await handler.authorizeResult?.(inputView(), context);
          assertAcquired();
          for (const finalize of finalizers) await finalize();
          const nextAlarm = await alarms.refresh(tx, commandTime);
          if (receipt) {
            await tx.query(
              `INSERT INTO ${tables.owner_receipts} (owner,domain,key,principal,kind,intent,result,readers) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,ARRAY[$8]::text[])`,
              [
                owner,
                receipt.identity.domain,
                receipt.identity.key,
                binding.principal,
                kind,
                receipt.intent,
                outputText,
                binding.receiptReader ?? binding.principal,
              ],
            );
          }

          afterSqlCommit(tx, () => {
            alarms.committed(nextAlarm);
            publicationCount += callbacks.length;
            if (callbacks.length) publications.push(callbacks);
            if (!publishing && publications.length) {
              publishing = true;
              queueMicrotask(() => {
                void publish();
              });
            }
          });
          return output;
        });
      },
    };
    // Joined calls use the active command's revocable facade and output gate.
    // They cannot wait on the queue whose current command is awaiting them.
    if (adopted) {
      const transaction: SqlExecutor = {
        query: (sql, params) => adopted.transaction.query(sql, params),
      };
      bindSqlTransactionAlias(transaction, adopted.transaction);
      joinedInFlight++;
      afterSqlSettlement(transaction, () => {
        joinedInFlight--;
        signalIdle();
      });
      return item.run(transaction) as Promise<Output>;
    }
    if (joined) return item.run(joined.transaction, joined) as Promise<Output>;
    try {
      item.bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
    } catch {
      // Local registrations can carry opaque inputs. Do not coalesce them.
      item.bytes = groupBytes;
    }
    pending.push(item);
    if (!running) {
      running = true;
      queueMicrotask(() => {
        void drain();
      });
    }
    return completion.promise;
  }

  const result: OwnerCommands<T> = {
    get state() {
      return state;
    },
    get epoch() {
      return epoch;
    },
    ownerId: owner,
    holderId: holder,
    signal: lifetime.signal,
    stopped: stopped.promise,
    ready: readiness.promise,
    acquire,
    execute<K extends keyof T & string>(
      kind: K,
      caller: CommandCaller,
      request: CommandRequest<T[K]["input"]>,
    ): Promise<T[K]["output"]> {
      if (!Object.hasOwn(options.handlers, kind)) {
        return Promise.reject(
          new TypeError(`Unknown owner command '${kind}'.`),
        );
      }
      return submit(kind, caller, request, options.handlers[kind]);
    },
    /** Core modules register handlers locally; command callers supply only data. */
    register<Input, Output>(
      kind: string,
      handler: CommandDefinition<Input, Output>,
    ) {
      return (caller: CommandCaller, request: CommandRequest<Input>) =>
        submit(kind, caller, request, handler);
    },
    registerAlarmSource(source: OwnerAlarmSource) {
      return alarms.register(source);
    },
    rearmAlarms: alarms.rearm,
    wakeAlarms: alarms.wake,
    pauseAlarms: alarms.pause,
    drainAlarms: alarms.drain,
    /** Called only after stale-attempt invalidation and catalog recovery. */
    activate() {
      assertAcquired();
      state = "ready";
      readiness.resolve();
      void alarms.rearm().catch(stop);
    },
    drain: drainWork,
    trackPublication(callback) {
      publicationCount++;
      runPublication(callback);
    },
    close() {
      closing ??= (async () => {
        const errors: unknown[] = [];
        try {
          alarms.pause();
        } catch (error) {
          errors.push(error);
        }
        try {
          await alarms.drain();
        } catch (error) {
          errors.push(error);
        }
        do {
          try {
            await drainWork();
          } catch (error) {
            errors.push(error);
          }
        } while (!isIdle());
        stop();
        await stopped.promise;
        if (errors.length) {
          throw new AggregateError(errors, "Owner shutdown failed.");
        }
      })();
      return closing;
    },
    stop,
  };
  ownerJoins.set(result, (source, execute) =>
    submit(
      "directory.collections",
      { principal: source.caller.principal, epoch: epoch! },
      { input: null },
      {
        authorize() {
          assertAcquired();
        },
        execute: (_, command) => execute(command),
      },
      source,
    ));
  return result;
}

export type DatabaseOwner = OwnerCommands<Record<never, never>>;
type OwnerEntry = {
  owner: DatabaseOwner;
  references: number;
  activation?: Promise<void>;
  closing?: Promise<void>;
};
const localOwners = new Map<string, WeakRef<OwnerEntry>>();
function ownerEntry(owner: DatabaseOwner): OwnerEntry {
  let entry = localOwners.get(owner.holderId)?.deref();
  if (!entry) {
    entry = { owner, references: 1 };
    localOwners.set(owner.holderId, new WeakRef(entry));
  }
  return entry;
}

/** The durable holder row identifies a database/schema across connection objects. */
export async function openDatabaseOwner(
  session: SqlSession,
  schema: string,
  clock: { now?: () => Date; alarmScheduler?: OwnerAlarmScheduler } = {},
): Promise<DatabaseOwner> {
  const tables = createCoreTableNames(schema);
  const observed = await session.query<
    { epoch: string | number; holder: string }
  >(
    `SELECT epoch,holder FROM ${tables.owner_epochs} WHERE owner=$1`,
    ["schema"],
  );
  const row = observed.rows[0];
  const existingEntry = row && localOwners.get(row.holder)?.deref();
  if (existingEntry?.closing) {
    await existingEntry.closing;
    return await openDatabaseOwner(session, schema, clock);
  }
  const existing = existingEntry && existingEntry.owner;
  if (
    existing && existing.state !== "stopped" &&
    existing.epoch === Number(row.epoch)
  ) {
    ownerEntry(existing).references++;
    bindOwner(session, schema, existing);
    return existing;
  }
  const owner = createOwnerCommands({
    session,
    schema,
    handlers: {},
    ...clock,
  });
  await owner.acquire(Number(row?.epoch ?? 0));
  ownerEntry(owner);
  bindOwner(session, schema, owner);
  return owner;
}

/** A shared owner keeps the remaining runtime's alarm handlers alive. */
export function pauseFinalDatabaseOwnerAlarms(owner: DatabaseOwner): void {
  if (ownerEntry(owner).references <= 1) owner.pauseAlarms();
}

/** Scope shutdown releases its attachment; the last attachment stops admission. */
export function releaseDatabaseOwner(owner: DatabaseOwner): Promise<void> {
  const entry = ownerEntry(owner);
  if (entry.closing) return entry.closing;
  if (--entry.references > 0) return Promise.resolve();
  entry.closing = owner.close().finally(() => {
    localOwners.delete(owner.holderId);
  });
  return entry.closing;
}

const schemaOwners = new WeakMap<
  SqlSession,
  Map<string, OwnerEntry | Promise<DatabaseOwner>>
>();
const commandContexts = new WeakMap<SqlExecutor, {
  schema: string;
  ownerId: string;
  holderId: string;
  context: CommandContext;
  finalizers: Array<() => Promise<void>>;
  source?: SqlExecutor;
  assertActive?(): void;
}>();

/** Settle an authorized terminal after result guards, in the same command. */
export function afterCommandAuthorization(
  transaction: SqlExecutor,
  finalize: () => Promise<void>,
): void {
  assertCommandTransaction(transaction);
  commandContexts.get(commandSource(transaction))!.finalizers.push(finalize);
}

/** Repositories retain the owner selected at construction or first admission. */
export function bindSchemaOwner(session: SqlSession, schema: string) {
  let owners = schemaOwners.get(session);
  if (!owners) schemaOwners.set(session, owners = new Map());
  const selected = () => {
    const entry = owners!.get(schema);
    if (entry instanceof Promise) return entry;
    const owner = entry?.owner;
    return owner && owner.state !== "stopped"
      ? Promise.resolve(owner)
      : undefined;
  };
  let acquired = selected();
  return () =>
    acquired ??= selected() ?? (() => {
      const opening = (async () => {
        await provisionCopilotzSchema(session, schema);
        return await openDatabaseOwner(session, schema);
      })();
      owners!.set(schema, opening);
      return opening;
    })();
}

/** Capture once: an old repository never retargets authority to a successor. */
export function createSchemaExecutionAuthority(
  acquire: () => Promise<DatabaseOwner>,
) {
  return async () => {
    const owner = await acquire();
    owner.signal.throwIfAborted();
    return { epoch: owner.epoch!, signal: owner.signal };
  };
}

function bindOwner(
  session: SqlSession,
  schema: string,
  owner: DatabaseOwner,
): void {
  let owners = schemaOwners.get(session);
  if (!owners) schemaOwners.set(session, owners = new Map());
  owners.set(schema, ownerEntry(owner));
}

/** Package-only query handle association; never grants session acquisition. */
export function bindCommandExecutorAlias(
  executor: SqlExecutor,
  transaction: SqlExecutor,
  assertActive: () => void,
): void {
  assertCommandTransaction(transaction);
  const source = commandSource(transaction);
  commandContexts.set(executor, {
    ...commandContexts.get(source)!,
    source,
    assertActive,
  });
}

function commandSource(executor: SqlExecutor): SqlExecutor {
  const command = commandContexts.get(executor);
  command?.assertActive?.();
  return command?.source ?? executor;
}

/** Captures repository authority before any commands are submitted. */
export function createSchemaCommandRunner(
  session: SqlExecutor,
  schema: string,
  owner?: () => Promise<DatabaseOwner>,
) {
  const source = commandSource(session);
  const joined = commandContexts.get(source);
  const sql = session as SqlSession;
  const acquire = joined ? undefined : owner ?? bindSchemaOwner(sql, schema);
  return <Input, Output>(
    kind: string,
    input: Input,
    execute: (
      input: Input,
      context: CommandContext,
    ) => Output | Promise<Output>,
    binding?: Readonly<
      {
        principal: string;
        receiptReader?: string;
        receipt: NonNullable<CommandRequest<Input>["receipt"]>;
        signal: AbortSignal;
      }
    >,
  ): Promise<Output> => {
    const authorization = captureOwnerCommandAuthorization();
    const admittedInput = captureCommandData(input);
    if (joined) {
      assertSchemaCommandTransaction(session, schema);
      // Borrowed helpers keep using the revocable query facade, including if
      // they retain a runner or start another helper while this callback runs.
      const context = source === session ? joined.context : {
        ...joined.context,
        transaction: session,
        afterCommit(callback: () => void | Promise<void>) {
          commandSource(session);
          joined.context.afterCommit(callback);
        },
      };
      return (async () => {
        // Admission and the outer result gate share one transaction identity.
        await authorizeOwnerCommand(authorization, joined.context, "mutation");
        const result = await execute(admittedInput, context);
        return result;
      })();
    }
    if (typeof sql.transaction !== "function") {
      return Promise.reject(
        new TypeError(
          "Owner commands require an atomic SQL session or an active owner transaction.",
        ),
      );
    }
    return (async () => {
      binding?.signal.throwIfAborted();
      const owner = await acquire!();
      const registered = owner.register(kind, {
        authorize: (_input, context) =>
          authorizeOwnerCommand(authorization, context, "mutation"),
        authorizeResult: (_input, context) =>
          authorizeOwnerCommand(authorization, context, "result"),
        execute: (input: Input, context) =>
          authorization
            ? withOwnerCommandAuthorization(
              authorization,
              () => execute(input, context),
            )
            : execute(input, context),
      });
      return await registered({
        principal: binding?.principal ?? "runtime",
        receiptReader: binding?.receiptReader,
        epoch: owner.epoch!,
      }, {
        input: admittedInput,
        [capturedInput]: true,
        ...(binding ? { receipt: binding.receipt } : {}),
      } as CommandRequest<Input>);
    })();
  };
}

export function assertCommandTransaction(transaction: SqlExecutor): void {
  transaction = commandSource(transaction);
  const command = commandContexts.get(transaction);
  if (!command || command.context.signal.aborted) {
    throw failure(
      "owner_transaction_required",
      "A current transaction from this database owner is required.",
    );
  }
  sqlCommitGate(transaction);
}

export function assertSchemaCommandTransaction(
  transaction: SqlExecutor,
  schema: string,
): void {
  transaction = commandSource(transaction);
  const command = commandContexts.get(transaction);
  if (!command || command.schema !== schema || command.context.signal.aborted) {
    throw failure(
      "owner_transaction_required",
      "A current transaction from this database owner is required.",
    );
  }
  sqlCommitGate(transaction);
}

/** One activation per epoch, shared by every context attached to that owner. */
export function activateDatabaseOwner(
  owner: DatabaseOwner,
  recover: () => Promise<void>,
): Promise<void> {
  if (owner.state === "ready") return Promise.resolve();
  const entry = ownerEntry(owner);
  let activation = entry.activation;
  if (!activation) {
    activation = (async () => {
      try {
        await recover();
        owner.activate();
      } catch (error) {
        owner.stop(error);
        throw error;
      }
    })();
    entry.activation = activation;
  }
  return activation;
}

/** Receipt authority deliberately does not require the current mutation epoch. */
export async function readSchemaReceipt(
  session: SqlSession,
  schema: string,
  principal: string,
  input: unknown,
): Promise<boolean> {
  if (!input || typeof input !== "object") return false;
  const request = input as {
    key?: unknown;
    databaseSchema?: unknown;
    intent?: unknown;
  };
  if (
    request.databaseSchema !== schema || typeof request.key !== "string" ||
    !request.key || !principal
  ) return false;
  const tables = createCoreTableNames(schema);
  const result = await session.query<{ kind: string; intent: CommandJson }>(
    `SELECT kind,intent FROM ${tables.owner_receipts} WHERE owner=$1 AND domain=$2 AND key=$3 AND $4=ANY(readers)`,
    ["schema", "logical", request.key, principal],
  );
  const row = result.rows[0];
  return !!row && row.kind === "collections.commit" &&
    canonical(row.intent) === canonical(request.intent as CommandJson);
}

/** Internal repositories share the acquired owner's lifetime and commit boundary. */
export function schemaCommandContext(
  transaction: SqlExecutor,
  schema: string,
): CommandContext {
  transaction = commandSource(transaction);
  assertSchemaCommandTransaction(transaction, schema);
  return commandContexts.get(transaction)!.context;
}
