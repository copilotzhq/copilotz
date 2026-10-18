/** Internal serialized command boundary, restricted to one owner ID per SQL schema.
 * Acquisition alone does not establish readiness. */
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { ownerTableNames, validateOwnerCommandSchema } from "./schema.ts";
import {
  assertOwnerPrincipalFence,
  type OwnerPrincipal,
  ownerPrincipalIdentity,
} from "./principal.ts";
export type { OwnerPrincipal } from "./principal.ts";

export type OwnerJson =
  | null
  | boolean
  | number
  | string
  | readonly OwnerJson[]
  | { readonly [key: string]: OwnerJson };
export type OwnerIdentityDomain = "logical" | "incarnation" | "occurrence";
export type OwnerCommand = Readonly<
  { kind: string; domain: OwnerIdentityDomain; key: string; intent: OwnerJson }
>;
/** Structured JSON binding supplied by the trusted host, separately from command data. */
export type OwnerCaller = Readonly<
  { principal: OwnerPrincipal; ownerEpoch: number; [binding: string]: unknown }
>;
export type OwnerCommitContext = Readonly<{
  transaction: SqlExecutor;
  ownerId: string;
  epoch: number;
  holderId: string;
  commandTime: string;
}>;
/** Registered local normalization, never a caller-supplied digest or closure.
 * Must only validate/canonicalize bounded data; no external I/O or effects. */
export type OwnerCommandInputDefinition = Readonly<{
  normalize(input: OwnerJson):
    | Readonly<{ intent: OwnerJson; value: OwnerJson }>
    | Promise<Readonly<{ intent: OwnerJson; value: OwnerJson }>>;
}>;
export type OwnerInputCommand = Readonly<{
  kind: string;
  domain: OwnerIdentityDomain;
  key: string;
  input: OwnerJson;
}>;
export type OwnerCommandContext = Readonly<{
  tx: SqlExecutor;
  /** Present only for a registered input definition; never stored in receipts. */
  input?: OwnerJson;
  caller: OwnerCaller;
  command: Readonly<Pick<OwnerCommand, "kind" | "domain" | "key">>;
  commandTime: string;
  signal: AbortSignal;
  ownerCommit: OwnerCommitContext;
  afterCommit(callback: () => void | Promise<void>): void;
}>;
export type OwnerCommandHandler = (
  intent: OwnerJson,
  context: OwnerCommandContext,
) => OwnerJson | Promise<OwnerJson>;
/** Trusted core read handler, not a SQL sandbox. It must perform no business
 * writes. No mutation context, publication hook or durable receipt is supplied. */
export type OwnerProjectionHandler = (
  input: OwnerJson,
  context: Readonly<
    Pick<OwnerCommandContext, "tx" | "caller" | "commandTime" | "signal">
  >,
) => OwnerJson | Promise<OwnerJson>;
/** Trusted receipt-free SQL mutation. Its durable target supplies exact replay
 * semantics (for stream checkpoints, the committed offset). No physical I/O:
 * a definitively rolled-back group may rerun the handler. */
export type OwnerCheckpointHandler = (
  input: OwnerJson,
  context: Readonly<
    Pick<
      OwnerCommandContext,
      "tx" | "caller" | "commandTime" | "signal" | "ownerCommit" | "afterCommit"
    >
  >,
) => OwnerJson | Promise<OwnerJson>;
export type OwnerCommandOutcome = Readonly<
  { status: "committed" | "duplicate"; result: OwnerJson }
>;
export type OwnerReceipt = Readonly<
  { kind: string; intent: OwnerJson; result: OwnerJson }
