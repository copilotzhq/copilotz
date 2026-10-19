import { withoutCollectionPolicyInvocation } from "../collections/policy-invocation.ts";
import {
  authorizeOwnerCommand,
  captureOwnerCommandAuthorization,
  type OwnerCommandAuthorization,
  withoutOwnerCommandAuthorization,
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
  runSqlSavepoint,
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

function failure(code: string, message: string, cause?: unknown): Error {
  return Object.assign(new Error(message, { cause }), { code });
}

function canonical(value: CommandJson): string {
  if (
    value === null || typeof value === "boolean" || typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(
        ([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`,
      ).join(",")
    }}`;
  }
  throw new TypeError("Command receipts require finite JSON values.");
}

type Pending = {
  run(): Promise<void>;
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
  readReceipt(
    caller: CommandCaller,
    identity: CommandIdentity,
  ): Promise<
    { kind: string; intent: CommandJson; result: CommandJson } | undefined
  >;
  registerAlarmSource(source: OwnerAlarmSource): () => void;
  rearmAlarms(): Promise<void>;
  wakeAlarms(): Promise<void>;
  pauseAlarms(): void;
  drainAlarms(): Promise<void>;
  activate(): void;
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
  maxPublications?: number;
  now?: () => Date;
  alarmScheduler?: OwnerAlarmScheduler;
  onPublicationError?: (error: unknown) => void;
}): OwnerCommands<T> {
  const tables = createCoreTableNames(options.schema);
  const owner = options.ownerId ?? "schema";
  const holder = options.holderId ?? crypto.randomUUID();
  const capacity = options.maxQueue ?? 1024;
  const publicationCapacity = options.maxPublications ?? 1024;
  if (
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
  let publishing = false;
  let publicationCount = 0;
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
    refreshAfterWake: () =>
      submit("owner.alarm.refresh", { principal: "runtime", epoch: epoch! }, {
        input: {},
      }, {
        authorize() {},
        execute() {},
      }),
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
    stopped.resolve();
  }
  function assertAcquired() {
    if (state !== "acquired" && state !== "ready") {
      throw reason ??
        failure("owner_not_acquired", "The database owner is not acquired.");
    }
  }
  async function publish() {
    try {
      while (publications.length) {
        for (const callback of publications.shift()!) {
          try {
            await withoutCollectionPolicyInvocation(() =>
              withoutOwnerCommandAuthorization(callback)
            );
          } catch (error) {
            try {
              options.onPublicationError?.(error);
            } catch { /* observer only */ }
          } finally {
            publicationCount--;
          }
        }
      }
    } finally {
      publishing = false;
    }
  }
  async function drain() {
    try {
      while (pending.length && state !== "stopped") {
        await withoutCollectionPolicyInvocation(() =>
          withoutOwnerCommandAuthorization(() => pending.shift()!.run())
        );
      }
    } finally {
      running = false;
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
    }
  }

  function submit<Input, Output>(
    kind: string,
    caller: CommandCaller,
    request: CommandRequest<Input>,
    handler: CommandDefinition<Input, Output>,
  ): Promise<Output> {
    try {
      assertAcquired();
      if (pending.length + Number(running) >= capacity) {
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
      intent: JSON.parse(canonical(request.receipt.intent)) as CommandJson,
    };
    const binding = { ...caller };
    pending.push({
      reject: completion.reject,
      async run() {
        let callbackFinished = false;
        let handlerError: unknown;
        let handlerFailed = false;
        const callbacks: Array<() => void | Promise<void>> = [];
        try {
          const result = await runSqlTransaction(
            options.session,
            async (outer) => {
              // This MUST be the first statement: takeover waits on this row lock.
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
              const saved = await runSqlSavepoint(outer, async (tx) => {
                const commandTime = (options.now?.() ?? new Date())
                  .toISOString();
                const context: CommandContext = {
                  transaction: tx,
                  caller: binding,
                  commandTime,
                  signal: lifetime.signal,
                  afterCommit(callback) {
                    assertAcquired();
                    sqlCommitGate(tx);
                    if (
                      publicationCount + callbacks.length >= publicationCapacity
                    ) {
                      throw failure(
                        "owner_publication_queue_full",
                        "The owner publication queue is full.",
                      );
                    }
                    callbacks.push(callback);
                  },
                };
                commandContexts.set(tx, {
                  schema: options.schema,
                  ownerId: owner,
                  holderId: holder,
                  context,
                });
                // Authority is checked even when returning a durable duplicate.
                await handler.authorize(request.input, context);
                assertAcquired();
                if (receipt) {
                  const existing = (await tx.query<{
                    principal: string;
                    kind: string;
                    intent: CommandJson;
                    result: CommandJson;
                  }>(
                    `SELECT principal,kind,intent,result FROM ${tables.owner_receipts} WHERE owner=$1 AND domain=$2 AND key=$3`,
                    [owner, receipt.identity.domain, receipt.identity.key],
                  )).rows[0];
                  if (existing) {
                    if (
                      existing.principal !== binding.principal ||
                      existing.kind !== kind ||
                      canonical(existing.intent) !== canonical(receipt.intent)
                    ) {
                      throw failure(
                        "owner_intent_conflict",
                        "The command identity is bound to another principal, kind or intent.",
                      );
                    }

                    await handler.authorizeResult?.(request.input, context);
                    assertAcquired();
                    // Recovery rights become durable with the same outer commit
                    // as this currently authorized replay, never on admission.
                    await tx.query(
                      `UPDATE ${tables.owner_receipts} SET readers=array_append(readers,$4) WHERE owner=$1 AND domain=$2 AND key=$3 AND NOT ($4=ANY(readers))`,
                      [
                        owner,
                        receipt.identity.domain,
                        receipt.identity.key,
                        binding.receiptReader ?? binding.principal,
                      ],
                    );
                    return existing.result as Output;
                  }
                }
                const output = await handler.execute(request.input, context);
                await handler.authorizeResult?.(request.input, context);
                assertAcquired();
                await alarms.refresh(tx, commandTime);
                if (receipt) {
                  await tx.query(
                    `INSERT INTO ${tables.owner_receipts} (owner,domain,key,principal,kind,intent,result,readers) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,ARRAY[$8]::text[])`,
                    [
                      owner,
                      receipt.identity.domain,
                      receipt.identity.key,
                      binding.principal,
                      kind,
                      canonical(receipt.intent),
                      canonical(output as CommandJson),
                      binding.receiptReader ?? binding.principal,
                    ],
                  );
                }

                afterSqlCommit(tx, () => {
                  void alarms.rearm().catch(stop);
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
              callbackFinished = true;
              if (!saved.ok) {
                handlerError = saved.error;
                handlerFailed = true;
                return undefined as Output;
              }
              return saved.value;
            },
          );
          if (handlerFailed) completion.reject(handlerError);
          else {
            assertAcquired();
            completion.resolve(result);
          }
        } catch (error) {
          // No adapter proof of rollback: even a pre-COMMIT connection failure
          // revokes authority conservatively. Never guess an unknown outcome.
          stop(
            callbackFinished
              ? failure(
                "owner_commit_unknown",
                "The command commit outcome is unknown.",
                error,
              )
              : error,
          );
          completion.reject(reason);
        }
      },
    });
    if (!running) {
      running = true;
      queueMicrotask(() => {
        void drain();
      });
    }
    return completion.promise;
  }

  return {
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
    /** Caller identity is authenticated by the host, independently of its epoch. */
    async readReceipt(caller: CommandCaller, identity: CommandIdentity) {
      if (!caller.principal || !identity.key) {
        throw new TypeError("Receipt principal and key are required.");
      }
      const result = await options.session.query<
        { kind: string; intent: CommandJson; result: CommandJson }
      >(
        `SELECT kind,intent,result FROM ${tables.owner_receipts} WHERE owner=$1 AND domain=$2 AND key=$3 AND principal=$4`,
        [owner, identity.domain, identity.key, caller.principal],
      );
      return result.rows[0];
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
    stop,
  };
}

export type DatabaseOwner = OwnerCommands<Record<never, never>>;
const localOwners = new Map<string, WeakRef<DatabaseOwner>>();
const ownerReferences = new WeakMap<DatabaseOwner, number>();

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
  const existing = row && localOwners.get(row.holder)?.deref();
  if (
    existing && existing.state !== "stopped" &&
    existing.epoch === Number(row.epoch)
  ) {
    ownerReferences.set(existing, (ownerReferences.get(existing) ?? 0) + 1);
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
  localOwners.set(owner.holderId, new WeakRef(owner));
  ownerReferences.set(owner, 1);
  bindOwner(session, schema, owner);
  return owner;
}

/** A shared owner keeps the remaining runtime's alarm handlers alive. */
export function pauseFinalDatabaseOwnerAlarms(owner: DatabaseOwner): void {
  if ((ownerReferences.get(owner) ?? 1) <= 1) owner.pauseAlarms();
}

/** Scope shutdown releases its attachment; the last attachment stops admission. */
export function releaseDatabaseOwner(owner: DatabaseOwner): void {
  const remaining = (ownerReferences.get(owner) ?? 1) - 1;
  ownerReferences.set(owner, remaining);
  if (remaining <= 0) {
    owner.stop();
    localOwners.delete(owner.holderId);
    for (const { session, schema, slot } of ownerSlots.get(owner) ?? []) {
      if (schemaOwners.get(session)?.get(schema) === slot) {
        schemaOwners.get(session)!.delete(schema);
      }
    }
    ownerSlots.delete(owner);
  }
}

type SchemaOwnerSlot = { acquired?: Promise<DatabaseOwner> };
const schemaOwners = new WeakMap<SqlSession, Map<string, SchemaOwnerSlot>>();
const ownerSlots = new WeakMap<
  DatabaseOwner,
  Array<{ session: SqlSession; schema: string; slot: SchemaOwnerSlot }>
>();
const commandContexts = new WeakMap<SqlExecutor, {
  schema: string;
  ownerId: string;
  holderId: string;
  context: CommandContext;
}>();

function ownerSlot(session: SqlSession, schema: string): SchemaOwnerSlot {
  let scopes = schemaOwners.get(session);
  if (!scopes) {
    scopes = new Map();
    schemaOwners.set(session, scopes);
  }
  let slot = scopes.get(schema);
  if (!slot) {
    slot = {};
    scopes.set(schema, slot);
  }
  return slot;
}

/** Registers a data command at a trusted repository's construction boundary. */
function registerCommandOnSlot<Input, Output>(
  session: SqlSession,
  schema: string,
  slot: SchemaOwnerSlot,
  kind: string,
  execute: (input: Input, context: CommandContext) => Output | Promise<Output>,
  authorization?: OwnerCommandAuthorization,
) {
  let registered: ReturnType<DatabaseOwner["register"]> | undefined;
  return async (
    input: Input,
    transaction?: SqlExecutor,
    binding?: Readonly<
      {
        principal: string;
        receiptReader?: string;
        receipt: NonNullable<CommandRequest<Input>["receipt"]>;
        signal: AbortSignal;
      }
    >,
  ): Promise<Output> => {
    binding?.signal.throwIfAborted();
    slot.acquired ??= (async () => {
      await provisionCopilotzSchema(session, schema);
      return await openDatabaseOwner(session, schema);
    })();
    const owner = await slot.acquired;
    if (transaction) {
      const joined = commandContexts.get(transaction);
      if (
        !joined || joined.schema !== schema ||
        joined.holderId !== owner.holderId || joined.ownerId !== owner.ownerId
      ) {
        throw failure(
          "owner_transaction_required",
          "A transaction from this database owner is required.",
        );
      }
      await authorizeOwnerCommand(authorization, joined.context, "mutation");
      const result = await execute(input, joined.context);
      return result;
    }
    registered ??= owner.register(kind, {
      authorize: (_input, context) =>
        authorizeOwnerCommand(authorization, context, "mutation"),
      authorizeResult: (_input, context) =>
        authorizeOwnerCommand(authorization, context, "result"),
      execute: (input, context) =>
        authorization
          ? withOwnerCommandAuthorization(
            authorization,
            () => execute(input as Input, context),
          )
          : execute(input as Input, context),
    });
    return await registered({
      principal: binding?.principal ?? "runtime",
      receiptReader: binding?.receiptReader,
      epoch: owner.epoch!,
    }, {
      input,
      ...(binding ? { receipt: binding.receipt } : {}),
    }) as Output;
  };
}

function bindOwner(
  session: SqlSession,
  schema: string,
  owner: DatabaseOwner,
): void {
  ownerSlot(session, schema);
  const slot = { acquired: Promise.resolve(owner) };
  schemaOwners.get(session)!.set(schema, slot);
  const slots = ownerSlots.get(owner) ?? [];
  slots.push({ session, schema, slot });
  ownerSlots.set(owner, slots);
}

const commandExecutorAliases = new WeakMap<SqlExecutor, {
  transaction: SqlExecutor;
  assertActive(): void;
}>();

/** Package-only query handle association; never grants session acquisition. */
export function bindCommandExecutorAlias(
  executor: SqlExecutor,
  transaction: SqlExecutor,
  assertActive: () => void,
): void {
  assertCommandTransaction(transaction);
  commandExecutorAliases.set(executor, { transaction, assertActive });
}

function commandSource(executor: SqlExecutor): SqlExecutor {
  const alias = commandExecutorAliases.get(executor);
  alias?.assertActive();
  return alias?.transaction ?? executor;
}

/** Captures repository authority before any commands are submitted. */
export function createSchemaCommandRunner(
  session: SqlExecutor,
  schema: string,
) {
  const source = commandSource(session);
  const joined = commandContexts.get(source);
  const sql = session as SqlSession;
  const slot = joined ? undefined : ownerSlot(sql, schema);
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
        await authorizeOwnerCommand(authorization, context, "mutation");
        const result = await execute(input, context);
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
    return registerCommandOnSlot(
      sql,
      schema,
      slot!,
      kind,
      execute,
      authorization,
    )(
      input,
      undefined,
      binding,
    );
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

const activations = new WeakMap<DatabaseOwner, Promise<void>>();
/** One activation per epoch, shared by every context attached to that owner. */
export function activateDatabaseOwner(
  owner: DatabaseOwner,
  recover: () => Promise<void>,
): Promise<void> {
  if (owner.state === "ready") return Promise.resolve();
  let activation = activations.get(owner);
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
    activations.set(owner, activation);
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
