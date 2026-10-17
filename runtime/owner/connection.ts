/** Application command bindings on Oxian's existing reverse work streams.
 * Private structural ports let the published package remain on its released
 * dependency until the separately reviewed transport change is published. */
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerCommandOutcome,
  OwnerIdentityDomain,
  OwnerInputCommand,
  OwnerJson,
  OwnerReceipt,
} from "./boundary.ts";
import { assertJsonValue } from "../json.ts";

const EFFECT_SETTLE = "copilotz.owner.effect-settle";
const EFFECT_STATE = "copilotz.owner.effect-state";
const ACTION = "copilotz.owner.action";
const ACTION_CALL = "copilotz.owner.action-call";
const CHILD_ACTION = "copilotz.owner.child-action";
const CHILD_PREPARATION = "copilotz.owner.child-prepare";
const CHILD_RESULT = "copilotz.owner.child-result";
const ACTION_RESULT = "copilotz.owner.action-result";
const COMMAND = "copilotz.owner.command";
const READY = "copilotz.owner.ready";
const PROTOCOL = "copilotz.owner.v1";
const FEATURES = ["commands", "projections", "settlement"] as const;
const COMPLETE = "copilotz.owner.complete";
const PROJECT = "copilotz.owner.project";
const RECEIPT = "copilotz.owner.receipt";
const LIMIT = 1_100_000;
const ERROR_CODES = new Set([
  "ActionOwnershipLost",
  "owner_command_invalid",
  "owner_not_acquired",
  "owner_stopped",
  "owner_schema_owner_conflict",
  "owner_admission_refused",
  "owner_intent_conflict",
  "owner_command_closed",
  "owner_transaction_control_forbidden",
  "owner_commit_unknown",
  "persistence_indeterminate",
  "owner_call_rejected",
  "effect_authority_refused",
  "effect_binding_invalid",
  "effect_transition_conflict",
  "effect_evidence_refused",
  "effect_outcome_invalid",
  "effect_state_invalid",
  "effect_step_limit",
  "effect_data_invalid",
  "effect_indeterminate",
]);
export type OwnerActionCallRequest = Readonly<{
  actionAlias: string;
  input: OwnerJson;
  operationKey?: string;
}>;
function actionCallRequest(value: unknown): OwnerActionCallRequest {
  const request = object(value);
  if (
    Object.keys(request).some((key) =>
      !["actionAlias", "input", "operationKey"].includes(key)
    ) ||
    typeof request.actionAlias !== "string" || !request.actionAlias.trim() ||
    !Object.hasOwn(request, "input") ||
    (Object.hasOwn(request, "operationKey") &&
      (typeof request.operationKey !== "string" ||
        !request.operationKey.trim()))
  ) {
    throw new TypeError("Invalid Action call request.");
  }
  return structuredClone(request) as OwnerActionCallRequest;
}
type JsonObject = Readonly<Record<string, OwnerJson>>;

export type OwnerHostCaller = (
  input: Readonly<{
    workload: string;
    metadata?: JsonObject;
    body?: Uint8Array | ReadableStream<Uint8Array>;
    signal?: AbortSignal;
    deadlineAtMs?: number;
  }>,
) => Promise<
  Readonly<{
    output: ReadableStream<Uint8Array>;
    completed: Promise<void>;
    cancel(reason?: string): Promise<void>;
  }>
>;
export type OwnerWorkerCallContext = Readonly<{
  workload: string;
  metadata: JsonObject;
  signal: AbortSignal;
  fence: Readonly<
    {
      identity: Readonly<
        { workerId: string; attemptId: string; epoch: number }
      >;
      connectionId: string;
      sessionGeneration: number;
    }
  >;
  parent?: Readonly<
    {
      operationId: string;
      streamId: string;
      workload: string;
      metadata: JsonObject;
    }
  >;
}>;
type RecoveryReceipt = Pick<OwnerReceipt, "kind" | "result">;
type ReceiptIdentity = Readonly<{ domain: OwnerIdentityDomain; key: string }>;
type HostHandler = (
  input: Readonly<{ input: ReadableStream<Uint8Array>; signal: AbortSignal }>,
) => Promise<Uint8Array>;

