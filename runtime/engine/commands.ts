import { createCoreTableNames } from "../events/schema.ts";
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
export type CommandCaller = Readonly<{ principal: string; epoch: number }>;
export type CommandContext = Readonly<{
  transaction: SqlExecutor;
  caller: CommandCaller;
  commandTime: string;
  signal: AbortSignal;
  afterCommit(callback: () => void | Promise<void>): void;
}>;
export type CommandDefinition<Input, Output> = Readonly<{
  authorize(input: Input, context: CommandContext): void | Promise<void>;
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
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(
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
  onPublicationError?: (error: unknown) => void;
}) {
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

  function stop(
    error: unknown = failure("owner_stopped", "The database owner stopped."),
  ) {
    if (state === "stopped") return;
    state = "stopped";
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
            await callback();
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
        await pending.shift()!.run();
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

  function execute<K extends keyof T & string>(
    kind: K,
    caller: CommandCaller,
    request: CommandRequest<T[K]["input"]>,
  ): Promise<T[K]["output"]> {
    try {
      assertAcquired();
      if (!Object.hasOwn(options.handlers, kind)) {
        throw new TypeError(`Unknown owner command '${kind}'.`);
      }
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
    const completion = Promise.withResolvers<T[K]["output"]>();
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
                const handler = options.handlers[kind];
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

                    return existing.result as T[K]["output"];
                  }
                }
                const output = await handler.execute(request.input, context);
                assertAcquired();
                if (receipt) {
                  await tx.query(
                    `INSERT INTO ${tables.owner_receipts} (owner,domain,key,principal,kind,intent,result) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
                    [
                      owner,
                      receipt.identity.domain,
                      receipt.identity.key,
                      binding.principal,
                      kind,
                      canonical(receipt.intent),
                      canonical(output as CommandJson),
                    ],
                  );
                }

                afterSqlCommit(tx, () => {
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
                return undefined as T[K]["output"];
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
    stopped: stopped.promise,
    ready: readiness.promise,
    acquire,
    execute,
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
    /** Called only after stale-attempt invalidation and catalog recovery. */
    activate() {
      assertAcquired();
      state = "ready";
      readiness.resolve();
    },
    stop,
  };
}

export type DatabaseOwner = ReturnType<
  typeof createOwnerCommands<Record<never, never>>
>;
const localOwners = new Map<string, WeakRef<DatabaseOwner>>();
const ownerReferences = new WeakMap<DatabaseOwner, number>();

/** The durable holder row identifies a database/schema across connection objects. */
export async function openDatabaseOwner(
  session: SqlSession,
  schema: string,
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
    return existing;
  }
  const owner = createOwnerCommands({ session, schema, handlers: {} });
  await owner.acquire(Number(row?.epoch ?? 0));
  localOwners.set(owner.holderId, new WeakRef(owner));
  ownerReferences.set(owner, 1);
  return owner;
}

/** Scope shutdown releases its attachment; the last attachment stops admission. */
export function releaseDatabaseOwner(owner: DatabaseOwner): void {
  const remaining = (ownerReferences.get(owner) ?? 1) - 1;
  ownerReferences.set(owner, remaining);
  if (remaining <= 0) {
    owner.stop();
    localOwners.delete(owner.holderId);
  }
}
