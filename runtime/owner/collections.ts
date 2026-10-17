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
import {
  assertOwnerAttemptCaller,
  type OwnerAttemptAuthority,
  ownerAttemptToken,
  ownerEventCommitForAttempt,
} from "./attempt-authority.ts";

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
  /** Already authorized private attempt, never part of Collection intent. */
  attempt?: OwnerAttemptAuthority;
}>;

function snapshot<T>(value: T): T {
  assertJsonValue(value, {
    omitUndefinedProperties: true,
    maxDepth: 64,
    maxNodes: 100_000,
  });
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > 1024 * 1024) {
    throw new TypeError("Owner Collection scope exceeds its byte limit.");
  }
  // Keep own-field presence, including undefined forbidden coordinates. The
  // ordinary optional-field encoder must not launder mixed attempt authority.
  return structuredClone(value);
}
function refuseAttempt(): never {
  throw Object.assign(
    new Error("Collection attempt authority does not match."),
    {
      name: "ActionOwnershipLost",
      code: "ActionOwnershipLost",
    },
  );
}

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
  const { schema, registry, scope: resolveScope, publish } = options;
  const sourceSession = options.session;
  const session: SqlSession = {
    query: sourceSession.query.bind(sourceSession),
    transaction: sourceSession.transaction.bind(sourceSession),
    ...(sourceSession.readSnapshot
      ? { readSnapshot: sourceSession.readSnapshot.bind(sourceSession) }
      : {}),
    ...(sourceSession.listen
      ? { listen: sourceSession.listen.bind(sourceSession) }
      : {}),
  };
  const collections = { ...options.collections };
  const sourceExecutor = options.executor;
  const executor: DeliveryExecutor = {
    ...sourceExecutor,
    scheduleDelivery: sourceExecutor.scheduleDelivery.bind(sourceExecutor),
    dispatchDelivery: sourceExecutor.dispatchDelivery.bind(sourceExecutor),
    dispatchRecoverable: sourceExecutor.dispatchRecoverable.bind(
      sourceExecutor,
    ),
  };
  const sourceCatalog = options.catalog;
  if (sourceCatalog && sourceCatalog.databaseSchema !== schema) {
    throw new TypeError("Collection catalog schema does not match.");
  }
  const catalog = sourceCatalog && {
    lockSettlementScope: sourceCatalog.lockScope.bind(sourceCatalog),
    admitOperationEventSql: sourceCatalog.admitEventSql.bind(sourceCatalog),
    indexOperationEvent: sourceCatalog.indexEvent.bind(sourceCatalog),
    indexOperationEventSql: sourceCatalog.indexEventSql.bind(sourceCatalog),
  };
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
      const definition = Object.hasOwn(collections, operation.collection)
        ? collections[operation.collection]
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
    // The policy gets its own ordinary-data copies; it cannot rewrite the
    // command/caller or scope after returning through a retained reference.
    const caller = snapshot(context.caller);
    const command = { ...context.command };
    const commandTime = context.commandTime;
    const tx = context.tx;
    const afterCommit = context.afterCommit;
    const ownerCommit = { ...context.ownerCommit };
    const currentContext = {
      ...context,
      caller,
      command,
      commandTime,
      tx,
      afterCommit,
      ownerCommit,
    };
    const resolvedScope = resolveScope({
      ...currentContext,
      caller: snapshot(caller),
      command: { ...command },
      ownerCommit: { ...ownerCommit },
    }, snapshot(intent));
    // A synchronous scope is detached synchronously too: a callback's queued
    // microtask must not rewrite its result before the first kernel await.
    const scope = snapshot(
      resolvedScope instanceof Promise ? await resolvedScope : resolvedScope,
    );
    if (
      !scope || typeof scope !== "object" || Array.isArray(scope) ||
      Object.keys(scope).some((key) =>
        !["namespace", "identity", "conditions", "attempt"].includes(key)
      )
    ) throw new TypeError("Invalid owner Collection scope.");
    if (typeof scope.namespace !== "string" || !scope.namespace.trim()) {
      throw new TypeError("Owner scope requires a namespace.");
    }
    const attempt = scope.attempt;
    if (
      caller.principal.kind === "owner-local" &&
      attempt?.placement !== "owner-local"
    ) {
      refuseAttempt();
    }
    if (attempt !== undefined) {
      assertOwnerAttemptCaller(caller, attempt, ownerCommit.ownerId);
      if (attempt.placement === "owner-local") {
        const lease = scope.identity?.deliveryLease;
        if (
          scope.namespace !== attempt.namespace || !lease ||
          Object.keys(lease).length !== 2 ||
          !Object.hasOwn(lease, "deliveryId") ||
          !Object.hasOwn(lease, "owner") ||
          lease.deliveryId !== attempt.deliveryId ||
          lease.owner !== ownerAttemptToken(attempt)
        ) refuseAttempt();
      }
    }
    const store = createEventStore({
      session,
      schema,
      ownerCommit: attempt
        ? ownerEventCommitForAttempt(currentContext, attempt)
        : ownerCommit,
      ...catalog,
    });
    const coordinator = createEventCoordinator({
      store,
      registry,
      executor,
      publish,
      scheduleOnly: true,
    });
    const kernel = createCollectionKernel({
      session,
      eventStore: store,
      coordinator,
      now: () => new Date(commandTime),
      commitContext: {
        transaction: tx,
        pending: [],
        afterCommit,
      },
    });
    for (const definition of Object.values(collections)) {
      kernel.bind(definition);
    }
    const key = await deriveWorkflowId(
      "owner-command",
      JSON.stringify([
        ownerCommit.ownerId,
        command.domain,
        command.key,
      ]),
    );
    const result = await kernel.transaction({
      operationKey: key,
      namespace: scope.namespace,
      identity: { ...scope.identity, deduplicationId: key },
      async execute({ collections: boundCollections }) {
        const ids: string[] = [];
        for (const operation of intent.operations) {
          const definition = collections[operation.collection];
          const collection = boundCollections[definition.name];
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
