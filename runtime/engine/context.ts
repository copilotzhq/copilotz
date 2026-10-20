import { createOwnerContentStreamRuntime } from "../streams/stream.ts";
import { bindProcessorCollectionInvocation } from "../authorization/invocation.ts";
import {
  snapshotControl,
  withSnapshotControl,
} from "../collections/snapshot-control.ts";
import type { CollectionDefinition } from "../collections/index.ts";
import {
  createContentStreamRuntime,
  type StreamOutput,
  type StreamTerminalStatus,
} from "../streams/index.ts";
import { createStreamOutputDescriptor } from "../streams/index.ts";
import { operationStreamBodyId } from "../streams/index.ts";
import {
  type ActionTransactionContext,
  type ActionTransactionOptions,
  createActionCallers,
} from "../actions/index.ts";
import { createActionInvocationContext } from "../actions/execution-context.ts";
import type { ProcessorContext } from "../plugins/index.ts";
import type {
  CreateProcessorContextOptions,
  EngineContextSeed,
} from "./types.ts";
import { withProtectedEventResolver } from "../actions/protected-context.ts";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function lazyBodyFollower(
  open: () => Promise<ReadableStream<Uint8Array>>,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let opening: Promise<ReadableStreamDefaultReader<Uint8Array>> | undefined;
  const getReader = () =>
    opening ??= open().then((body) => {
      reader = body.getReader();
      return reader;
    });
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await getReader().then((active) => active.read());
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel(reason) {
      const active = reader ?? await opening?.catch(() => undefined);
      await active?.cancel(reason).catch(() => undefined);
    },
  });
}

function capabilitySourceMetadata(
  base: EngineContextSeed,
): Record<string, unknown> {
  if (!base.source) return {};
  if (base.source.kind === "delivery") {
    return {
      sourceDeliveryId: base.source.id,
      ...(base.source.consumerId
        ? { sourceConsumerId: base.source.consumerId }
        : {}),
    };
  }
  if (base.source.kind === "stream") {
    return { sourceStreamId: base.source.id };
  }
  return { sourceLiveDispatchId: base.source.id };
}

