/** Private invocation-bound effect data/client seam. No SQL, storage or provider
 * imports are reachable at runtime. Shared helpers below are internal contracts
 * for the adjacent owner handler, not exports from the public package surface. */
import { assertJsonValue } from "../json.ts";
import type {
  OwnerCommand,
  OwnerCommandExecuteOptions,
  OwnerCommandOutcome,
  OwnerJson,
} from "./boundary.ts";

export type OwnerEffectReference = Readonly<{
  namespace: string;
  actionRunId: string;
  step: string;
}>;
/** An opaque reference to evidence the owner can verify and bind to this effect.
 * Neither a worker assertion nor the transport's parsed output is evidence. */
export type OwnerEffectEvidence = Readonly<{
  source: string;
  reference: string;
}>;
export type OwnerEffectState =
  | Readonly<{ status: "none" }>
  | Readonly<{ status: "indeterminate" }>
  | Readonly<{ status: "not_started" }>
  | Readonly<{ status: "replay"; outcome: OwnerJson }>;
export type OwnerEffectBegin =
  | Exclude<OwnerEffectState, { status: "none" }>
  | Readonly<{ status: "proceed" }>;
export type OwnerEffectOperation = "begin" | "confirm" | "notStarted";
export type OwnerEffectRecord =
  & OwnerEffectReference
  & (
    | Readonly<{ status: "none" | "begun" | "not_started" }>
    | Readonly<{ status: "confirmed"; outcome: OwnerJson }>
  );
export function fail(code: string, message: string): never {
  throw Object.assign(new Error(message), { name: "OwnerEffectError", code });
}
export function copy<T>(value: T): T {
  assertJsonValue(value, {
    label: "Effect data",
    maxDepth: 64,
    maxNodes: 100_000,
    rejectNegativeZero: true,
  });
  if (
    new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024
  ) {
    fail("effect_data_invalid", "Effect data exceeds its byte limit.");
  }
  return structuredClone(value);
}
export function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    fail(
      "effect_data_invalid",
      "Effect identity must be a bounded nonempty string.",
    );
  }
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  const data = copy(value);
  if (
    !data || typeof data !== "object" || Array.isArray(data) ||
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(data, key))
  ) {
    fail("effect_data_invalid", "Invalid effect data fields.");
  }
  return data as Record<string, unknown>;
}
function reference(value: unknown): OwnerEffectReference {
  const data = object(value, ["namespace", "actionRunId", "step"]);
  text(data.namespace);
  text(data.actionRunId);
  text(data.step);
  return {
    namespace: data.namespace,
    actionRunId: data.actionRunId,
    step: data.step,
  };
}
function proof(value: unknown): OwnerEffectEvidence {
  const data = object(value, ["source", "reference"]);
  text(data.source);
  text(data.reference);
  return { source: data.source, reference: data.reference };
}
export function sameReference(
  actual: OwnerEffectReference,
  expected: OwnerEffectReference,
): void {
  if (
    actual.namespace !== expected.namespace ||
    actual.actionRunId !== expected.actionRunId || actual.step !== expected.step
  ) {
    fail(
      "effect_binding_invalid",
      "Effect belongs to a different invocation or step.",
    );
  }
}
export function intent(value: unknown, operation?: OwnerEffectOperation) {
  const data = object(value, [
    "namespace",
    "actionRunId",
    "step",
    ...(operation === "confirm"
      ? ["outcome"]
      : operation === "notStarted"
      ? ["evidence"]
      : []),
  ]);
  const ref = reference({
    namespace: data.namespace,
    actionRunId: data.actionRunId,
    step: data.step,
  });
  return {
    ref,
    ...(operation === "confirm"
      ? { outcome: copy(data.outcome) as OwnerJson }
      : {}),
    ...(operation === "notStarted" ? { evidence: proof(data.evidence) } : {}),
  };
}
/** Logical identity excludes worker, assignment, attempt and owner epoch. */
export function ownerEffectKey(
  ownerId: string,
  target: OwnerEffectReference,
  operation: OwnerEffectOperation,
): string {
  text(ownerId);
  const ref = reference(target);
  if (!["begin", "confirm", "notStarted"].includes(operation)) {
    fail("effect_data_invalid", "Invalid effect operation.");
  }
  const key = JSON.stringify([
    "effect",
    ownerId,
    ref.namespace,
    ref.actionRunId,
    ref.step,
    operation,
  ]);
  text(key);
  return key;
}
export function record(
  value: unknown,
  ref: OwnerEffectReference,
): OwnerEffectRecord {
  const status = (copy(value) as { status?: unknown } | null)?.status;
  const data = object(value, [
    "namespace",
    "actionRunId",
    "step",
    "status",
    ...(status === "confirmed" ? ["outcome"] : []),
  ]);
  sameReference(
    reference({
      namespace: data.namespace,
      actionRunId: data.actionRunId,
      step: data.step,
    }),
    ref,
  );
  if (status === "confirmed") {
    return { ...ref, status, outcome: data.outcome as OwnerJson };
  }
  if (status !== "none" && status !== "begun" && status !== "not_started") {
    fail("effect_state_invalid", "Invalid effect receipt state.");
  }
  return { ...ref, status };
}
function state(value: OwnerEffectRecord): OwnerEffectState {
  if (value.status === "confirmed") {
    return { status: "replay", outcome: copy(value.outcome) };
  }
  return { status: value.status === "begun" ? "indeterminate" : value.status };
}

