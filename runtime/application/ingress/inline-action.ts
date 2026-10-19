import { awaitEventPublication } from "../../events/coordinator.ts";
/** The normal Action lifecycle can begin in its local ingress admission command. */
import { createSchemaCommandRunner } from "../../engine/commands.ts";
import { createActionLifecycleAppender } from "../../actions/persistence.ts";
import { createActionLifecycleEmitter } from "../../actions/lifecycle.ts";
import type {
  CoordinatedMutationResult,
  DurableEventDraft,
  EventCoordinator,
  EventStore,
  SqlExecutor,
} from "../../events/index.ts";
import type { PluginRegistry } from "../../plugins/index.ts";
import type { ProtectedValueRuntime } from "../../actions/protected-value.ts";
import {
  parseServerActionRequest,
  serverActionInvocationMetadata,
  serverActionRunId,
} from "./contracts.ts";

export async function admitInlineAction(
  runtime: {
    store: EventStore;
    coordinator: EventCoordinator;
    registry: PluginRegistry;
    protectedValues?: ProtectedValueRuntime;
    protectedActions?: Readonly<Record<string, unknown>>;
  },
  draft: DurableEventDraft,
  admit: (transaction: SqlExecutor) => Promise<CoordinatedMutationResult<void>>,
) {
  const request = parseServerActionRequest(draft.payload);
  const action = runtime.registry.actions[request.actionAlias];
  const admitted = await createSchemaCommandRunner(
    runtime.store.session,
    runtime.store.databaseSchema,
  )(
    "ingress.action",
    { requestId: request.requestId },
    async (_input, command) => {
      const admitted = await admit(command.transaction);
      const delivery = admitted.deliveries.find((delivery) =>
        delivery.consumerId === "processor:copilotz.server.action-request"
      );
      if (
        !admitted.deduplicated && delivery?.status === "leased" &&
        !action.content && !runtime.protectedActions?.[action.id]
      ) {
        const runId = serverActionRunId(
          delivery.id,
          action.id,
          request.requestId,
        );
        const lifecycle = createActionLifecycleEmitter({
          namespace: draft.namespace,
          metadata: {
            sourceEventId: admitted.event.id,
            sourceDeliveryId: delivery.id,
            sourceConsumerId: delivery.consumerId,
          },
          append: createActionLifecycleAppender({
            store: runtime.store,
            coordinator: runtime.coordinator,
            actions: runtime.registry.actions,
            protectedValues: runtime.protectedValues,
            writer: {
              kind: "delivery",
              deliveryId: delivery.id,
              leaseOwner: delivery.leaseOwner!,
            },
            transaction: command.transaction,
          }),
        });
        await lifecycle.emit({
          actionId: action.id,
          actionRunId: runId,
          input: request.input,
          metadata: serverActionInvocationMetadata(request),
          status: "invoked",
          effectProtocol: 1,
          deduplicationId: `${runId}:action:invoked`,
          causationId: admitted.event.id,
          correlationId: admitted.event.correlationId,
          settlementScopeId: admitted.settlementScopeId,
        });
      }
      return admitted;
    },
  );
  return { ...admitted, dispatch: await awaitEventPublication(admitted) };
}
