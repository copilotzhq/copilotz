import { awaitEventPublication } from "../../events/coordinator.ts";
/** The normal Action lifecycle can begin in its local ingress admission command. */
import { createSchemaCommandRunner } from "../../engine/commands.ts";
import { createActionLifecycleAppender } from "../../actions/persistence.ts";
import { createActionLifecycleEmitter } from "../../actions/lifecycle.ts";
import { createAuthorizedActions } from "../../actions/authorized-capture.ts";
import { durableActionContentInput } from "../../actions/content.ts";
import type { OperationCatalog } from "../../streams/catalog.ts";
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
    owner: import("../../engine/commands.ts").DatabaseOwner;
    coordinator: EventCoordinator;
    registry: PluginRegistry;
    operationCatalog: OperationCatalog;
    protectedValues?: ProtectedValueRuntime;
    authorization?:
      import("../../authorization/evaluator.ts").OwnerAuthorization;
  },
  draft: DurableEventDraft,
  admit: (transaction: SqlExecutor) => Promise<CoordinatedMutationResult<void>>,
) {
  const request = parseServerActionRequest(draft.payload);
  const action = runtime.registry.actions[request.actionAlias];
  const admitted = await createSchemaCommandRunner(
    runtime.store.session,
    runtime.store.databaseSchema,
    () => Promise.resolve(runtime.owner),
  )(
    "ingress.action",
    { requestId: request.requestId },
    async (_input, command) => {
      const admitted = await admit(command.transaction);
      const delivery = admitted.deliveries.find((delivery) =>
        delivery.consumerId === "processor:copilotz.server.action-request"
      );
      if (
        !admitted.deduplicated && delivery?.status === "leased"
      ) {
        const runId = serverActionRunId(
          delivery.id,
          action.id,
          request.requestId,
        );
        const metadata = {
          sourceEventId: admitted.event.id,
          sourceDeliveryId: delivery.id,
          sourceConsumerId: delivery.consumerId,
        };
        const writer = {
          kind: "delivery" as const,
          deliveryId: delivery.id,
          leaseOwner: delivery.leaseOwner!,
        };
        const input = action.content
          ? durableActionContentInput(request.input, action.content)
          : request.input;
        const prepared = createAuthorizedActions({
          ...runtime,
          collections: runtime.registry.collections,
          actions: runtime.registry.actions,
          namespace: draft.namespace,
          source: {
            eventId: admitted.event.id,
            operationId: admitted.settlementScopeId,
          },
          writer,
          signal: command.signal,
          lifecycleMetadata: metadata,
        }).prepareInput(
          {
            actionId: action.id,
            actionRunId: runId,
            rootKey: delivery.id,
            operationKey: `server:${request.requestId}:invoke`,
            metadata: serverActionInvocationMetadata(request),
            identity: {
              causationId: admitted.event.id,
              correlationId: admitted.event.correlationId,
              settlementScopeId: admitted.settlementScopeId,
            },
            signal: command.signal,
            nextActionIndex: () => 1,
          },
          input,
          command.transaction,
        );
        if (prepared) {
          await prepared;
          return admitted;
        }
        const lifecycle = createActionLifecycleEmitter({
          namespace: draft.namespace,
          metadata,
          append: createActionLifecycleAppender({
            store: runtime.store,
            coordinator: runtime.coordinator,
            actions: runtime.registry.actions,
            protectedValues: runtime.protectedValues,
            writer,
            transaction: command.transaction,
          }),
        });
        await lifecycle.emit({
          actionId: action.id,
          actionRunId: runId,
          input,
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
