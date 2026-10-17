/** Data-only mapping shared by in-process and connected registered workers. */
import type {
  OwnerCommand,
  OwnerCommandExecuteOptions,
  OwnerCommandOutcome,
  OwnerJson,
  OwnerReceipt,
} from "../owner/boundary.ts";
import type {
  RegisteredExecutionProjection,
  RegisteredExecutionReceipt,
  RegisteredExecutionReference,
  RegisteredOwnerExecutionPort,
} from "./registered-worker.ts";

export const ownerClaimKey = (
  ownerId: string,
  assignmentId: string,
  sessionId: string,
): string =>
  JSON.stringify(["execution.claim", ownerId, assignmentId, sessionId]);
export const ownerCompletionKey = (
  ownerId: string,
  namespace: string,
  actionRunId: string,
): string =>
  JSON.stringify(["execution.complete", ownerId, namespace, actionRunId]);

type DataPort = Readonly<{
  execute(
    command: OwnerCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
  complete(
    command: OwnerCommand,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerCommandOutcome>;
  project(
    kind: string,
    input: OwnerJson,
    options?: OwnerCommandExecuteOptions,
  ): Promise<OwnerJson>;
  readReceipt(
    identity: Readonly<{ domain: "logical" | "incarnation"; key: string }>,
    options?: OwnerCommandExecuteOptions,
  ): Promise<Pick<OwnerReceipt, "kind" | "result"> | undefined>;
}>;
function refuse(): never {
  throw Object.assign(
    new Error("Execution receipt recovery is unavailable for this assignment."),
    { code: "registered_worker_replay_refused" },
  );
}
function reference(value: unknown): RegisteredExecutionReference {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return refuse();
  }
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 3 ||
    ["executionId", "deliveryId", "dispatchAttemptId"].some((key) =>
      typeof data[key] !== "string" || !(data[key] as string).trim()
    )
  ) return refuse();
  return {
    executionId: data.executionId as string,
    deliveryId: data.deliveryId as string,
    dispatchAttemptId: data.dispatchAttemptId as string,
  };
}
function terminal(
  value: unknown,
  expected: RegisteredExecutionReference,
): RegisteredExecutionReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return refuse();
  }
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 4 ||
    !["completed", "failed", "cancelled"].includes(String(data.status))
  ) return refuse();
  const actual = reference({
    executionId: data.executionId,
    deliveryId: data.deliveryId,
    dispatchAttemptId: data.dispatchAttemptId,
  });
  if (
    Object.keys(actual).some((key) =>
      actual[key as keyof typeof actual] !==
        expected[key as keyof typeof expected]
    )
  ) return refuse();
  return {
    ...actual,
    status: data.status as RegisteredExecutionReceipt["status"],
  };
}
/** Routing coordinates are not authority; the owner resolves current assignment
 * identity independently. Recovery returns only exact safe references and never
 * supplies input or permission to rerun an ambiguously claimed invocation.
 * The supplied data port must be permanently bound to one authenticated parent
 * WorkContext/session; never share or rebind it across concurrent assignments. */
export function createRegisteredOwnerExecutionPort(
  options: Readonly<{ ownerId: string; namespace: string; port: DataPort }>,
): RegisteredOwnerExecutionPort {
  const { ownerId, namespace, port } = options;
  if (
    ![ownerId, namespace].every((value) =>
      typeof value === "string" && value.trim()
    )
  ) throw new TypeError("Owner routing coordinates must be nonempty.");
  let assignmentKey: string | undefined;
  let attemptedClaim = false;
  let claimed: RegisteredExecutionReference | undefined;
  const requireClaim = (ref: RegisteredExecutionReference) => {
    if (
      !claimed ||
      Object.keys(claimed).some((key) =>
        claimed![key as keyof typeof claimed] !== ref[key as keyof typeof ref]
      )
    ) return refuse();
  };
  const readCompletion: RegisteredOwnerExecutionPort["readCompletion"] = async (
    input,
    callOptions,
  ) => {
    const ref = reference(input);
    const receipt = await port.readReceipt({
      domain: "logical",
      key: ownerCompletionKey(ownerId, namespace, ref.executionId),
    }, callOptions);
    if (!receipt) return undefined;
    if (receipt.kind !== "execution.complete") return refuse();
    return terminal(receipt.result, ref);
  };
  return {
    async claim(assignment, callOptions) {
      const { assignmentId, sessionId } = assignment;
      if (
        ![assignmentId, sessionId].every((value) =>
          typeof value === "string" && value.trim()
        )
      ) throw new TypeError("Assignment routing coordinates must be nonempty.");
      const key = ownerClaimKey(ownerId, assignmentId, sessionId);
      if (assignmentKey !== undefined && assignmentKey !== key) return refuse();
      assignmentKey = key;
      const prior = await port.readReceipt(
        { domain: "incarnation", key },
        callOptions,
      );
      if (prior) {
        if (prior.kind !== "execution.claim") return refuse();
        const ref = reference(prior.result);
        if (!await readCompletion(ref, callOptions)) return refuse();
        return { status: "duplicate", result: ref };
      }
      if (attemptedClaim) return refuse();
      attemptedClaim = true;
      const outcome = await port.execute({
        kind: "execution.claim",
        domain: "incarnation",
        key,
        intent: { assignmentId, sessionId },
      }, callOptions);
      const ref = reference(outcome.result);
      if (outcome.status === "committed") claimed = ref;
      return { status: outcome.status, result: { ...ref } };
    },
    async project(input, callOptions) {
      return await port.project(
        "execution.input",
        reference(input),
        callOptions,
      ) as RegisteredExecutionProjection;
    },
    async complete(input, completion, callOptions) {
      const ref = reference(input);
      requireClaim(ref);
      const outcome = await port.complete({
        kind: "execution.complete",
        domain: "logical",
        key: ownerCompletionKey(ownerId, namespace, ref.executionId),
        intent: { namespace, executionId: ref.executionId, completion },
      }, callOptions);
      return { status: outcome.status, result: terminal(outcome.result, ref) };
    },
    readCompletion,
    execute: (command, callOptions) => port.execute(command, callOptions),
  };
}