function encode(value: unknown): Uint8Array {
  assertJsonValue(value, { maxDepth: 68, maxNodes: LIMIT });
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  if (bytes.byteLength > LIMIT) {
    throw new RangeError("Owner call exceeds its byte limit.");
  }
  return bytes;
}
async function read(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): Promise<unknown> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject;
  });
  const onAbort = () =>
    rejectAbort(
      signal?.reason ?? new DOMException("Owner call aborted.", "AbortError"),
    );
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted]);
      if (next.done) break;
      size += next.value.byteLength;
      if (size > LIMIT) {
        throw new RangeError("Owner call exceeds its byte limit.");
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
    assertJsonValue(value, { maxDepth: 68, maxNodes: LIMIT });
    return value;
  } catch (error) {
    void reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected an owner call object.");
  }
  return value as Record<string, unknown>;
}
function receiptIdentity(value: unknown): ReceiptIdentity {
  const input = object(value);
  if (
    Object.keys(input).some((key) => !["domain", "key"].includes(key)) ||
    !["logical", "incarnation", "occurrence"].includes(String(input.domain)) ||
    typeof input.key !== "string" || !input.key.trim()
  ) throw new TypeError("Invalid receipt identity.");
  return input as ReceiptIdentity;
}

/** Returns separate admissions suitable for Oxian workerCalls. No effects occur
 * until the admitted handler runs. A missing named holder never falls back. */
