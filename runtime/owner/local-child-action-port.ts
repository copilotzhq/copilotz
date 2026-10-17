/** One local attempt's ordinary child calls. The shared waiter may finish on
 * cancellation before a raw call does; the local tracker still owns that call. */
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createOwnerChildActionPort,
  OWNER_CHILD_ACTION_ADMISSION,
  OWNER_CHILD_ACTION_RESULT,
} from "../execution/child-action-port.ts";
import type { RegisteredInvocationCalls } from "../execution/registered-invocation.ts";
import type { OwnerCaller, OwnerCommandBoundary } from "./boundary.ts";
import {
  type OwnerLocalAssignmentBinding,
  parseOwnerPlacementBinding,
} from "./placement-binding.ts";
import { assertOwnerAttemptCaller } from "./attempt-authority.ts";
import type { createLocalPortCalls } from "./local-port-calls.ts";

export type LocalChildActionOptions = Readonly<{
  registry: Pick<PluginRegistry, "actions">;
  maxWaitMs?: number;
}>;

export function createLocalChildActionCall(
  options: Readonly<{
    children: LocalChildActionOptions;
    reference: OwnerLocalAssignmentBinding;
    caller: OwnerCaller;
    boundary: Pick<OwnerCommandBoundary, "executeInput" | "project">;
    calls: Pick<ReturnType<typeof createLocalPortCalls>, "run">;
    invocation(): void;
    maxPendingCalls: number;
  }>,
): NonNullable<RegisteredInvocationCalls["invokeAction"]> {
  const reference = parseOwnerPlacementBinding(options.reference);
  if (reference.placement !== "owner-local") {
    throw new TypeError("Local child calls require a local binding.");
  }
  const caller = structuredClone(options.caller);
  assertOwnerAttemptCaller(caller, reference, reference.ownerId);
  const executeInput = options.boundary.executeInput.bind(options.boundary);
  const project = options.boundary.project.bind(options.boundary);
  const { invocation, calls } = options;
  const child = createOwnerChildActionPort({
    ownerId: reference.ownerId,
    namespace: reference.namespace,
    parentOperationKey: reference.kind === "action"
      ? reference.actionRunId
      : `delivery:${reference.deliveryId}`,
    registry: options.children.registry,
    maxWaitMs: options.children.maxWaitMs,
    maxPendingCalls: options.maxPendingCalls,
    port: {
      async executeInput(command, callOptions) {
        invocation();
        if (command.kind !== OWNER_CHILD_ACTION_ADMISSION) {
          throw new TypeError("Unsupported local child admission.");
        }
        const result = await calls.run(
          (execution) =>
            executeInput(structuredClone(caller), command, execution),
          callOptions,
        );
        invocation();
        return result;
      },
      async project(kind, input, callOptions) {
        invocation();
        if (kind !== OWNER_CHILD_ACTION_RESULT) {
          throw new TypeError("Unsupported local child projection.");
        }
        const result = await calls.run(
          (execution) =>
            project(structuredClone(caller), kind, input, execution),
          callOptions,
        );
        invocation();
        return result;
      },
    },
  });
  return async (request, callOptions) => {
    invocation();
    const result = await child.call(
      {
        placement: "owner-local",
        deliveryId: reference.deliveryId,
        attemptId: reference.attemptId,
      },
      request.actionAlias,
      request.input,
      request.operationKey,
      callOptions,
    );
    invocation();
    return result;
  };
}
