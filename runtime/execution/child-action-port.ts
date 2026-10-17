/** Private data-only child Action capability. Routing coordinates are assertions,
 * never authority. Waiting and cancellation stay outside owner transactions. */
import type { PluginRegistry } from "../plugins/registry.ts";
import type {
  OwnerCommandExecuteOptions,
  OwnerCommandOutcome,
  OwnerInputCommand,
  OwnerJson,
} from "../owner/boundary.ts";
import { assertJsonValue } from "../json.ts";
import {
  type ActionNamedPreparation,
  normalizeActionNamedPreparation,
  OWNER_CHILD_ACTION_PREPARATION,
  ownerPreparationChildKey,
  ownerPreparationKey,
} from "./preparation-call.ts";

export const OWNER_CHILD_ACTION_ADMISSION = "action.child-admit";
export const OWNER_CHILD_ACTION_RESULT = "action.child-result";
export type OwnerChildActionParentReference = Readonly<{
  deliveryId: string;
  dispatchAttemptId: string;
  operationKey: string;
}>;
export type OwnerChildActionReference = Readonly<{
  namespace: string;
  actionId: string;
  executionId: string;
  eventId: string;
  deliveryId: string;
}>;
export const ownerChildActionKey = (
  ownerId: string,
  namespace: string,
  parentOperationKey: string,
  actionId: string,
  operationKey: string,
): string =>
  JSON.stringify([
    OWNER_CHILD_ACTION_ADMISSION,
    ownerId,
    namespace,
    parentOperationKey,
    actionId,
    operationKey,
  ]);