export function createOwnerWorkerCallAdmission(
  options: Readonly<{
    resolveOwner(ownerId: string): OwnerCommandBoundary | undefined;
    /** Optional inert readiness admission: authenticate this exact session and
     * return true only after actual owner reconciliation/handler readiness. */
    authorizeReadiness?(
      context: OwnerWorkerCallContext,
      ownerId: string,
    ): boolean | Promise<boolean>;
    /** Independently authenticate a current ingress connection and original route.
     * Parentless readiness/receipt or worker grants never imply ingress authority.
     * The boundary must recheck current policy with normalized facts before replay
     * or result hydration. The returned binding is snapshotted and revalidated
     * after body streaming; selectors and request provenance are not authority. */
    resolveIngress?(
      context: OwnerWorkerCallContext,
      ownerId: string,
      route: "action" | "action-result",
    ): OwnerCaller | undefined | Promise<OwnerCaller | undefined>;
    /** Host-only normalization must derive trusted facts under current policy.
     * Its result is checked again against the current ingress binding before SQL
     * admission; the command itself must independently reauthorize before replay. */
    prepareIngressAction?(
      context: OwnerWorkerCallContext,
      ownerId: string,
      caller: OwnerCaller,
      request: OwnerActionCallRequest,
      signal: AbortSignal,
    ): Promise<OwnerInputCommand>;
    /** Resolve host-owned assignment state and grants, not request metadata.
     * Current session/execution/policy must also be checked inside boundary.authorize. */
    resolveAssignment(
      context: OwnerWorkerCallContext,
      ownerId: string,
    ):
      | Readonly<
        {
          ownerId: string;
          ctxGranted: boolean;
          settlementGranted?: boolean;
          caller: OwnerCaller;
        }
      >
      | undefined
      | Promise<
        | Readonly<
          {
            ownerId: string;
            ctxGranted: boolean;
            settlementGranted?: boolean;
            caller: OwnerCaller;
          }
        >
        | undefined
      >;
  }>,
) {
  const admit = async (
    context: OwnerWorkerCallContext,
    recoveryOnly: boolean,
  ): Promise<HostHandler | undefined> => {
    if (
      context.workload !== COMMAND && context.workload !== RECEIPT &&
      context.workload !== PROJECT && context.workload !== COMPLETE &&
      context.workload !== READY && context.workload !== ACTION &&
      context.workload !== ACTION_RESULT && context.workload !== ACTION_CALL &&
      context.workload !== EFFECT_SETTLE &&
      context.workload !== EFFECT_STATE && context.workload !== CHILD_ACTION &&
      context.workload !== CHILD_PREPARATION &&
      context.workload !== CHILD_RESULT
    ) {
      return undefined;
    }
    if (
      recoveryOnly && context.workload !== RECEIPT &&
      context.workload !== READY &&
      context.workload !== ACTION && context.workload !== ACTION_RESULT &&
      context.workload !== ACTION_CALL
    ) return undefined;
    const ownerId = context.metadata.ownerId;
    if (
      typeof ownerId !== "string" || !ownerId.trim() ||
      Object.keys(context.metadata).some((key) => key !== "ownerId")
    ) return undefined;
    const owner = options.resolveOwner(ownerId);
    if (!owner) return undefined;
    const currentOwner = () =>
      owner.state === "acquired" && options.resolveOwner(ownerId) === owner;
    const isReadiness = context.workload === READY;
    if (
      isReadiness && (context.parent || !currentOwner() ||
        !await options.authorizeReadiness?.(context, ownerId) ||
        !currentOwner() || context.signal.aborted)
    ) return undefined;
    const ingressRoute =
      context.workload === ACTION || context.workload === ACTION_CALL
        ? "action"
        : context.workload === ACTION_RESULT
        ? "action-result"
        : undefined;
    if (
      ingressRoute &&
      (context.parent || !currentOwner() || context.signal.aborted)
    ) return undefined;
    if (context.workload === ACTION_CALL && !options.prepareIngressAction) {
      return undefined;
    }
    const ingress = ingressRoute
      ? await options.resolveIngress?.(context, ownerId, ingressRoute)
      : undefined;
    if (
      ingressRoute && (!ingress || !currentOwner() || context.signal.aborted)
    ) return undefined;
    const isCompletion = context.workload === COMPLETE;
    const isEffectSettlement = context.workload === EFFECT_SETTLE;
    const isEffectState = context.workload === EFFECT_STATE;
    const isSettlement = isCompletion || isEffectSettlement || isEffectState;
    const isCommand = context.workload === COMMAND || isCompletion ||
      isEffectSettlement;
    const isAssigned = context.workload !== RECEIPT && !isReadiness &&
      !ingressRoute;
    if (isAssigned && !context.parent) return undefined;
    const assignment = isAssigned
      ? await options.resolveAssignment(context, ownerId)
      : undefined;
    if (
      isAssigned &&
      (!assignment || assignment.ownerId !== ownerId ||
        (isSettlement
          ? assignment.settlementGranted !== true
          : assignment.ctxGranted !== true))
    ) return undefined;
    const caller = isAssigned ? assignment!.caller : ingressRoute ? ingress! : {
      principal: {
        kind: "worker" as const,
        workerId: context.fence.identity.workerId,
      },
      ownerEpoch: 0,
    };
    if (
      !caller || caller.principal.kind !== "worker" ||
      caller.principal.workerId !== context.fence.identity.workerId
    ) {
      return undefined;
    }
    assertJsonValue(caller, { maxDepth: 32, maxNodes: 10_000 });
    const admitted = structuredClone(caller);
    return async ({ input, signal }) => {
      let committed = false;
      try {
        signal.throwIfAborted();
        let payload = await read(input, signal);
        signal.throwIfAborted();
        if (ingressRoute) {
          const fresh = await options.resolveIngress?.(
            context,
            ownerId,
            ingressRoute,
          );
          if (
            !fresh || !currentOwner() || context.signal.aborted ||
            JSON.stringify(fresh) !== JSON.stringify(admitted)
          ) {
            throw new TypeError("Ingress authority is no longer current.");
          }
          signal.throwIfAborted();
        }
        if (isReadiness) {
          const request = object(payload);
          if (
            Object.keys(request).length !== 1 ||
            request.protocol !== PROTOCOL ||
            !currentOwner() ||
            !await options.authorizeReadiness?.(context, ownerId) ||
            !currentOwner() || context.signal.aborted
          ) {
            throw new TypeError(
              "Owner is not ready for this protocol/session.",
            );
          }
          signal.throwIfAborted();
          return encode({
            ok: true,
            value: { protocol: PROTOCOL, ownerId, features: FEATURES },
          });
        }
        if (isCompletion) {
          const command = object(payload);
          const valueField = command.kind === "execution.complete"
            ? "input"
            : "intent";
          if (
            !((command.kind === "execution.complete" &&
              command.domain === "logical") ||
              (command.kind === "processor.complete" &&
                command.domain === "incarnation")) ||
            !Object.hasOwn(command, valueField) ||
            Object.keys(command).some((key) =>
              !["kind", "domain", "key", valueField].includes(key)
            )
          ) {
            throw new TypeError("Invalid restricted completion command.");
          }
        }
        if (isEffectSettlement) {
          const command = object(payload);
          if (
            typeof command.kind !== "string" ||
            !["effect.confirm", "effect.notStarted"].includes(command.kind) ||
            command.domain !== "logical" || typeof command.key !== "string" ||
            !Object.hasOwn(command, "intent") ||
            Object.keys(command).some((key) =>
              !["kind", "domain", "key", "intent"].includes(key)
            )
          ) {
            throw new TypeError("Invalid restricted effect settlement.");
          }
        }
        if (context.workload === ACTION_CALL) {
          payload = await options.prepareIngressAction!(
            context,
            ownerId,
            structuredClone(admitted),
            actionCallRequest(payload),
            signal,
          );
          signal.throwIfAborted();
          const fresh = await options.resolveIngress?.(
            context,
            ownerId,
            "action",
          );
          if (
            !fresh || !currentOwner() || context.signal.aborted ||
            JSON.stringify(fresh) !== JSON.stringify(admitted)
          ) {
            throw new TypeError(
              "Ingress authority changed during normalization.",
            );
          }
          encode(payload); // Bound the derived command as well as the wire request.
          payload = structuredClone(payload);
        }
        if (
          context.workload === CHILD_ACTION ||
          context.workload === CHILD_PREPARATION
        ) {
          const command = object(payload);
          const kind = context.workload === CHILD_ACTION
            ? "action.child-admit"
            : "action.child-prepare";
          if (
            command.kind !== kind ||
            command.domain !== "logical" ||
            typeof command.key !== "string" || !command.key.trim() ||
            !Object.hasOwn(command, "input") ||
            Object.keys(command).some((key) =>
              !["kind", "domain", "key", "input"].includes(key)
            )
          ) {
            throw new TypeError("Invalid child Action admission request.");
          }
        }
        if (context.workload === ACTION || context.workload === ACTION_CALL) {
          const command = object(payload);
          if (
            command.kind !== "action.admit" || command.domain !== "logical" ||
            typeof command.key !== "string" ||
            !Object.hasOwn(command, "input") ||
            Object.keys(command).some((key) =>
              !["kind", "domain", "key", "input"].includes(key)
            )
          ) {
            throw new TypeError("Invalid named Action admission request.");
          }
        }
        const result =
          context.workload === ACTION || context.workload === ACTION_CALL ||
            context.workload === CHILD_ACTION ||
            context.workload === CHILD_PREPARATION ||
            (isCompletion && object(payload).kind === "execution.complete")
            ? await owner.executeInput(admitted, payload as OwnerInputCommand, {
              signal,
            })
            : context.workload === CHILD_RESULT
            ? await owner.project(
              admitted,
              "action.child-result",
              payload as OwnerJson,
              { signal },
            )
            : context.workload === ACTION_RESULT
            ? await owner.project(
              admitted,
              "action.result",
              payload as OwnerJson,
              { signal },
            )
            : isEffectState
            ? await owner.project(
              admitted,
              "effect.state",
              payload as OwnerJson,
              { signal },
            )
            : isCommand
            ? await owner.execute(admitted, object(payload) as OwnerCommand, {
              signal,
            })
            : context.workload === PROJECT
            ? await (() => {
              const request = object(payload);
              if (
                Object.keys(request).some((key) =>
                  key !== "kind" && key !== "input"
                ) || typeof request.kind !== "string" ||
                !Object.hasOwn(request, "input")
              ) {
                throw new TypeError("Invalid owner projection request.");
              }
              return owner.project(
                admitted,
                request.kind,
                request.input as OwnerJson,
                { signal },
              );
            })()
            : await owner.readReceipt(admitted, receiptIdentity(payload));
        committed = isCommand || context.workload === ACTION ||
          context.workload === ACTION_CALL ||
          context.workload === CHILD_ACTION ||
          context.workload === CHILD_PREPARATION;
        if (
          context.workload === PROJECT || context.workload === ACTION_RESULT ||
          isEffectState || context.workload === CHILD_RESULT
        ) {
          signal.throwIfAborted();
          context.signal.throwIfAborted();
        }
        const reply = context.workload === RECEIPT && result
          ? {
            kind: (result as OwnerReceipt).kind,
            result: (result as OwnerReceipt).result,
          }
          : result;
        return encode({ ok: true, value: reply ?? null });
      } catch (error) {
        // SQL, grants and protected values must never leak via error strings.
        const code = error && typeof error === "object" && "code" in error &&
            typeof error.code === "string"
          ? error.code
          : "owner_call_rejected";
        return encode({
          ok: false,
          outcome: committed ||
              (error !== null && typeof error === "object" &&
                "indeterminate" in error && error.indeterminate === true) ||
              ["owner_commit_unknown", "persistence_indeterminate"].includes(
                code,
              )
            ? "unknown"
            : "refused",
          code: ERROR_CODES.has(code) ? code : "owner_call_rejected",
        });
      }
    };
  };
  return {
    admit: (context: OwnerWorkerCallContext) => admit(context, false),
    admitUnassigned: (context: OwnerWorkerCallContext) => admit(context, true),
  };
}