>;
export type OwnerCommandBoundaryOptions = Readonly<{
  session: SqlSession;
  schema: string;
  ownerId: string;
  holderId: string;
  handlers: Readonly<Record<string, OwnerCommandHandler>>;
  projections?: Readonly<Record<string, OwnerProjectionHandler>>;
  /** Private core registration; never dispatched through generic command/project. */
  checkpoints?: Readonly<Record<string, OwnerCheckpointHandler>>;
  inputDefinitions?: Readonly<Record<string, OwnerCommandInputDefinition>>;
  /** Revalidate current assignment/session/execution authority under the owner
   * lock. Bind key to its stable invocation and semantic target (e.g. namespace)
   * on every call, including receipt duplicates; transient fences are not intent. */
  authorize(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    commandTime: string,
    normalizedInput?: OwnerJson,
  ): void | Promise<void>;
  /** Optional private lifetime fence, separate from SQL/policy authorization.
   * Synchronous and literal-true only. The scoped tx is an identity token here;
   * this hook must not perform SQL, including after its savepoint/COMMIT.
   * Post-COMMIT refusal hides the outcome but cannot undo receipts/publication. */
  isCurrentAuthorization?(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    commandTime: string,
  ): boolean;
  /** Optional explicit scope for the private fence. Omitted means all commands.
   * Entries must be distinct registered command/projection/checkpoint kinds. */
  currentAuthorizationKinds?: readonly string[];
  authenticateReceipt(
    tx: SqlExecutor,
    caller: OwnerCaller,
  ): void | Promise<void>;
  maxQueue?: number;
  maxGroup?: number;
  maxPostCommitGroups?: number;
  maxCallbacksPerCommand?: number;
  now?: () => string;
  onPostCommitError?: (error: unknown) => void;
}>;
export type OwnerCommandExecuteOptions = Readonly<{ signal?: AbortSignal }>;
export type OwnerCommandBoundary = Readonly<{
  readonly state: "unacquired" | "acquired" | "stopped";
  readonly epoch: number | undefined;
  /** Terminal notification only, after private state revocation. It grants no authority. */
  readonly stopped: Promise<void>;
  acquire(expectedEpoch: number): Promise<number>;
  execute(
    caller: OwnerCaller,
    command: OwnerCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
  executeInput(
    caller: OwnerCaller,
    command: OwnerInputCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
  project(
    caller: OwnerCaller,
    kind: string,
    input: OwnerJson,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
  checkpoint(
    caller: OwnerCaller,
    kind: string,
    input: OwnerJson,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
  readReceipt(
    caller: OwnerCaller,
    identity: Readonly<{ domain: OwnerIdentityDomain; key: string }>,
  ): Promise<OwnerReceipt | undefined>;
  stop(reason?: unknown): void;
}>;

type PendingMode = "command" | "projection" | "checkpoint";
type Pending = {
  mode: PendingMode;
  inputCommand: boolean;
  rawInput?: OwnerJson;
  caller: OwnerCaller;
  command: OwnerCommand;
  canonical: string;
  aborted: boolean;
  abortReason?: unknown;
  handlerSignal: AbortSignal;
  abortHandler(reason: unknown): void;
  removeAbort?: () => void;
  resolve(value: OwnerCommandOutcome): void;
  reject(error: unknown): void;
};
type Completion = {
  pending: Pending;
  outcome?: OwnerCommandOutcome;
  error?: unknown;
  failed?: boolean;
  callbacks: Array<() => void | Promise<void>>;
  checkAuthorization?: () => void;
};

function failure(
  code: string,
  message: string,
  cause?: unknown,
): Error & { code: string } {
  return Object.assign(new Error(message, { cause }), {
    name: code === "ActionOwnershipLost" ? code : "OwnerCommandError",
    code,
  });
}
function nonempty(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    throw failure(
      "owner_command_invalid",
      `${name} must be a nonempty string of at most 1024 characters.`,
    );
  }
}
function domain(value: unknown): asserts value is OwnerIdentityDomain {
  if (!["logical", "incarnation", "occurrence"].includes(value as string)) {
    throw failure(
      "owner_command_invalid",
      "Unknown owner command identity domain.",
    );
  }
}
function safeEpoch(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw failure(
      "owner_command_invalid",
      "Owner epoch must be a nonnegative safe integer.",
    );
  }
}

/** Canonical JSON without invoking getters/toJSON or silently dropping intent fields. */
function canonicalJson(value: unknown): string {
  const seen = new Set<object>();
  function encode(input: unknown, depth: number): string {
    if (depth > 64) {
      throw failure("owner_command_invalid", "JSON nesting exceeds 64 levels.");
    }
    if (
      input === null || typeof input === "string" || typeof input === "boolean"
    ) return JSON.stringify(input);
    if (typeof input === "number" && Number.isFinite(input)) {
      return JSON.stringify(input);
    }
    if (typeof input !== "object" || !input) {
      throw failure(
        "owner_command_invalid",
        "Command intents and durable results must contain only JSON values.",
      );
    }
    if (seen.has(input)) {
      throw failure(
        "owner_command_invalid",
        "JSON values cannot contain cycles.",
      );
    }
    const prototype = Object.getPrototypeOf(input);
    if (
      !Array.isArray(input) && prototype !== Object.prototype &&
      prototype !== null
    ) {
      throw failure(
        "owner_command_invalid",
        "JSON objects must have plain prototypes.",
      );
    }
    seen.add(input);
    try {
      const properties = Object.getOwnPropertyDescriptors(input);
      if (Reflect.ownKeys(input).some((key) => typeof key !== "string")) {
        throw failure(
          "owner_command_invalid",
          "JSON objects cannot have symbol properties.",
        );
      }
      const keys = Object.keys(properties);
      if (
        keys.some((key) =>
          !("value" in properties[key]) ||
          (!properties[key].enumerable &&
            !(Array.isArray(input) && key === "length"))
        )
      ) {
        throw failure(
          "owner_command_invalid",
          "JSON objects cannot contain accessors or hidden properties.",
        );
      }
      if (Array.isArray(input)) {
        if (keys.length !== input.length + 1) {
          throw failure(
            "owner_command_invalid",
            "JSON arrays must be dense without extra properties.",
          );
        }
        return `[${
          Array.from({ length: input.length }, (_, i) => {
            if (!properties[String(i)]) {
              throw failure(
                "owner_command_invalid",
                "JSON arrays must be dense.",
              );
            }
            return encode(properties[String(i)].value, depth + 1);
          }).join(",")
        }]`;
      }
      return `{${
        keys.sort().map((key) =>
          `${JSON.stringify(key)}:${encode(properties[key].value, depth + 1)}`
        ).join(",")
      }}`;
    } finally {
      seen.delete(input);
    }
  }
  const encoded = encode(value, 0);
  if (new TextEncoder().encode(encoded).length > 1_048_576) {
    throw failure("owner_command_invalid", "JSON value exceeds one MiB.");
  }
  return encoded;
}
function copyJson(value: unknown): OwnerJson {
  return JSON.parse(canonicalJson(value)) as OwnerJson;
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ??
      new DOMException("Owner command aborted.", "AbortError");
  }
}
function checkPendingAbort(pending: Pending): void {
  if (pending.aborted) throw pending.abortReason;
}
/** Host capabilities live in callbacks; caller bindings are isolated structured data. */
function copyCaller(caller: OwnerCaller): OwnerCaller {
  return copyJson(caller) as OwnerCaller;
}
function isIndeterminate(error: unknown): boolean {
  return !!error && typeof error === "object" &&
    ((error as { code?: unknown }).code === "persistence_indeterminate" ||
      (error as { indeterminate?: unknown }).indeterminate === true);
}

export function createOwnerCommandBoundary(
  options: OwnerCommandBoundaryOptions,
): OwnerCommandBoundary {
  const {
    session,
    schema,
    ownerId,
    holderId,
    authorize,
    authenticateReceipt,
    isCurrentAuthorization,
    onPostCommitError,
  } = options;
  nonempty(ownerId, "ownerId");
  nonempty(holderId, "holderId");
  if (
    typeof authorize !== "function" ||
    typeof authenticateReceipt !== "function"
  ) {
    throw new TypeError(
      "Owner command and receipt authentication callbacks are required.",
    );
  }
  if (
    isCurrentAuthorization !== undefined &&
    typeof isCurrentAuthorization !== "function"
  ) {
    throw new TypeError(
      "Current authorization fence must be a synchronous function.",
    );
  }
  const tables = ownerTableNames(schema);
  const handlers = new Map(Object.entries(options.handlers));
  const projections = new Map(Object.entries(options.projections ?? {}));
  const checkpoints = new Map(Object.entries(options.checkpoints ?? {}));
  const normalizers = new Map(
    Object.entries(options.inputDefinitions ?? {}).map(([kind, definition]) =>
      [kind, definition?.normalize] as const
    ),
  );
  if (
    [...normalizers].some(([kind, normalize]) =>
      !handlers.has(kind) || typeof normalize !== "function"
    )
  ) throw new TypeError("Input definitions require a handler and normalizer.");
  if (
    [...projections.values()].some((handler) => typeof handler !== "function")
  ) {
    throw new TypeError("Owner projections must be functions.");
  }
  if ([...handlers.values()].some((handler) => typeof handler !== "function")) {
    throw new TypeError("Owner handlers must be functions.");
  }
  if ([...projections.keys()].some((kind) => handlers.has(kind))) {
    throw new TypeError("Owner command and projection names must be distinct.");
  }
  if (
    [...checkpoints.values()].some((handler) => typeof handler !== "function")
  ) {
    throw new TypeError("Owner checkpoints must be functions.");
  }
  if (
    [...checkpoints.keys()].some((kind) =>
      handlers.has(kind) || projections.has(kind)
    )
  ) {
    throw new TypeError(
      "Owner command, projection and checkpoint names must be distinct.",
    );
  }
  if (checkpoints.size && !isCurrentAuthorization) {
    throw new TypeError(
      "Owner checkpoints require a current authorization fence.",
    );
  }
  const requestedAuthorizationKinds = options.currentAuthorizationKinds;
  let currentAuthorizationKinds: ReadonlySet<string> | undefined;
  if (requestedAuthorizationKinds !== undefined) {
    const count: unknown = Array.isArray(requestedAuthorizationKinds)
      ? Object.getOwnPropertyDescriptor(requestedAuthorizationKinds, "length")
        ?.value
      : undefined;
    if (
      !isCurrentAuthorization || typeof count !== "number" ||
      !Number.isSafeInteger(count) || count < 1 ||
      count > handlers.size + projections.size + checkpoints.size
    ) {
      throw new TypeError(
        "Current authorization kinds require a fence and a nonempty registered allowlist.",
      );
    }
    const captured: string[] = [];
    for (let index = 0; index < count; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(
        requestedAuthorizationKinds,
        String(index),
      );
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          "Current authorization kinds require dense own data entries.",
        );
      }
      const kind: unknown = descriptor.value;
      nonempty(kind, "currentAuthorizationKind");
      if (
        !handlers.has(kind) && !projections.has(kind) && !checkpoints.has(kind)
      ) {
        throw new TypeError("Current authorization kind is not registered.");
      }
      captured.push(kind);
    }
    currentAuthorizationKinds = new Set(captured);
    if (currentAuthorizationKinds.size !== captured.length) {
      throw new TypeError("Current authorization kinds must be distinct.");
    }
  }
  if (
    currentAuthorizationKinds &&
    [...checkpoints.keys()].some((kind) => !currentAuthorizationKinds.has(kind))
  ) {
    throw new TypeError(
      "Every owner checkpoint requires the current authorization fence.",
    );
  }
  const maxGroup = options.maxGroup ?? 32;
  const maxQueue = options.maxQueue ?? 128;
  const maxPostCommitGroups = options.maxPostCommitGroups ?? maxQueue;
  const maxCallbacksPerCommand = options.maxCallbacksPerCommand ?? 16;
  if (
    !Number.isSafeInteger(maxGroup) || maxGroup < 1 || maxGroup > 32 ||
    !Number.isSafeInteger(maxQueue) || maxQueue < 1 ||
    !Number.isSafeInteger(maxPostCommitGroups) || maxPostCommitGroups < 1 ||
    !Number.isSafeInteger(maxCallbacksPerCommand) || maxCallbacksPerCommand < 1
  ) {
    throw new RangeError(
      "maxGroup must be 1..32 and queue/callback limits must be positive integers.",
    );
  }
  const now = options.now ?? (() => new Date().toISOString());
  let resolveStopped!: () => void;
  const terminal = new Promise<void>((resolve) => resolveStopped = resolve);
  let state: "unacquired" | "acquired" | "stopped" = "unacquired";
  let epoch: number | undefined;
  let stopReason: unknown;
  let acquiring = false;
  let pumping = false;
  let outstanding = 0;
  let postCommitReserved = 0;
  let publishing = false;
  const publications: Array<Array<() => void | Promise<void>>> = [];
  const queue: Pending[] = [];
  function stopped(): unknown {
    return stopReason ??
      failure("owner_stopped", "Owner command boundary has stopped.");
  }
  function stop(reason?: unknown): void {
    if (state === "stopped") return;
    state = "stopped";
    stopReason = reason ??
      failure("owner_stopped", "Owner command boundary has stopped.");
    for (const item of queue.splice(0)) {
      outstanding--;
      postCommitReserved--;
      item.removeAbort?.();
      item.reject(stopped());
    }
    resolveStopped();
  }
  function assertAcquired(): void {
    if (state === "stopped") throw stopped();
    if (state !== "acquired") {
      throw failure(
        "owner_not_acquired",
        "Acquire the owner epoch before commands.",
      );
    }
  }
  async function publish(): Promise<void> {
    try {
      while (publications.length) {
        const callbacks = publications.shift()!;
        try {
          for (const callback of callbacks) {
            try {
              await callback();
            } catch (error) {
              try {
                onPostCommitError?.(error);
              } catch { /* Reporting cannot change a committed outcome. */ }
            }
          }
        } finally {
          postCommitReserved--;
        }
      }
    } finally {
      publishing = false;
    }
  }
  function complete(items: Completion[]): void {
    for (const item of items) {
      outstanding--;
      try {
        if (item.failed) item.pending.reject(item.error);
        else {
          if (item.pending.mode !== "command") {
            // Ephemeral data has no durable delivery entitlement after COMMIT.
            assertAcquired();
            checkPendingAbort(item.pending);
          }
          // A committed mutation stays committed and its publications remain
          // eligible even if its current caller can no longer see the result.
          item.checkAuthorization?.();
          item.pending.resolve(item.outcome!);
        }
      } catch (error) {
        item.pending.reject(error);
      } finally {
        // The final fence may synchronously abort this request. Keep its listener
        // attached until the reply decision has observed that cancellation.
        item.pending.removeAbort?.();
      }
      if (!item.callbacks.length) postCommitReserved--;
      else publications.push(item.callbacks);
    }
    // Ordered publication has its own bounded pump. It cannot hold the SQL queue.
    if (publications.length && !publishing) {
      publishing = true;
      queueMicrotask(() => {
        void publish();
      });
    }
  }
  async function group(items: Pending[], retryAlone = true): Promise<void> {
    let callbackFailure: unknown;
    let callbackFailed = false;
    try {
      const completions = await session.transaction(
        async (transaction) => {
          try {
            assertAcquired();
            const fence = await transaction.query(
              `UPDATE ${tables.epochs} SET holder=holder
            WHERE owner=$1 AND epoch=$2 AND holder=$3 RETURNING epoch`,
              [ownerId, epoch, holderId],
            );
            if (!fence.rows.length) {
              throw failure(
                "ActionOwnershipLost",
                "The owner epoch or holder is no longer current.",
              );
            }
            const completed: Completion[] = [];
            for (const [index, pending] of items.entries()) {
              assertAcquired();
              const savepoint = `owner_command_${index}`;
              await transaction.query(`SAVEPOINT ${savepoint}`);
              const callbacks: Array<() => void | Promise<void>> = [];
              let active = true;
              const tx: SqlExecutor = {
                query(sql, params) {
                  if (!active) {
                    return Promise.reject(
                      failure(
                        "owner_command_closed",
                        "The command transaction is no longer active.",
                      ),
                    );
                  }
                  if (
                    /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE|PREPARE\s+TRANSACTION)\b/i
                      .test(sql)
                  ) {
                    return Promise.reject(
                      failure(
                        "owner_transaction_control_forbidden",
                        "Handlers cannot control the outer transaction.",
                      ),
                    );
                  }
                  return transaction.query(sql, params);
                },
              };
              try {
                checkPendingAbort(pending);
                const commandTime = now();
                if (
                  typeof commandTime !== "string" ||
                  !Number.isFinite(Date.parse(commandTime))
                ) {
                  throw failure(
                    "owner_command_invalid",
                    "Command clock must return a valid timestamp.",
                  );
                }
                assertOwnerPrincipalFence(
                  pending.caller.principal,
                  pending.caller.ownerEpoch,
                  {
                    ownerId,
                    epoch: epoch!,
                    holderId,
                  },
                );
                const principal = ownerPrincipalIdentity(
                  pending.caller.principal,
                );
                let normalizedInput: OwnerJson | undefined;
                if (pending.inputCommand) {
                  checkPendingAbort(pending);
                  const normalized = await normalizers.get(
                    pending.command.kind,
                  )!(
                    copyJson(pending.rawInput),
                  );
                  checkPendingAbort(pending);
                  assertAcquired();
                  if (!active) {
                    throw failure("owner_command_closed", "Command is closed.");
                  }
                  if (
                    !normalized || typeof normalized !== "object" ||
                    Object.keys(normalized).length !== 2 ||
                    !Object.hasOwn(normalized, "intent") ||
                    !Object.hasOwn(normalized, "value")
                  ) {
                    throw failure(
                      "owner_command_invalid",
                      "Invalid normalized command input.",
                    );
                  }
                  const intent = copyJson(normalized.intent);
                  normalizedInput = copyJson(normalized.value);
                  pending.command = { ...pending.command, intent };
                  pending.canonical = canonicalJson({
                    kind: pending.command.kind,
                    intent,
                  });
                }
                assertAcquired();
                await authorize(
                  tx,
                  copyCaller(pending.caller),
                  {
                    ...pending.command,
                    intent: copyJson(pending.command.intent),
                  },
                  commandTime,
                  pending.inputCommand ? copyJson(normalizedInput) : undefined,
                );
                checkPendingAbort(pending);
                const currentAuthorization = !currentAuthorizationKinds ||
                    currentAuthorizationKinds.has(pending.command.kind)
                  ? isCurrentAuthorization
                  : undefined;
                const authorizationCommand = currentAuthorization
                  ? {
                    ...pending.command,
                    intent: copyJson(pending.command.intent),
                  }
                  : pending.command;
                const checkAuthorization = currentAuthorization
                  ? () => {
                    let result: unknown;
                    try {
                      result = currentAuthorization(
                        tx,
                        copyCaller(pending.caller),
                        {
                          ...authorizationCommand,
                          intent: copyJson(authorizationCommand.intent),
                        },
                        commandTime,
                      );
                    } catch (error) {
                      throw failure(
                        "owner_authorization_lost",
                        "Current private command authorization is unavailable.",
                        error,
                      );
                    }
                    if (result instanceof Promise) {
                      // Do not invoke a callback-controlled catch/then override.
                      Promise.prototype.then.call(result, undefined, () =>
                        undefined);
                    }
                    if (result !== true) {
                      throw failure(
                        "owner_authorization_lost",
                        "Current private command authorization is unavailable.",
                      );
                    }
                    // The trusted callback can reenter stop()/cancellation.
                    // Its true return cannot restore owner or request lifetime.
                    assertAcquired();
                    checkPendingAbort(pending);
                  }
                  : undefined;
                checkAuthorization?.();
                const receipt = pending.mode !== "command"
                  ? { rows: [] }
                  : await tx.query<
                    { kind: string; intent: OwnerJson; result: OwnerJson }
                  >(
                    `SELECT kind,intent,result FROM ${tables.receipts}
                WHERE owner=$1 AND domain=$2 AND key=$3`,
                    [ownerId, pending.command.domain, pending.command.key],
                  );
                checkAuthorization?.();
                let outcome: OwnerCommandOutcome;
                if (receipt.rows.length) {
                  const existing = receipt.rows[0];
                  if (
                    canonicalJson({
                      kind: existing.kind,
                      intent: existing.intent,
                    }) !== pending.canonical
                  ) {
                    throw failure(
                      "owner_intent_conflict",
                      "The command identity already has a different kind or intent.",
                    );
                  }
                  outcome = {
                    status: "duplicate",
                    result: copyJson(existing.result),
                  };
                } else {
                  const command = {
                    kind: pending.command.kind,
                    domain: pending.command.domain,
                    key: pending.command.key,
                  };
                  const context: OwnerCommandContext = {
                    tx,
                    ...(pending.inputCommand
                      ? { input: copyJson(normalizedInput) }
                      : {}),
                    caller: copyCaller(pending.caller),
                    command,
                    commandTime,
                    signal: pending.handlerSignal,
                    ownerCommit: {
                      transaction: tx,
                      ownerId: ownerId,
                      epoch: epoch!,
                      holderId: holderId,
                      commandTime,
                    },
                    afterCommit(callback) {
                      if (pending.mode === "projection") {
                        throw new TypeError("Projections cannot publish.");
                      }
                      if (!active) {
                        throw failure(
                          "owner_command_closed",
                          "Cannot register callbacks after the command ends.",
                        );
                      }
                      if (typeof callback !== "function") {
                        throw new TypeError(
                          "Post-commit callback must be a function.",
                        );
                      }
                      if (callbacks.length >= maxCallbacksPerCommand) {
                        throw failure(
                          "owner_admission_refused",
                          "Command post-commit callback capacity exceeded.",
                        );
                      }
                      callbacks.push(callback);
                    },
                  };
                  checkPendingAbort(pending);
                  assertAcquired();
                  const result = copyJson(
                    pending.mode === "projection"
                      ? await projections.get(pending.command.kind)!(
                        copyJson(pending.command.intent),
                        {
                          tx,
                          caller: copyCaller(pending.caller),
                          commandTime,
                          signal: pending.handlerSignal,
                        },
                      )
                      : pending.mode === "checkpoint"
                      ? await checkpoints.get(pending.command.kind)!(
                        copyJson(pending.command.intent),
                        {
                          tx,
                          caller: copyCaller(pending.caller),
                          commandTime,
                          signal: pending.handlerSignal,
                          ownerCommit: context.ownerCommit,
                          afterCommit: context.afterCommit,
                        },
                      )
                      : await handlers.get(pending.command.kind)!(
                        copyJson(pending.command.intent),
                        context,
                      ),
                  );
                  checkPendingAbort(pending);
                  checkAuthorization?.();
                  if (pending.mode === "command") {
                    await tx.query(
                      `INSERT INTO ${tables.receipts}(owner,principal_kind,principal_id,domain,key,kind,intent,result) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
                      [
                        ownerId,
                        principal.kind,
                        principal.id,
                        pending.command.domain,
                        pending.command.key,
                        pending.command.kind,
                        canonicalJson(pending.command.intent),
                        canonicalJson(result),
                      ],
                    );
                  }
                  outcome = { status: "committed", result };
                }
                checkAuthorization?.();
                if (pending.mode === "command") {
                  // Compatible authorized replay associates only this exact tagged
                  // principal. Generic cross-epoch reads remain worker-only.
                  await tx.query(
                    `INSERT INTO ${tables.receiptReaders}(owner,domain,key,principal_kind,principal_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
                    [
                      ownerId,
                      pending.command.domain,
                      pending.command.key,
                      principal.kind,
                      principal.id,
                    ],
                  );
                }
                checkPendingAbort(pending);
                checkAuthorization?.();
                active = false;
                await transaction.query(`RELEASE SAVEPOINT ${savepoint}`);
                completed.push({
                  pending,
                  outcome,
                  callbacks,
                  checkAuthorization,
                });
              } catch (error) {
                active = false;
                if (isIndeterminate(error)) throw error;
                await transaction.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
                await transaction.query(`RELEASE SAVEPOINT ${savepoint}`);
                completed.push({ pending, failed: true, error, callbacks: [] });
              }
            }
            assertAcquired();
            // RELEASE and later commands in this group may revoke an earlier
            // successful caller. A loss here rolls back the whole transaction;
            // the existing definitive retry path may retry commands alone.
            for (const completion of completed) {
              if (!completion.failed) completion.checkAuthorization?.();
            }
            return completed;
          } catch (error) {
            callbackFailed = true;
            callbackFailure = error;
            throw error;
          }
        },
      );
      complete(completions);
    } catch (error) {
      if (
        (error as { code?: unknown } | null)?.code === "ActionOwnershipLost"
      ) stop(error);
      const definitive = callbackFailed && error === callbackFailure &&
        !isIndeterminate(error);
      if (state === "stopped") {
        complete(
          items.map((pending) => ({
            pending,
            failed: true,
            error: stopped(),
            callbacks: [],
          })),
        );
      } else if (definitive) {
        if (retryAlone) {
          for (const item of items) await group([item], false);
        } else {complete(
            items.map((pending) => ({
              pending,
              failed: true,
              error,
              callbacks: [],
            })),
          );}
      } else {
        const unknown = isIndeterminate(error) ? error : failure(
          "owner_commit_unknown",
          "Owner transaction outcome is unknown; this holder must stop and recovery must inspect durable state.",
          error,
        );
        stop(unknown);
        complete(
          items.map((pending) => ({
            pending,
            failed: true,
            error: unknown,
            callbacks: [],
          })),
        );
      }
    }
  }
  async function pump(): Promise<void> {
    try {
      while (queue.length && state === "acquired") {
        await group(queue.splice(0, maxGroup));
      }
    } finally {
      pumping = false;
    }
  }
  function enqueue(
    caller: OwnerCaller,
    command: OwnerCommand,
    execution: OwnerCommandExecuteOptions = {},
    mode: PendingMode = "command",
    inputCommand = false,
  ): Promise<OwnerCommandOutcome> {
    const sourceSignal = execution.signal;
    try {
      assertAcquired();
      checkAbort(sourceSignal);
      safeEpoch(caller.ownerEpoch);
      nonempty(command.kind, "kind");
      nonempty(command.key, "key");
      domain(command.domain);
      if (
        !(mode === "projection"
          ? projections
          : mode === "checkpoint"
          ? checkpoints
          : handlers).has(command.kind)
      ) {
        throw failure(
          "owner_command_invalid",
          "Command kind is not registered.",
        );
      }
      if (
        mode === "command" && normalizers.has(command.kind) !== inputCommand
      ) {
        throw failure(
          "owner_command_invalid",
          "Command input route does not match its definition.",
        );
      }
      const rawInput = inputCommand ? copyJson(command.intent) : undefined;
      const authenticated = copyCaller(caller);
      if (Object.hasOwn(authenticated, "workerId")) {
        throw failure(
          "owner_command_invalid",
          "Legacy caller workerId is unsupported.",
        );
      }
      ownerPrincipalIdentity(authenticated.principal);
      const copied: OwnerCommand = {
        kind: command.kind,
        domain: command.domain,
        key: command.key,
        intent: copyJson(command.intent),
      };
      const canonical = canonicalJson({
        kind: copied.kind,
        intent: copied.intent,
      });
      if (
        outstanding >= maxQueue || postCommitReserved >= maxPostCommitGroups
      ) {
        throw failure(
          "owner_admission_refused",
          "Owner command queue is at capacity.",
        );
      }
      return new Promise<OwnerCommandOutcome>((resolve, reject) => {
        outstanding++;
        postCommitReserved++;
        const handlerController = new AbortController();
        const pending: Pending = {
          mode,
          inputCommand,
          rawInput,
          caller: authenticated,
          command: copied,
          canonical,
          aborted: false,
          handlerSignal: handlerController.signal,
          abortHandler: (reason) => handlerController.abort(reason),
          resolve,
          reject,
        };
        queue.push(pending);
        if (sourceSignal) {
          const signal = sourceSignal;
          const onAbort = () => {
            pending.aborted = true;
            pending.abortReason = signal.reason ??
              new DOMException("Owner command aborted.", "AbortError");
            pending.abortHandler(pending.abortReason);
            const index = queue.indexOf(pending);
            if (index < 0) return; // The active group's savepoint checks own cancellation.
            queue.splice(index, 1);
            outstanding--;
            postCommitReserved--;
            pending.removeAbort?.();
            reject(pending.abortReason);
          };
          signal.addEventListener("abort", onAbort, { once: true });
          pending.removeAbort = () =>
            signal.removeEventListener("abort", onAbort);
          if (signal.aborted) onAbort();
        }
        if (!pumping) {
          pumping = true;
          queueMicrotask(() => {
            void pump();
          });
        }
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }
  return {
    stopped: terminal,
    get state() {
      return state;
    },
    get epoch() {
      return epoch;
    },
    stop,
    async acquire(expectedEpoch) {
      safeEpoch(expectedEpoch);
      if (state !== "unacquired" || acquiring) {
        throw failure(
          "owner_acquire_invalid",
          "An owner boundary can acquire only once.",
        );
      }
      acquiring = true;
      let callbackFailed = false;
      let callbackFailure: unknown;
      try {
        const acquired = await session.transaction(async (tx) => {
          try {
            // Serialize first-owner installation across different IDs, not just
            // epoch takeover of an existing row. The schema's unique constant
            // index also prevents conflicting IDs outside this acquire path.
            await tx.query(
              "SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))",
              [
                schema,
                "copilotz-owner-schema",
              ],
            );
            await validateOwnerCommandSchema(tx, schema, ownerId);
            await tx.query(
              `INSERT INTO ${tables.epochs}(owner,epoch,holder,last_seq) VALUES($1,0,'',0) ON CONFLICT(owner) DO NOTHING`,
              [ownerId],
            );
            const result = await tx.query<{ epoch: string | number }>(
              `UPDATE ${tables.epochs} SET epoch=epoch+1,holder=$3 WHERE owner=$1 AND epoch=$2 RETURNING epoch`,
              [ownerId, expectedEpoch, holderId],
            );
            if (!result.rows.length) {
              throw failure(
                "ActionOwnershipLost",
                "Owner acquisition lost its expected epoch.",
              );
            }
            const value = Number(result.rows[0].epoch);
            safeEpoch(value);
            if (state === "stopped") throw stopped();
            return value;
          } catch (error) {
            callbackFailed = true;
            callbackFailure = error;
            throw error;
          }
        });
        if ((state as OwnerCommandBoundary["state"]) === "stopped") {
          throw stopped();
        }
        epoch = acquired;
        state = "acquired";
        return acquired;
      } catch (error) {
        const known = callbackFailed && callbackFailure === error &&
          !isIndeterminate(error);
        stop(
          known || isIndeterminate(error) ? error : failure(
            "owner_commit_unknown",
            "Owner acquisition outcome is unknown.",
            error,
          ),
        );
        throw stopped();
      } finally {
        acquiring = false;
      }
    },
    execute: (caller, command, execution) =>
      enqueue(caller, command, execution),
    executeInput: (caller, command, execution) =>
      enqueue(
        caller,
        {
          kind: command.kind,
          domain: command.domain,
          key: command.key,
          intent: command.input,
        },
        execution,
        "command",
        true,
      ),
    async project(caller, kind, input, execution) {
      const outcome = await enqueue(
        caller,
        {
          kind,
          domain: "occurrence",
          key: crypto.randomUUID(),
          intent: input,
        },
        execution,
        "projection",
      );
      return outcome.result;
    },
    async checkpoint(caller, kind, input, execution) {
      const outcome = await enqueue(
        caller,
        {
          kind,
          domain: "occurrence",
          key: crypto.randomUUID(),
          intent: input,
        },
        execution,
        "checkpoint",
      );
      return outcome.result;
    },
    async readReceipt(caller, identity) {
      domain(identity.domain);
      nonempty(identity.key, "key");
      const authenticated = copyCaller(caller);
      if (Object.hasOwn(authenticated, "workerId")) {
        throw failure(
          "owner_command_invalid",
          "Legacy caller workerId is unsupported.",
        );
      }
      safeEpoch(authenticated.ownerEpoch);
      const principal = ownerPrincipalIdentity(authenticated.principal);
      if (principal.kind !== "worker") {
        throw failure(
          "owner_receipt_principal_refused",
          "Generic receipt recovery is worker-only.",
        );
      }
      const identityCopy = { ...identity };
      return await session.transaction(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY");
        await validateOwnerCommandSchema(tx, schema, ownerId);
        await authenticateReceipt(tx, copyCaller(authenticated));
        const found = await tx.query<
          { kind: string; intent: OwnerJson; result: OwnerJson }
        >(
          `SELECT r.kind,r.intent,r.result FROM ${tables.receipts} r JOIN ${tables.receiptReaders} a USING(owner,domain,key) WHERE r.owner=$1 AND a.principal_kind=$2 AND a.principal_id=$3 AND r.domain=$4 AND r.key=$5`,
          [
            ownerId,
            principal.kind,
            principal.id,
            identityCopy.domain,
            identityCopy.key,
          ],
        );
        const row = found.rows[0];
        return row
          ? {
            kind: row.kind,
            intent: copyJson(row.intent),
            result: copyJson(row.result),
          }
          : undefined;
      });
    },
  };
}