function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) throw new TypeError("Invalid child Action coordinate.");
}
function fail(code: string): never {
  throw Object.assign(new Error(code), { code });
}
function resultReference(value: unknown): OwnerChildActionReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("action_result_unavailable");
  }
  const data = value as Record<string, unknown>;
  const keys = [
    "namespace",
    "actionId",
    "executionId",
    "eventId",
    "deliveryId",
  ];
  if (
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(data, key))
  ) return fail("action_result_unavailable");
  for (const key of keys) text(data[key]);
  return structuredClone(data) as OwnerChildActionReference;
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function cancellable<T>(
  pending: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export function createOwnerChildActionPort(
  options: Readonly<{
    ownerId: string;
    namespace: string;
    parentOperationKey: string;
    registry: Pick<PluginRegistry, "actions">;
    port: Readonly<{
      executeInput(
        command: OwnerInputCommand,
        options?: OwnerCommandExecuteOptions,
      ): Promise<OwnerCommandOutcome>;
      /** Separate fixed parent-bound preparation route. No generic fallback. */
      prepareInput?(
        command: OwnerInputCommand,
        options?: OwnerCommandExecuteOptions,
      ): Promise<OwnerCommandOutcome>;
      project(
        kind: string,
        input: OwnerJson,
        options?: OwnerCommandExecuteOptions,
      ): Promise<OwnerJson>;
    }>;
    /** A timeout only stops this wait. Durable admission remains recoverable.
     * It also bounds dependent calls when their parent occupies all capacity. */
    maxWaitMs?: number;
    pollMs?: number;
    /** Unsettled transport calls retain a slot after local cancellation. */
    maxPendingCalls?: number;
  }>,
) {
  for (
    const value of [
      options.ownerId,
      options.namespace,
      options.parentOperationKey,
    ]
  ) {
    text(value);
  }
  const { ownerId, namespace, parentOperationKey } = options;
  const actions = Object.fromEntries(
    Object.entries(options.registry.actions).map((
      [alias, action],
    ) => [alias, action.id]),
  );
  const executeInput = options.port.executeInput.bind(options.port);
  const prepareInput = options.port.prepareInput?.bind(options.port);
  const project = options.port.project.bind(options.port);
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  const pollMs = options.pollMs ?? 10;
  const limit = options.maxPendingCalls ?? 32;
  let active = 0;
  let requests = 0;
  async function request<T>(run: () => Promise<T>): Promise<T> {
    if (requests >= limit) return fail("owner_admission_refused");
    requests++;
    try {
      return await run();
    } finally {
      requests--;
    }
  }
  if (
    !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1 || maxWaitMs > 60_000 ||
    !Number.isSafeInteger(pollMs) || pollMs < 1 || pollMs > 1_000 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 128
  ) throw new TypeError("Child Action waits require positive bounded timing.");
  async function run(
    reference: Readonly<{ deliveryId: string; dispatchAttemptId: string }>,
    actionAlias: string,
    input: OwnerJson,
    operationKey: string,
    callOptions: OwnerCommandExecuteOptions = {},
    prepared?: ActionNamedPreparation,
  ): Promise<OwnerJson> {
    if (Object.keys(callOptions).some((key) => key !== "signal")) {
      throw new TypeError(
        "Child Action metadata, identity and preparation are unsupported.",
      );
    }
    if (
      !reference || Object.keys(reference).length !== 2 ||
      !Object.hasOwn(reference, "deliveryId") ||
      !Object.hasOwn(reference, "dispatchAttemptId")
    ) throw new TypeError("Invalid child Action parent selector.");
    for (
      const value of [
        reference.deliveryId,
        reference.dispatchAttemptId,
        actionAlias,
        operationKey,
      ]
    ) {
      text(value);
    }
    const actionId = Object.hasOwn(actions, actionAlias)
      ? actions[actionAlias]
      : undefined;
    if (!actionId) throw new TypeError("Unknown registered child Action.");
    const admit = prepared ? prepareInput : executeInput;
    if (!admit) return fail("action_prepare_unavailable");
    assertJsonValue(input, {
      maxDepth: 64,
      maxNodes: 100_000,
      rejectNegativeZero: true,
    });
    const parent: OwnerChildActionParentReference = {
      ...reference,
      operationKey: parentOperationKey,
    };
    const childKey = prepared
      ? ownerPreparationChildKey(prepared.preparation, operationKey)
      : operationKey;
    const logicalKey = prepared
      ? ownerPreparationKey(
        ownerId,
        namespace,
        parent.operationKey,
        prepared.preparation,
        operationKey,
      )
      : ownerChildActionKey(
        ownerId,
        namespace,
        parent.operationKey,
        actionId,
        operationKey,
      );
    const command: OwnerInputCommand = prepared
      ? {
        kind: OWNER_CHILD_ACTION_PREPARATION,
        domain: "logical",
        key: logicalKey,
        input: {
          parent,
          targetActionId: actionId,
          preparation: prepared.preparation,
          recordId: prepared.recordId,
          hints: { mode: prepared.mode, renderer: "text" },
          operationKey,
        },
      }
      : {
        kind: OWNER_CHILD_ACTION_ADMISSION,
        domain: "logical",
        key: logicalKey,
        input: {
          parent,
          actionAlias,
          input: structuredClone(input),
          operationKey,
        },
      };
    // Construct and validate all potentially throwing request state before
    // reserving the shared direct/named wait slot.
    const control = new AbortController();
    const signal = callOptions.signal
      ? AbortSignal.any([callOptions.signal, control.signal])
      : control.signal;
    if (active >= limit || requests >= limit) {
      return fail("owner_admission_refused");
    }
    active++;
    const timer = setTimeout(() => {
      control.abort(
        Object.assign(new Error("Child Action remains pending."), {
          code: "child_action_pending",
        }),
      );
    }, maxWaitMs);
    let admission: "not_started" | "pending" | "returned" | "rejected" =
      "not_started";
    let admitted: OwnerChildActionReference | undefined;
    let dispatched = false;
    let interruptedAdmission = false;
    const interrupted = () => {
      if (dispatched && !admitted) interruptedAdmission = true;
    };
    signal.addEventListener("abort", interrupted, { once: true });
    try {
      signal.throwIfAborted();
      const outcome = await cancellable(
        request(async () => {
          admission = "pending";
          dispatched = true;
          try {
            const result = await admit(command, { signal });
            admission = "returned";
            return result;
          } catch (error) {
            admission = "rejected";
            throw error;
          }
        }),
        signal,
      );
      if (!["committed", "duplicate"].includes(outcome.status)) {
        return fail("action_result_unavailable");
      }
      const child = resultReference(outcome.result);
      if (
        child.namespace !== namespace ||
        child.actionId !== actionId ||
        child.executionId !==
          `${parent.operationKey}/action:${actionId}:${childKey}`
      ) return fail("action_result_unavailable");
      admitted = child;
      signal.throwIfAborted();
      while (true) {
        const result = await cancellable(
          request(() =>
            project(OWNER_CHILD_ACTION_RESULT, {
              parent,
              reference: child,
            }, { signal })
          ),
          signal,
        );
        signal.throwIfAborted();
        if (!result || typeof result !== "object" || Array.isArray(result)) {
          return fail("action_result_unavailable");
        }
        const data = result as Record<string, OwnerJson>;
        if (
          data.status === "completed" && Object.keys(data).length === 2 &&
          Object.hasOwn(data, "output")
        ) {
          assertJsonValue(data.output, {
            maxDepth: 64,
            maxNodes: 100_000,
            rejectNegativeZero: true,
          });
          return structuredClone(data.output);
        }
        if (
          Object.keys(data).length === 2 && data.status === "failed" &&
          typeof data.code === "string" &&
          ["action_failed", "action_not_completed"].includes(data.code)
        ) {
          return fail(data.code);
        }
        if (
          Object.keys(data).length === 2 && data.status === "cancelled" &&
          data.code === "action_cancelled"
        ) {
          return fail("action_cancelled");
        }
        if (Object.keys(data).length !== 1 || data.status !== "pending") {
          return fail("action_result_unavailable");
        }
        await pause(pollMs, signal);
      }
    } catch (error) {
      // Local interruption cannot prove an in-flight admission did not commit.
      // Preserve its logical identity for owner receipt recovery; the request
      // reservation remains held until the underlying transport settles.
      const status: string = admission;
      const details = error && typeof error === "object"
        ? error as {
          code?: unknown;
          indeterminate?: unknown;
          outcome?: unknown;
        }
        : {};
      if (
        !admitted &&
        (interruptedAdmission || status === "pending" ||
          status === "returned" ||
          details.indeterminate === true || details.outcome === "unknown" ||
          ["owner_commit_unknown", "persistence_indeterminate"].includes(
            String(details.code),
          ))
      ) {
        throw Object.assign(
          new Error(
            error instanceof Error
              ? error.message
              : "Child Action admission is uncertain.",
            { cause: error },
          ),
          {
            code: "action_admission_unknown",
            indeterminate: true,
            outcome: "unknown",
            actionAlias,
            operationKey,
            logicalKey,
          },
        );
      }
      if (admitted && signal.aborted) {
        throw Object.assign(
          new Error(
            error instanceof Error
              ? error.message
              : "Child Action wait interrupted.",
            { cause: error },
          ),
          {
            code: "action_wait_interrupted",
            admitted: true,
            actionAlias,
            operationKey,
            logicalKey,
            reference: structuredClone(admitted),
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", interrupted);
      active--;
    }
  }
  return {
    call(
      reference: Readonly<{ deliveryId: string; dispatchAttemptId: string }>,
      actionAlias: string,
      input: OwnerJson,
      operationKey: string,
      callOptions: OwnerCommandExecuteOptions = {},
    ): Promise<OwnerJson> {
      return run(reference, actionAlias, input, operationKey, callOptions);
    },
    prepare(
      reference: Readonly<{ deliveryId: string; dispatchAttemptId: string }>,
      actionAlias: string,
      preparation: ActionNamedPreparation,
      operationKey: string,
      callOptions: OwnerCommandExecuteOptions = {},
    ): Promise<OwnerJson> {
      const normalized = normalizeActionNamedPreparation(preparation, {
        ...callOptions,
        operationKey,
      });
      return run(reference, actionAlias, null, normalized.operationKey, {
        ...(normalized.signal ? { signal: normalized.signal } : {}),
      }, normalized.request);
    },
  };
}