export class OwnerCallRejected extends Error {
  constructor(
    readonly code: string,
    readonly outcome: "unknown" | "refused" = "refused",
  ) {
    super(
      outcome === "unknown"
        ? "Owner outcome is unknown; recover the receipt before retrying."
        : "The owner rejected the call.",
    );
    this.name = "OwnerCallRejected";
  }
}

/** No persistence and no retry loop live on the worker. A transport failure can
 * be indeterminate; callers recover an application receipt before retrying. */
export function createOwnerConnection(
  options: Readonly<{ ownerId: string; callHost: OwnerHostCaller }>,
) {
  if (!options.ownerId.trim()) throw new TypeError("Owner ID is required.");
  const ownerId = options.ownerId;
  const callHost = options.callHost;
  async function call(
    workload: string,
    payload: unknown,
    callOptions: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }> = {},
  ): Promise<unknown> {
    callOptions.signal?.throwIfAborted();
    const controller = new AbortController();
    const abort = () => controller.abort(callOptions.signal?.reason);
    callOptions.signal?.addEventListener("abort", abort, { once: true });
    if (callOptions.signal?.aborted) abort();
    const signal = controller.signal;
    let rejectAbort!: (reason: unknown) => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const onAbort = () => rejectAbort(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    let handle: Awaited<ReturnType<OwnerHostCaller>> | undefined;
    let transportComplete = false;
    try {
      const opening = callHost({
        workload,
        metadata: { ownerId },
        body: encode(payload),
        ...callOptions,
        signal,
      });
      void opening.then((late) => {
        if (signal.aborted) {
          void late.cancel("owner call cancelled").catch(() => undefined);
        }
      }, () => undefined);
      handle = await Promise.race([opening, aborted]);
      // A rejected terminal must interrupt a stalled output stream immediately.
      const terminalFailure = handle.completed.then(() =>
        new Promise<never>(() => {})
      );
      const reply = object(
        await Promise.race([
          read(handle.output, signal),
          terminalFailure,
          aborted,
        ]),
      );
      await Promise.race([handle.completed, aborted]);
      transportComplete = true;
      if (reply.ok === false && typeof reply.code === "string") {
        throw new OwnerCallRejected(
          reply.code,
          reply.outcome === "unknown" ? "unknown" : "refused",
        );
      }
      if (reply.ok !== true || !("value" in reply)) {
        throw new TypeError("Invalid owner reply.");
      }
      return reply.value;
    } catch (error) {
      // A decoded application refusal after terminal completion needs no wire
      // cancellation; a late Cancel can target an already retired stream.
      if (!transportComplete) {
        controller.abort(error);
        void handle?.cancel("owner call failed").catch(() => undefined);
      }
      throw error;
    } finally {
      callOptions.signal?.removeEventListener("abort", abort);
      signal.removeEventListener("abort", onAbort);
    }
  }
  return {
    /** Must be repeated for each new transport session; this grants no ctx authority. */
    async ready(
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<void> {
      const reply = object(
        await call(READY, { protocol: PROTOCOL }, callOptions),
      );
      if (
        Object.keys(reply).length !== 3 || reply.protocol !== PROTOCOL ||
        reply.ownerId !== ownerId ||
        JSON.stringify(reply.features) !== JSON.stringify(FEATURES)
      ) {
        throw new TypeError("Owner readiness protocol mismatch.");
      }
    },
    /** Fixed root route, requiring separately authenticated current ingress policy. */
    async admitAction(
      command: OwnerInputCommand,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerCommandOutcome> {
      if (command.kind !== "action.admit" || command.domain !== "logical") {
        throw new TypeError("Invalid named Action admission request.");
      }
      return await call(ACTION, command, callOptions) as OwnerCommandOutcome;
    },
    async callAction(
      request: OwnerActionCallRequest,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerCommandOutcome> {
      return await call(
        ACTION_CALL,
        actionCallRequest(request),
        callOptions,
      ) as OwnerCommandOutcome;
    },
    async admitChildAction(
      command: OwnerInputCommand,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerCommandOutcome> {
      if (
        command.kind !== "action.child-admit" || command.domain !== "logical"
      ) {
        throw new TypeError("Invalid child Action admission request.");
      }
      return await call(
        CHILD_ACTION,
        command,
        callOptions,
      ) as OwnerCommandOutcome;
    },
    /** Registered owner preparation only; no rendered input or factory crosses the wire. */
    async prepareChildAction(
      command: OwnerInputCommand,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerCommandOutcome> {
      if (
        command.kind !== "action.child-prepare" || command.domain !== "logical"
      ) {
        throw new TypeError("Invalid child Action preparation request.");
      }
      return await call(
        CHILD_PREPARATION,
        command,
        callOptions,
      ) as OwnerCommandOutcome;
    },
    async childActionResult(
      reference: OwnerJson,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerJson> {
      return await call(CHILD_RESULT, reference, callOptions) as OwnerJson;
    },
    async actionResult(
      reference: OwnerJson,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerJson> {
      return await call(ACTION_RESULT, reference, callOptions) as OwnerJson;
    },
    async execute(
      command: OwnerCommand,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerCommandOutcome> {
      return await call(COMMAND, command, callOptions) as OwnerCommandOutcome;
    },
    /** Restricted current-assignment settlement, separate from general ctx grants. */
    async complete(
      command: OwnerCommand | OwnerInputCommand,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerCommandOutcome> {
      if (
        !((command.kind === "execution.complete" &&
          command.domain === "logical") ||
          (command.kind === "processor.complete" &&
            command.domain === "incarnation"))
      ) {
        throw new TypeError("Invalid restricted completion command.");
      }
      return await call(COMPLETE, command, callOptions) as OwnerCommandOutcome;
    },
    async effectSettle(
      command: OwnerCommand,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerCommandOutcome> {
      if (
        !["effect.confirm", "effect.notStarted"].includes(command.kind) ||
        command.domain !== "logical"
      ) {
        throw new TypeError("Invalid restricted effect settlement.");
      }
      return await call(
        EFFECT_SETTLE,
        command,
        callOptions,
      ) as OwnerCommandOutcome;
    },
    async effectState(
      reference: OwnerJson,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerJson> {
      return await call(EFFECT_STATE, reference, callOptions) as OwnerJson;
    },
    async project(
      kind: string,
      input: OwnerJson,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<OwnerJson> {
      return await call(PROJECT, { kind, input }, callOptions) as OwnerJson;
    },
    async readReceipt(
      identity: ReceiptIdentity,
      callOptions?: Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>,
    ): Promise<RecoveryReceipt | undefined> {
      return (await call(RECEIPT, identity, callOptions) ?? undefined) as
        | RecoveryReceipt
        | undefined;
    },
  };
}