/** Constructs the complete runtime-neutral context for one Processor run. */
export function createProcessorContext(
  options: CreateProcessorContextOptions,
): ProcessorContext {
  const namespace = requiredText(options.base.event.namespace, "Namespace");
  const databaseSchema = requiredText(
    options.base.databaseSchema,
    "Database schema",
  );
  const mutation = (operationKey: string) =>
    options.base.createMutationIdentity(
      requiredText(operationKey, "Mutation operation key"),
    );
  const catalogedStreams = new Map<string, string>();
  const bodyIdFor = (streamId: string) =>
    operationStreamBodyId({
      namespace,
      streamId,
      bodyPrefix: options.streamBodyPrefix,
    });
  const membership = (bodyId: string) => {
    const streamId = catalogedStreams.get(bodyId);
    return streamId && settlementScopeId
      ? { namespace, operationId: settlementScopeId, streamId }
      : undefined;
  };
  const settlementScopeId = options.base.settlementScopeId;
  const localStreams = new Map<
    string,
    Readonly<{ settle(status: StreamTerminalStatus): void }>
  >();

  const streams = createOwnerContentStreamRuntime({
    namespace,
    store: options.streamBodyStore,
    catalog: {
      ...options.assets.catalog,
      checkpoint(content) {
        const stream = membership(content.bodyId);
        return stream
          ? options.operationCatalog.acceptStreamCheckpoint({
            ...stream,
            content,
          })
          : options.assets.catalog.checkpoint(content);
      },
      sealIntent(content) {
        const stream = membership(content.bodyId);
        return stream
          ? options.operationCatalog.acceptStreamSealIntent({
            ...stream,
            content,
          })
          : options.assets.catalog.sealIntent(content);
      },
      sealAccepted(content) {
        const stream = membership(content.bodyId);
        return stream
          ? options.operationCatalog.acceptStreamSeal({ ...stream, content })
          : options.assets.catalog.sealAccepted(content);
      },
      recordFailure(content) {
        const stream = membership(content.bodyId);
        return stream
          ? options.operationCatalog.acceptStreamFailure({ ...stream, content })
          : options.assets.catalog.recordFailure(content);
      },
    },
    producerId: settlementScopeId,
    storeForCopy: options.assets.storeForCopy,
    bodyPrefix: options.streamBodyPrefix,
    incarnationId: options.base.executionIncarnationId,
    signal: options.base.signal,
    async onOpen(output, publication) {
      const semanticStreamId = output.semanticId;
      const descriptor = createStreamOutputDescriptor(output, {
        namespace,
        causationId: options.base.event.durable
          ? options.base.event.id
          : options.base.event.causationId,
        correlationId: output.correlationId ?? options.base.event.correlationId,
        metadata: {
          ...capabilitySourceMetadata(options.base),
          ...(options.base.actionScopeId
            ? { sourceActionScopeId: options.base.actionScopeId }
            : {}),
          contentStream: true,
          contentStreamSemanticId: semanticStreamId,
          ...(output.incarnationId
            ? { contentStreamIncarnationId: output.incarnationId }
            : {}),
        },
      });
      const operation = settlementScopeId
        ? await options.operationCatalog.get(namespace, settlementScopeId)
        : null;
      if (!operation || !settlementScopeId) {
        if (!options.publishLocalStream) {
          throw new Error(
            "Unscoped content streams require a local output authority.",
          );
        }
        let resolveTerminal!: (status: StreamTerminalStatus) => void;
        let terminalSettled = false;
        const terminal = new Promise<StreamTerminalStatus>((resolve) => {
          resolveTerminal = (status) => {
            if (terminalSettled) return;
            terminalSettled = true;
            resolve(status);
          };
        });
        const outputWithAuthority: StreamOutput = {
          ...descriptor,
          payload: lazyBodyFollower(async () => {
            const follower = await streams.follow({ id: output.id });
            return follower.body;
          }),
          terminal,
        } as const;
        localStreams.set(
          output.id,
          {
            settle: resolveTerminal,
          } as const,
        );
        publication.established();
        await options.publishLocalStream(outputWithAuthority);
        return;
      }
      const replayIdentity = await options.operationCatalog.openStream({
        namespace,
        operationId: settlementScopeId,
        semanticStreamId,
        bodyId: bodyIdFor(output.id),
        descriptor,
        ...(options.base.source?.kind === "delivery" &&
            options.base.executionIncarnationId
          ? {
            deliveryLease: {
              deliveryId: options.base.source.id,
              owner: options.base.executionIncarnationId,
            },
          }
          : {}),
      });
      if (!replayIdentity) {
        throw new Error(
          `Operation stream '${output.id}' cannot open after its operation settled.`,
        );
      }
      catalogedStreams.set(bodyIdFor(output.id), output.id);
      // The catalog is itself a durable reconnect publication boundary.
      publication.established();
      await options.publishOutput?.(
        {
          ...descriptor,
          ...(replayIdentity ?? {}),
        } as const,
      );
      publication.established();
    },
    onSeal(stream, body) {
      const local = localStreams.get(stream.id);
      if (local) {
        local.settle(
          {
            outcome: "completed",
            availability: "retained",
            offset: body.byteLength,
            terminalAt: (options.now?.() ?? new Date()).toISOString(),
          } as const,
        );
        localStreams.delete(stream.id);
        return;
      }
    },
    onTerminate(stream, body, input) {
      const local = localStreams.get(stream.id);
      if (local) {
        local.settle(
          {
            outcome: input.outcome,
            availability: "retained",
            ...(input.reason ? { reason: input.reason } : {}),
            offset: body.byteLength,
            terminalAt: (options.now?.() ?? new Date()).toISOString(),
          } as const,
        );
        localStreams.delete(stream.id);
        return;
      }
    },
    async onDiscard(stream) {
      localStreams.delete(stream.id);
      if (!settlementScopeId || !catalogedStreams.has(bodyIdFor(stream.id))) {
        return;
      }
      await options.operationCatalog.discardStream({
        namespace,
        operationId: settlementScopeId,
        streamId: stream.id,
      });
      catalogedStreams.delete(bodyIdFor(stream.id));
    },
    async onRetain(stream, input) {
      if (!settlementScopeId || !catalogedStreams.has(bodyIdFor(stream.id))) {
        return;
      }
      await options.operationCatalog.retainStream({
        namespace,
        operationId: settlementScopeId,
        streamId: stream.id,
        ...input,
      });
    },
  }, async (stream, input) => {
    if (!settlementScopeId || !catalogedStreams.has(bodyIdFor(stream.id))) {
      return;
    }
    // Successful seal intent already records the operation projection in its
    // own command. Failure revocation still uses its separate transition.
    if (input.outcome === "completed") return;
    const terminalizing = await options.operationCatalog
      .beginStreamTerminalization({
        namespace,
        operationId: settlementScopeId,
        streamId: stream.id,
        outcome: input.outcome,
        ...(input.reason ? { reason: input.reason } : {}),
      });
    if (!terminalizing) {
      const current = await options.operationCatalog.getStream(
        namespace,
        settlementScopeId,
        stream.id,
      );
      // Cancellation/supersession may win among non-completed outcomes, but
      // a completed seal intent and a failed logical prefix are distinct.
      // Never let a producer cross that cataloged boundary.
      if (
        current?.state === "terminating" &&
        current.outcome !== "completed"
      ) return;
      throw new Error(
        `Operation stream '${stream.id}' could not begin terminalization.`,
      );
    }
  });

  const content: ProcessorContext["content"] = {
    openCapture(input) {
      const identity = mutation(`content.capture:${input.operationKey}`);
      const capture = createContentStreamRuntime({
        namespace,
        store: options.streamBodyStore,
        catalog: options.assets.catalog,
        storeForCopy: options.assets.storeForCopy,
        producerId: settlementScopeId ??
          (options.base.event.durable
            ? options.base.event.id
            : options.base.event.correlationId),
        bodyPrefix: options.streamBodyPrefix,
        incarnationId: options.base.executionIncarnationId,
        signal: options.base.signal,
        onOpen(_opened, publication) {
          publication.established();
        },
      });
      return capture.open({
        ...input,
        id: `capture:${identity.deduplicationId ?? input.operationKey}`,
      });
    },
    capture(input, captureOptions) {
      const identity = mutation(
        `content.capture:${captureOptions.operationKey}`,
      );
      return options.assets.capture({
        namespace,
        content: input,
        operationKey: identity.deduplicationId ?? captureOptions.operationKey,
        producer: settlementScopeId ??
          (options.base.event.durable
            ? options.base.event.id
            : options.base.event.correlationId),
        origin: captureOptions.origin,
      });
    },
    authorize: (ref) =>
      options.resolver.authorize(ref, {
        namespace,
        signal: options.base.signal,
      }),
    prepare(input, prepareOptions) {
      const preparedIdentity = mutation(
        `content.prepare:${prepareOptions.operationKey}`,
      );
      return options.preparer.prepare(input, {
        namespace,
        idempotencyKey: preparedIdentity.deduplicationId,
        origin: prepareOptions.origin,
      });
    },
    materialize(input, materializeOptions = {}) {
      return options.assets.materialize({
        namespace,
        content: input,
        origin: materializeOptions.origin,
      });
    },
    publish(input, publishOptions) {
      const publishIdentity = mutation(
        `content.publish:${publishOptions.operationKey}`,
      );
      return options.assets.publish({
        ...input,
        namespace,
        idempotencyKey: publishIdentity.deduplicationId,
      });
    },
    get: (assetId) => options.assets.get(namespace, assetId),
    getMany: (assetIds) => options.assets.getMany(namespace, assetIds),
    resolve: (ref) => options.resolver.get(ref, { namespace }),
    resolveMany: (refs) => options.resolver.getMany(refs, { namespace }),
    open: (ref) => options.resolver.open(ref, { namespace }),
  } as const;

  const collectionsByName = options.collections.withScope({
    namespace,
    createMutationIdentity: options.base.createMutationIdentity,
  });
  const collections = Object.fromEntries(
    Object.entries(options.registry.collections).map(([alias, definition]) => {
      const collection = collectionsByName[
        (definition as CollectionDefinition).name
      ];
      if (!collection) {
        throw new Error(
          `Collection '${definition.name}' for alias '${alias}' is not bound.`,
        );
      }
      return [alias, collection];
    }),
  );

  const processorOperationKey = requiredText(
    options.base.idempotencyKey,
    "Processor operation key",
  );
  let transactionIndex = 0;

  const transaction = async <T>(
    execute: (context: ActionTransactionContext<typeof collections>) =>
      | T
      | Promise<T>,
    transactionOptions: ActionTransactionOptions = {},
  ): Promise<T> => {
    const transactionOperationKey = transactionOptions.operationKey?.trim() ||
      `${processorOperationKey}:transaction:${++transactionIndex}`;
    const source = options.base.createMutationIdentity(
      transactionOperationKey,
      transactionOptions.identity?.metadata,
    );
    const result = await options.collections.transaction({
      operationKey: transactionOperationKey,
      namespace,
      identity: {
        causationId: transactionOptions.identity?.causationId ??
          source.causationId,
        correlationId: transactionOptions.identity?.correlationId ??
          source.correlationId,
        settlementScopeId: transactionOptions.identity?.settlementScopeId ??
          source.settlementScopeId,
        actionScopeId: transactionOptions.identity?.actionScopeId ??
          source.actionScopeId,
        deliveryLease: source.deliveryLease,
        deduplicationId: transactionOptions.identity?.deduplicationId ??
          source.deduplicationId,
        metadata: {
          ...source.metadata,
          ...transactionOptions.identity?.metadata,
        },
      },
      execute: async (
        { collections: byName, relations, vectors, sessions, flows },
      ) => {
        const transactionCollections = (Object.fromEntries(
          Object.entries(options.registry.collections).map(
            ([alias, definition]) => {
              const collection = byName[definition.name];
              if (!collection) {
                throw new Error(
                  `Collection '${definition.name}' for alias '${alias}' is not bound.`,
                );
              }
              return [alias, collection];
            },
          ),
        )) as ActionTransactionContext<typeof collections>["collections"];
        return await execute(
          {
            collections: transactionCollections,
            relations,
            vectors,
            sessions,
            flows,
          } as const,
        );
      },
    });
    return result.value;
  };

  const readSnapshot: ProcessorContext["readSnapshot"] = async (execute) => {
    return await options.collections.readSnapshot(
      { namespace },
      async (snapshotScope) => {
        const { collections: byName } = snapshotScope;
        const snapshotCollections = Object.fromEntries(
          Object.entries(options.registry.collections).map(
            ([alias, definition]) => {
              const collection = byName[definition.name];
              if (!collection) {
                throw new Error(
                  `Collection '${definition.name}' for alias '${alias}' is not bound.`,
                );
              }
              return [alias, collection];
            },
          ),
        );
        return await execute(
          withSnapshotControl(
            { collections: snapshotCollections } as const,
            snapshotControl(snapshotScope),
          ),
        );
      },
    );
  };

  const contextIdentity = {
    ...(options.base.event.durable
      ? { causationId: options.base.event.id }
      : options.base.event.causationId
      ? { causationId: options.base.event.causationId }
      : {}),
    correlationId: options.base.event.correlationId,
    actionScopeId: options.base.actionScopeId,
    deduplicationId: processorOperationKey,
    ...(options.base.settlementScopeId
      ? { settlementScopeId: options.base.settlementScopeId }
      : {}),
  } as const;
  let rootActionIndex = 0;
  const actions = createActionCallers(options.registry.actions, {
    actionLifecycle: options.actionLifecycle,
    authorize: options.authorizeAction,
    prepareInput: options.prepareActionInput,
    refuseAuthorization: options.refuseActionAuthorization,
    createEffectClient: options.createEffectClient,
    resumption: options.actionResumption,
    content: {
      ...content,
      // This runtime-owned key is content-addressed, not Processor-run-addressed.
      publish: (input, publishOptions) =>
        options.assets.publish({
          ...input,
          namespace,
          idempotencyKey: publishOptions.operationKey,
        }),
    },
    signal: options.base.signal,
    invocationScope: processorOperationKey,
    // Named calls replay by logical key even when a retry skips earlier work.
    // Only unnamed calls use the invocation ordinal. The invoker appends the
    // normalized explicit key to this stable prefix.
    createInvocationKey: (actionId, operationKey) =>
      operationKey
        ? `${encodeURIComponent(processorOperationKey)}:action:named:${
          encodeURIComponent(actionId)
        }`
        : `${processorOperationKey}:action:${++rootActionIndex}:${actionId}`,
    identity: contextIdentity,
    createContext({ frame, actions: nestedActions, progress }) {
      return createActionInvocationContext({
        host: context,
        frame,
        actions: nestedActions,
        progress,
      });
    },
  });

  const contextValue = withProtectedEventResolver({
    namespace,
    databaseSchema,
    operationKey: processorOperationKey,
    operations: options.operations,
    identity: contextIdentity,
    resources: options.registry.resources,
    adapters: options.registry.adapters,
    actions,
    content,
    streams,
    collections,
    vectors: options.collections.vectors(namespace),
    signal: options.base.signal,
    now: options.now ?? (() => new Date()),
    transaction,
    readSnapshot,
  }, options.protectedEventResolver);
  const context: ProcessorContext = options.collectionInvocation
    ? bindProcessorCollectionInvocation(
      contextValue,
      options.collectionInvocation.owner,
      options.collectionInvocation.invocation,
    )
    : contextValue;
  return context;
}
