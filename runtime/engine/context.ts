import type { CollectionDefinition } from "../collections/index.ts";
import { openProgressiveBodyFollower } from "../content/progressive.ts";
import {
  ContentStreamOwnershipLostError,
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
import { createActionInvocationContext } from "../actions/host.ts";
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
  const catalogedStreams = new Set<string>();
  const settlementScopeId = options.base.settlementScopeId;
  const localStreams = new Map<
    string,
    Readonly<{ settle(status: StreamTerminalStatus): void }>
  >();

  const streams = createContentStreamRuntime({
    namespace,
    store: options.streamBodyStore,
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
        const outputWithAuthority: StreamOutput = Object.freeze({
          ...descriptor,
          payload: lazyBodyFollower(async () => {
            const follower = await openProgressiveBodyFollower(
              options.streamBodyStore,
              {
                bodyId: operationStreamBodyId({
                  namespace,
                  streamId: output.id,
                  bodyPrefix: options.streamBodyPrefix,
                }),
              },
            );
            return follower.body;
          }),
          terminal,
        });
        localStreams.set(
          output.id,
          Object.freeze({
            settle: resolveTerminal,
          }),
        );
        publication.established();
        await options.publishLocalStream(outputWithAuthority);
        return;
      }
      const replayIdentity = await options.operationCatalog.openStream({
        namespace,
        operationId: settlementScopeId,
        semanticStreamId,
        bodyId: operationStreamBodyId({
          namespace,
          streamId: output.id,
          bodyPrefix: options.streamBodyPrefix,
        }),
        descriptor,
      });
      if (!replayIdentity) {
        throw new Error(
          `Operation stream '${output.id}' cannot open after its operation settled.`,
        );
      }
      catalogedStreams.add(output.id);
      // The catalog is itself a durable reconnect publication boundary.
      publication.established();
      await options.publishOutput?.(Object.freeze({
        ...descriptor,
        ...(replayIdentity ?? {}),
      }));
      publication.established();
    },
    async onAppend(stream, result) {
      if (!settlementScopeId || !catalogedStreams.has(stream.id)) return;
      if (
        !await options.operationCatalog.commitStreamOffset({
          namespace,
          operationId: settlementScopeId,
          streamId: stream.id,
          committedOffset: result.endOffset,
        })
      ) {
        throw new ContentStreamOwnershipLostError(stream.id);
      }
    },
    async onTerminalizing(stream, input) {
      if (!settlementScopeId || !catalogedStreams.has(stream.id)) return;
      const terminalizing = await options.operationCatalog
        .beginStreamTerminalization({
          namespace,
          operationId: settlementScopeId,
          streamId: stream.id,
          outcome: input.outcome,
          capture: input.capture,
        });
      if (!terminalizing) {
        const current = await options.operationCatalog.getStream(
          namespace,
          settlementScopeId,
          stream.id,
        );
        // Cancellation/supersession may win among non-completed outcomes, but
        // a Ready seal and an incomplete freeze are different physical
        // settlements. Never let a producer cross that cataloged boundary.
        if (
          current?.state === "terminating" &&
          (current.outcome === "completed") === (input.outcome === "completed")
        ) return;
        throw new Error(
          `Operation stream '${stream.id}' could not begin terminalization.`,
        );
      }
    },
    async onSeal(stream, body) {
      const local = localStreams.get(stream.id);
      if (local) {
        local.settle(Object.freeze({
          outcome: "completed",
          availability: "retained",
          capture: "complete",
          offset: body.byteLength,
          terminalAt: (options.now?.() ?? new Date()).toISOString(),
        }));
        localStreams.delete(stream.id);
        return;
      }
      if (!settlementScopeId || !catalogedStreams.has(stream.id)) return;
      if (
        !await options.operationCatalog.sealStream({
          namespace,
          operationId: settlementScopeId,
          streamId: stream.id,
          body,
        })
      ) {
        throw new Error(`Operation stream '${stream.id}' could not be sealed.`);
      }
    },
    async onTerminate(stream, body, input) {
      const local = localStreams.get(stream.id);
      if (local) {
        local.settle(Object.freeze({
          outcome: input.outcome,
          availability: "retained",
          capture: input.capture,
          offset: body.byteLength,
          terminalAt: (options.now?.() ?? new Date()).toISOString(),
        }));
        localStreams.delete(stream.id);
        return;
      }
      if (!settlementScopeId || !catalogedStreams.has(stream.id)) return;
      if (
        !await options.operationCatalog.terminateStream({
          namespace,
          operationId: settlementScopeId,
          streamId: stream.id,
          body,
          outcome: input.outcome,
          capture: input.capture,
        })
      ) {
        throw new Error(
          `Operation stream '${stream.id}' could not be terminated.`,
        );
      }
    },
    async onDiscard(stream) {
      localStreams.delete(stream.id);
      if (!settlementScopeId || !catalogedStreams.has(stream.id)) return;
      await options.operationCatalog.discardStream({
        namespace,
        operationId: settlementScopeId,
        streamId: stream.id,
      });
      catalogedStreams.delete(stream.id);
    },
    async onRetain(stream, input) {
      if (!settlementScopeId || !catalogedStreams.has(stream.id)) return;
      await options.operationCatalog.retainStream({
        namespace,
        operationId: settlementScopeId,
        streamId: stream.id,
        ...input,
      });
    },
  });

  const content: ProcessorContext["content"] = Object.freeze({
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
  });

  const collectionsByName = options.collections.withScope({
    namespace,
    createMutationIdentity: options.base.createMutationIdentity,
  });
  const collections = Object.freeze(Object.fromEntries(
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
  ));

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
        deduplicationId: transactionOptions.identity?.deduplicationId ??
          source.deduplicationId,
        metadata: {
          ...source.metadata,
          ...transactionOptions.identity?.metadata,
        },
      },
      execute: async ({ collections: byName, relations }) => {
        const transactionCollections = Object.freeze(Object.fromEntries(
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
        return await execute(Object.freeze({
          collections: transactionCollections,
          relations,
        }));
      },
    });
    return result.value;
  };

  const contextIdentity = Object.freeze({
    ...(options.base.event.durable
      ? { causationId: options.base.event.id }
      : options.base.event.causationId
      ? { causationId: options.base.event.causationId }
      : {}),
    correlationId: options.base.event.correlationId,
    deduplicationId: processorOperationKey,
    ...(options.base.settlementScopeId
      ? { settlementScopeId: options.base.settlementScopeId }
      : {}),
  });
  let rootActionIndex = 0;
  const actions = createActionCallers(options.registry.actions, {
    actionLifecycle: options.actionLifecycle,
    signal: options.base.signal,
    createInvocationKey: (actionId) =>
      `${processorOperationKey}:action:${++rootActionIndex}:${actionId}`,
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
    identity: contextIdentity,
    resources: options.registry.resources,
    adapters: options.registry.adapters,
    actions,
    content,
    streams,
    collections,
    signal: options.base.signal,
    now: options.now ?? (() => new Date()),
    transaction,
  }, options.protectedEventResolver);
  const context: ProcessorContext = Object.freeze(contextValue);
  return context;
}
