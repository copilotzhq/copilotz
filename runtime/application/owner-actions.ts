/** Pure ordinary Action facade shared by owner-backed placements. Admission is
 * sent once; result polling never replays admission or exposes receipt envelopes. */
import type {
  ActionCallers,
  ActionCallOptions,
  ActionMap,
} from "../actions/types.ts";
import type { OwnerCommandOutcome, OwnerJson } from "../owner/boundary.ts";
import type { OwnerActionCallRequest } from "../owner/connection.ts";
import { assertJsonValue } from "../json.ts";

type CallOptions = Readonly<{ signal?: AbortSignal; deadlineAtMs?: number }>;
function failure(code: string): Error {
  return Object.assign(new Error(code), { code });
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw failure("action_result_unavailable");
  }
  return value as Record<string, unknown>;
}
function cloneJson(value: unknown): OwnerJson {
  assertJsonValue(value, {
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1_000_000) {
    throw failure("action_data_limit");
  }
  return structuredClone(value) as OwnerJson;
}
function bounded(value: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new TypeError("Invalid Action wait capacity.");
  }
  return value;
}
async function race<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([pending, stopped]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}
function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}
export function createOwnerActionCallers<A extends ActionMap>(
  options: Readonly<{
    actions: A;
    namespace: string;
    port: Readonly<{
      callAction(
        request: OwnerActionCallRequest,
        options?: CallOptions,
      ): Promise<OwnerCommandOutcome>;
      actionResult(
        reference: OwnerJson,
        options?: CallOptions,
      ): Promise<OwnerJson>;
    }>;
    maxPending?: number;
    maxWaitMs?: number;
    pollMs?: number;
  }>,
) {
  if (typeof options.namespace !== "string" || !options.namespace.trim()) {
    throw new TypeError("Action namespace is required.");
  }
  const namespace = options.namespace;
  const maxPending = bounded(options.maxPending ?? 64, 10_000);
  const maxWaitMs = bounded(options.maxWaitMs ?? 30_000, 120_000);
  const pollMs = bounded(options.pollMs ?? 10, 10_000);
  const port = {
    callAction: options.port.callAction,
    actionResult: options.port.actionResult,
  };
  const lifetime = new AbortController();
  let pending = 0;
  const actions: Record<string, unknown> = Object.create(null);
  for (const [alias, definition] of Object.entries(options.actions)) {
    const actionId = definition.id;
    if (typeof actionId !== "string" || !actionId.trim()) {
      throw new TypeError("Registered Action ID is required.");
    }
    const call = async (
      input: unknown,
      callOptions: ActionCallOptions = {},
    ): Promise<OwnerJson> => {
      if (
        Object.keys(callOptions).some((key) =>
          key !== "operationKey" && key !== "signal"
        )
      ) throw failure("action_options_unavailable");
      if (
        callOptions.operationKey !== undefined &&
        typeof callOptions.operationKey !== "string"
      ) throw new TypeError("Invalid Action operation key.");
      const operationKey = callOptions.operationKey?.trim() || undefined;
      lifetime.signal.throwIfAborted();
      callOptions.signal?.throwIfAborted();
      const captured = cloneJson(input);
      if (pending >= maxPending) throw failure("action_capacity_exceeded");
      pending++;
      const outstanding = new Set<Promise<unknown>>();
      const control = new AbortController();
      const signal = AbortSignal.any([
        lifetime.signal,
        control.signal,
        ...(callOptions.signal ? [callOptions.signal] : []),
      ]);
      const deadlineAtMs = Date.now() + maxWaitMs;
      const timer = setTimeout(
        () => control.abort(failure("action_wait_expired")),
        maxWaitMs,
      );
      const invoke = <T>(run: () => Promise<T>): Promise<T> => {
        const work = Promise.resolve().then(() => {
          signal.throwIfAborted();
          return run();
        });
        outstanding.add(work);
        void work.finally(() => outstanding.delete(work)).catch(() =>
          undefined
        );
        return race(work, signal);
      };
      let admittedReference: OwnerJson | undefined;
      let admissionStarted = false;
      let admissionReturned = false;
      try {
        const outcome = await invoke(() => {
          admissionStarted = true;
          return port.callAction({
            actionAlias: alias,
            input: captured,
            ...(operationKey === undefined ? {} : { operationKey }),
          }, { signal, deadlineAtMs });
        });
        admissionReturned = true;
        signal.throwIfAborted();
        if (!["committed", "duplicate"].includes(outcome.status)) {
          throw failure("action_result_unavailable");
        }
        const ref = record(cloneJson(outcome.result));
        const fields = [
          "namespace",
          "actionId",
          "executionId",
          "eventId",
          "deliveryId",
        ];
        if (
          Object.keys(ref).length !== fields.length || fields.some((key) =>
            typeof ref[key] !== "string" || !(ref[key] as string).trim()
          ) || ref.namespace !== namespace || ref.actionId !== actionId
        ) {
          throw failure("action_result_unavailable");
        }
        admittedReference = structuredClone(ref) as OwnerJson;
        while (true) {
          const result = record(
            cloneJson(
              await invoke(() =>
                port.actionResult(structuredClone(ref) as OwnerJson, {
                  signal,
                  deadlineAtMs,
                })
              ),
            ),
          );
          signal.throwIfAborted();
          if (
            result.status === "completed" && Object.keys(result).length === 2 &&
            Object.hasOwn(result, "output")
          ) {
            return cloneJson(result.output);
          }
          if (result.status === "pending" && Object.keys(result).length === 1) {
            await pause(pollMs, signal);
            continue;
          }
          if (
            Object.keys(result).length === 2 && result.status === "failed" &&
            (result.code === "action_failed" ||
              result.code === "action_not_completed")
          ) {
            throw failure(result.code);
          }
          if (
            Object.keys(result).length === 2 && result.status === "cancelled" &&
            result.code === "action_cancelled"
          ) {
            throw failure("action_cancelled");
          }
          throw failure("action_result_unavailable");
        }
      } catch (error) {
        if (signal.aborted && admittedReference !== undefined) {
          // This ends only the caller wait, not the durable Action. Retain safe
          // coordinates for explicit current-authorized recovery by the facade.
          throw Object.assign(failure("action_wait_interrupted"), {
            reference: structuredClone(admittedReference),
            admitted: true,
            cause: error,
          });
        }
        if (
          (signal.aborted && admissionStarted) ||
          (admissionReturned && admittedReference === undefined)
        ) {
          throw Object.assign(failure("action_admission_unknown"), {
            indeterminate: true,
            outcome: "unknown",
            actionAlias: alias,
            ...(operationKey === undefined ? {} : { operationKey }),
            cause: error,
          });
        }
        throw error;
      } finally {
        clearTimeout(timer);
        control.abort(failure("action_call_closed"));
        // A noncooperative port retains its reservation until it actually settles.
        if (outstanding.size) {
          void Promise.allSettled([...outstanding]).then(() => {
            pending--;
          });
        } else pending--;
      }
    };
    actions[alias] = Object.assign(call, {
      prepare: () => Promise.reject(failure("action_prepare_unavailable")),
      prepareNamed: () => Promise.reject(failure("action_prepare_unavailable")),
    });
  }
  return {
    actions: actions as ActionCallers<A>,
    close() {
      lifetime.abort(failure("action_facade_closed"));
    },
    snapshot: () => ({ pending, closed: lifetime.signal.aborted }),
  };
}
