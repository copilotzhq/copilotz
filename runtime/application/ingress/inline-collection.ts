import { withOwnerCollectionInvocation } from "../../authorization/invocation.ts";
import { resolveProtectedActionSource } from "../../actions/protected-action-source.ts";
/** Inline completion of the same protected admission used by durable ingress. */
import {
  type CommandJson,
  createSchemaCommandRunner,
} from "../../engine/commands.ts";
import type {
  CoordinatedMutationResult,
  DurableEventDraft,
  EventStore,
  SqlExecutor,
} from "../../events/index.ts";
import type { CollectionRuntime } from "../../collections/index.ts";
import type { OperationCatalog } from "../../streams/catalog.ts";
import type { PluginRegistry } from "../../plugins/index.ts";
import {
  parseServerCollectionMutationRequest,
  SERVER_COLLECTION_MUTATION_METADATA_SCHEMA,
} from "./contracts.ts";

export type InlineCollectionCompletion = {
  value?: unknown;
  deferred?: boolean;
};

export async function completeHostCollection(
  runtime: {
    store: EventStore;
    owner: import("../../engine/commands.ts").DatabaseOwner;
    collections: CollectionRuntime;
    catalog: OperationCatalog;
    registry: PluginRegistry;
    signal: AbortSignal;
    protectedValues?:
      import("../../actions/protected-value.ts").ProtectedValueRuntime;
  },
  draft: DurableEventDraft,
  body: unknown,
  completion: InlineCollectionCompletion,
  admit: (transaction: SqlExecutor) => Promise<CoordinatedMutationResult<void>>,
): Promise<CoordinatedMutationResult<void>> {
  const request = parseServerCollectionMutationRequest(draft.payload);
  const definition = runtime.registry.collections[request.collectionAlias];
  if (!definition) {
    throw new TypeError(`Unknown collection '${request.collectionAlias}'.`);
  }
  const run = createSchemaCommandRunner(
    runtime.store.session,
    runtime.store.databaseSchema,
    () => Promise.resolve(runtime.owner),
  );
  const binding = {
    principal: `host:${draft.namespace}`,
    signal: runtime.signal,
    receipt: {
      identity: {
        domain: "logical" as const,
        key: `host-collection:${draft.namespace}:${draft.deduplicationId}`,
      },
      intent: JSON.parse(
        JSON.stringify({ ...draft, payload: body }),
      ) as CommandJson,
    },
  };
  const result = await run(
    "ingress.collection",
    { draft, request },
    async (_input, command) => {
      const admitted = await admit(command.transaction);
      if (
        admitted.deduplicated &&
        admitted.deliveries.some((delivery) =>
          delivery.consumerId ===
            "processor:copilotz.server.collection-mutation-request"
        )
      ) {
        // A receipt from the former durable host path owns its original
        // mutation identity. Never replay it under a new inline identity.
        return JSON.parse(
          JSON.stringify({
            event: admitted.event,
            deliveries: admitted.deliveries,
            settlementScopeId: admitted.settlementScopeId,
            deferred: true,
          }),
        );
      }
      const mutation = await withOwnerCollectionInvocation({
        logicalRunId: admitted.event.id,
        scope: {
          databaseSchema: runtime.store.databaseSchema,
          namespace: draft.namespace,
        },
        signal: command.signal,
        invocation: {
          kind: "processor",
          id: "copilotz.server.collection-mutation-request",
          runId: admitted.event.id,
        },
        check: () => command.signal.throwIfAborted(),
        resolveSource: (transaction) =>
          resolveProtectedActionSource({
            transaction,
            databaseSchema: runtime.store.databaseSchema,
            namespace: draft.namespace,
            source: {
              eventId: admitted.event.id,
              operationId: admitted.settlementScopeId,
            },
            protectedValues: runtime.protectedValues,
          }),
      }, () =>
        runtime.collections.transaction({
          namespace: draft.namespace,
          operationKey: `server:${request.requestId}:mutation`,
          identity: {
            causationId: admitted.event.id,
            correlationId: admitted.event.correlationId,
            settlementScopeId: admitted.settlementScopeId,
            deduplicationId: `host-collection:${admitted.event.id}`,
          },
          execute: async ({ collections }) => {
            const collection = collections[definition.name];
            const options = {
              metadata: {
                copilotzServer: {
                  schema: SERVER_COLLECTION_MUTATION_METADATA_SCHEMA,
                  requestId: request.requestId,
                  collectionAlias: request.collectionAlias,
                  operation: request.operation,
                  ...(request.command ? { command: request.command } : {}),
                },
              },
              ...(request.condition ? { condition: request.condition } : {}),
            };
            const input = request.input as Record<string, unknown>;
            if (request.operation === "create") {
              return await collection.create(input, options);
            }
            if (request.operation === "update") {
              return await collection.update(
                { id: request.id!, ...input },
                options,
              );
            }
            if (request.operation === "delete") {
              return await collection.delete({ id: request.id! }, options);
            }
            return await collection.commands[request.command!]({
              ...input,
              id: request.id!,
            }, options);
          },
        }, command));
      // This admission has no executing caller or output drain. Downstream
      // deliveries keep it open; their ordinary settlement completes it later.
      await runtime.catalog.reconcile({
        namespace: draft.namespace,
        operationId: admitted.settlementScopeId,
      }, command.transaction);
      const value = request.operation === "delete"
        ? { id: request.id, deleted: true }
        : mutation.writes[0]?.record;
      return JSON.parse(
        JSON.stringify({
          event: admitted.event,
          deliveries: admitted.deliveries,
          settlementScopeId: admitted.settlementScopeId,
          value,
        }),
      );
    },
    binding,
  ).catch(async (error) => {
    if (error?.code !== "collection_validation_failed") throw error;
    // The failed command rolled back all effects. Record the accepted refusal
    // under the same receipt key; a concurrent successful replay wins normally.
    return await run(
      "ingress.collection",
      { draft, request },
      async (_input, command) => {
        const admitted = await admit(command.transaction);
        await runtime.catalog.reconcile(
          {
            namespace: draft.namespace,
            operationId: admitted.settlementScopeId,
          },
          command.transaction,
          "failed",
        );
        return JSON.parse(
          JSON.stringify({
            event: admitted.event,
            deliveries: admitted.deliveries,
            settlementScopeId: admitted.settlementScopeId,
            error: {
              name: error.name,
              message: error.message,
              code: error.code,
            },
          }),
        );
      },
      binding,
    );
  });
  if (result.error) {
    throw Object.assign(new TypeError(result.error.message), result.error);
  }

  completion.value = result.value;
  completion.deferred = result.deferred === true;
  return {
    ...result,
    value: undefined,
    deduplicated: false,
    dispatch: { handles: [], failures: [] },
  };
}
