import { createCollectionKernel } from "../collections/kernel.ts";
import type { CollectionDefinition } from "../collections/definition.ts";
import type {
  CollectionMutationIdentity,
  CollectionWriteOptions,
} from "../collections/types.ts";
import {
  createEventCoordinator,
  type EventPublisher,
} from "../events/coordinator.ts";
import { createEventStore } from "../events/store.ts";
import type { SqlSession } from "../events/session.ts";
import { deriveWorkflowId } from "../events/index.ts";
import type { DeliveryExecutor } from "../execution/types.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import { assertJsonValue } from "../json.ts";
import type { OperationCatalog } from "../streams/catalog.ts";
import type { OwnerCommandContext, OwnerCommandHandler } from "./boundary.ts";

export type OwnerCollectionOperation = Readonly<{
  collection: string;
  operation: "create" | "update" | "delete" | "command";
  input: Readonly<Record<string, unknown>>;
  command?: string;
}>;

/** Internal data-only transaction, shared by embedded and connected owner calls. */
export type OwnerCollectionIntent = Readonly<{
  operations: readonly OwnerCollectionOperation[];
}>;

export type OwnerCollectionScope = Readonly<{
  namespace: string;
  identity?: Omit<CollectionMutationIdentity, "deduplicationId">;
  /** Current policy constraints supplied by the owner, never by the caller. */
  conditions?: Readonly<Record<string, CollectionWriteOptions["condition"]>>;
}>;

/**
 * A bounded first handler for registered JSON Collections. Host authorization
 * runs before this handler and receipt lookup, under the same locking fence.
 * It must bind each logical key to a stable host invocation and namespace,
 * including duplicates; scope() alone cannot authorize a replay. This does not expose
 * SQL, schema selection, grants or executable transaction callbacks on the wire.
 */
export function createOwnerCollectionCommand(
  options: Readonly<{
    session: SqlSession;
    schema: string;
    registry: PluginRegistry;
    collections: Readonly<Record<string, CollectionDefinition>>;
    executor: DeliveryExecutor;
    /** Private owner composition: operation admission/indexing shares the same
     * transaction as Collection events, including detached Processor scopes. */
    catalog?: OperationCatalog;
    scope(
      context: OwnerCommandContext,
      intent: OwnerCollectionIntent,
    ): OwnerCollectionScope | Promise<OwnerCollectionScope>;
    publish?: EventPublisher;
    maxOperations?: number;
  }>,
): OwnerCommandHandler {
  if (options.catalog && options.catalog.databaseSchema !== options.schema) {
    throw new TypeError("Collection catalog schema does not match.");
  }
  const limit = options.maxOperations ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError("maxOperations must be positive.");
  }
  return async (value, context) => {
    assertJsonValue(value, { maxDepth: 64, maxNodes: 100_000 });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new TypeError("Collection intent must be an object.");
    }
    const data = value as Record<string, unknown>;
    if (
      Object.keys(data).some((key) => key !== "operations") ||
      !Array.isArray(data.operations) || data.operations.length > limit
    ) {
      throw new TypeError(
        "Collection intent requires bounded operations only.",
      );
    }
    const intent = data as unknown as OwnerCollectionIntent;
    for (const operation of intent.operations) {
      if (
        !operation || typeof operation !== "object" ||
        Object.keys(operation).some((key) =>
          !["collection", "operation", "input", "command"].includes(key)
        ) || !operation.input || typeof operation.input !== "object" ||
        Array.isArray(operation.input)
      ) {
        throw new TypeError("Invalid Collection operation.");
      }
      const definition =
        Object.hasOwn(options.collections, operation.collection)
          ? options.collections[operation.collection]
          : undefined;
      if (!definition) throw new TypeError("Unknown registered Collection.");
      if (definition.content?.fields.length) {
        throw new TypeError(
          "Owner content operations require the content-command integration.",
        );
      }
      if (
        !["create", "update", "delete", "command"].includes(operation.operation)
      ) throw new TypeError("Unsupported owner Collection operation.");
      if (
        operation.operation === "command" &&
        (typeof operation.command !== "string" ||
          !Object.hasOwn(definition.commands ?? {}, operation.command))
      ) throw new TypeError("Unknown registered Collection command.");
      if (
        operation.operation !== "command" && operation.command !== undefined
      ) throw new TypeError("Unexpected command name.");
    }
    const scope = await options.scope(context, intent);
    if (typeof scope.namespace !== "string" || !scope.namespace.trim()) {
      throw new TypeError("Owner scope requires a namespace.");
    }
    const store = createEventStore({
      session: options.session,
      schema: options.schema,
      ownerCommit: context.ownerCommit,
      ...(options.catalog
        ? {
          lockSettlementScope: options.catalog.lockScope,
          admitOperationEventSql: options.catalog.admitEventSql,
          indexOperationEvent: options.catalog.indexEvent,
          indexOperationEventSql: options.catalog.indexEventSql,
        }
        : {}),
    });
    const coordinator = createEventCoordinator({
      store,
      registry: options.registry,
      executor: options.executor,
      publish: options.publish,
      scheduleOnly: true,
    });
    const kernel = createCollectionKernel({
      session: options.session,
      eventStore: store,
      coordinator,
      now: () => new Date(context.commandTime),
      commitContext: {
        transaction: context.tx,
        pending: [],
        afterCommit: context.afterCommit,
      },
    });
    for (const definition of Object.values(options.collections)) {
      kernel.bind(definition);
    }
    const key = await deriveWorkflowId(
      "owner-command",
      JSON.stringify([
        context.ownerCommit.ownerId,
        context.command.domain,
        context.command.key,
      ]),
    );
    const result = await kernel.transaction({
      operationKey: key,
      namespace: scope.namespace,
      identity: { ...scope.identity, deduplicationId: key },
      async execute({ collections }) {
        const ids: string[] = [];
        for (const operation of intent.operations) {
          const definition = options.collections[operation.collection];
          const collection = collections[definition.name];
          const writeOptions = {
            condition: scope.conditions?.[operation.collection],
          };
          let ref;
          switch (operation.operation) {
            case "create":
              ref = await collection.create(operation.input, writeOptions);
              break;
            case "update":
              ref = await collection.update(
                operation.input as { id: string },
                writeOptions,
              );
              break;
            case "delete":
              ref = await collection.delete(
                operation.input as { id: string },
                writeOptions,
              );
              break;
            case "command":
              ref = await collection.commands[operation.command!](
                operation.input as { id: string },
                writeOptions,
              );
              break;
          }
          ids.push(ref.id);
        }
        return ids;
      },
    });
    // Receipts contain references only. A later authorized read decides what
    // fields, content and protected values a recipient is allowed to receive.
    return {
      recordIds: result.value,
      eventIds: result.writes.flatMap((write) =>
        "event" in write && write.event ? [write.event.id] : []
      ),
    };
  };
}