export type OwnerEffectPort = Readonly<{
  /** Must resolve only after known outer commit and transport completion. */
  execute(
    command: OwnerCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
  /** Narrow current settlement route, distinct from ordinary ctx mutations. */
  settle(
    command: OwnerCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
  project(
    kind: string,
    input: OwnerJson,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
}>;
/** Invocation-bound data client, with no hidden retry. Historical receipt reads
 * contain only begun references and can never authorize another dispatch. */
export function createOwnerEffectClient(
  options: Readonly<{
    ownerId: string;
    namespace: string;
    actionRunId: string;
    port: OwnerEffectPort;
  }>,
) {
  const { ownerId, namespace, actionRunId, port } = options;
  text(ownerId);
  text(namespace);
  text(actionRunId);
  const ref = (step: string) => reference({ namespace, actionRunId, step });
  const build = (
    operation: OwnerEffectOperation,
    target: OwnerEffectReference,
    extra: Record<string, OwnerJson> = {},
  ): OwnerCommand => ({
    kind: `effect.${operation}`,
    domain: "logical",
    key: ownerEffectKey(ownerId, target, operation),
    intent: { ...target, ...extra },
  });
  const inspect = async (
    step: string,
    callOptions?: OwnerCommandExecuteOptions,
  ): Promise<OwnerEffectState> => {
    const target = ref(step);
    return state(
      record(await port.project("effect.state", target, callOptions), target),
    );
  };
  return {
    inspect,
    async begin(
      step: string,
      callOptions?: OwnerCommandExecuteOptions,
    ): Promise<OwnerEffectBegin> {
      const target = ref(step);
      const outcome = await port.execute(build("begin", target), callOptions);
      if (record(outcome.result, target).status !== "begun") {
        fail("effect_state_invalid", "Invalid begin acknowledgement.");
      }
      if (outcome.status === "committed") {
        callOptions?.signal?.throwIfAborted();
        return { status: "proceed" };
      }
      if (outcome.status !== "duplicate") {
        fail("effect_state_invalid", "Invalid command outcome.");
      }
      const current = await inspect(step, callOptions);
      if (current.status === "none") {
        fail("effect_state_invalid", "Begin receipt is missing.");
      }
      return current;
    },
    async confirm(
      step: string,
      outcome: OwnerJson,
      callOptions?: OwnerCommandExecuteOptions,
    ): Promise<void> {
      const target = ref(step);
      const result = await port.settle(
        build("confirm", target, { outcome: copy(outcome) }),
        callOptions,
      );
      if (
        !["committed", "duplicate"].includes(result.status) ||
        record(result.result, target).status !== "confirmed"
      ) fail("effect_state_invalid", "Invalid confirmation acknowledgement.");
    },
    async notStarted(
      step: string,
      evidence: OwnerEffectEvidence,
      callOptions?: OwnerCommandExecuteOptions,
    ): Promise<void> {
      const target = ref(step);
      const result = await port.settle(
        build("notStarted", target, { evidence: proof(evidence) }),
        callOptions,
      );
      if (
        !["committed", "duplicate"].includes(result.status) ||
        record(result.result, target).status !== "not_started"
      ) fail("effect_state_invalid", "Invalid no-start acknowledgement.");
    },
  };
}
