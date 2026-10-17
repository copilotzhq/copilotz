/** One local attempt's direct and named child calls. The shared waiter may finish on
 * cancellation before a raw call does; the local tracker still owns that call. */
import type { PluginRegistry } from "../plugins/registry.ts";
import {
  createOwnerChildActionPort,
  OWNER_CHILD_ACTION_ADMISSION,
  OWNER_CHILD_ACTION_RESULT,
} from "../execution/child-action-port.ts";
import { OWNER_CHILD_ACTION_PREPARATION } from "../execution/preparation-call.ts";
import type { RegisteredInvocationCalls } from "../execution/registered-invocation.ts";
import type {
  OwnerCaller,
  OwnerCommandBoundary,
  OwnerCommandExecuteOptions,
  OwnerInputCommand,
} from "./boundary.ts";
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

export function createLocalChildActionCalls(
  options: Readonly<{
    children: LocalChildActionOptions;
    reference: OwnerLocalAssignmentBinding;
    caller: OwnerCaller;
    boundary: Pick<OwnerCommandBoundary, "executeInput" | "project">;
    calls: Pick<ReturnType<typeof createLocalPortCalls>, "run">;
    invocation(): void;
    maxPendingCalls: number;
  }>,
): Required<Pick<RegisteredInvocationCalls, "invokeAction" | "prepareAction">> {
  const reference = parseOwnerPlacementBinding(options.reference);
  if (reference.placement !== "owner-local") {
    throw new TypeError("Local child calls require a local binding.");
  }
  const caller = structuredClone(options.caller);
  assertOwnerAttemptCaller(caller, reference, reference.ownerId);
  const executeInput = options.boundary.executeInput.bind(options.boundary);
  const project = options.boundary.project.bind(options.boundary);
  const { invocation, calls } = options;
  const admission = (kind: string) =>
  async (
    command: OwnerInputCommand,
    callOptions?: OwnerCommandExecuteOptions,
  ) => {
    invocation();
    if (command.kind !== kind) {
      throw new TypeError("Unsupported local child admission.");
    }
    const result = await calls.run(
      (execution) => executeInput(structuredClone(caller), command, execution),
      callOptions,
    );
    invocation();
    return result;
  };
  const selector = {
    placement: "owner-local" as const,
    deliveryId: reference.deliveryId,
    attemptId: reference.attemptId,
  };
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
      executeInput: admission(OWNER_CHILD_ACTION_ADMISSION),
      prepareInput: admission(OWNER_CHILD_ACTION_PREPARATION),
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
  return {
    async invokeAction(request, callOptions) {
      invocation();
      const result = await child.call(
        selector,
        request.actionAlias,
        request.input,
        request.operationKey,
        callOptions,
      );
      invocation();
      return result;
    },
    async prepareAction(request, callOptions) {
      invocation();
      const result = await child.prepare(
        selector,
        request.actionAlias,
        {
          preparation: request.preparation,
          recordId: request.recordId,
          mode: request.mode,
        },
        request.operationKey,
        callOptions,
      );
      invocation();
      return result;
    },
  };
}
