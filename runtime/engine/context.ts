import {
  type MutationIdentity,
  projectDomainRelation,
} from "../domain/index.ts";
import {
  activeCollectionTransaction,
  type CollectionDefinition,
} from "../collections/index.ts";
import { createContentStreamRuntime } from "../content/index.ts";
import {
  createEphemeralEvent,
  type EventRouting,
  type EventVisibility,
  matchesCopilotzEvent,
  waitForCopilotzEvent,
} from "../events/index.ts";
import {
  type ActionContext,
  type ActionTransactionContext,
  actionTransactionIdentity,
  type ActionTransactionOptions,
  createActionCallers,
} from "../actions/index.ts";
import type {
  CopilotzCapabilityBase,
  CopilotzProcessorCapabilities,
  CreateCopilotzProcessorCapabilitiesOptions,
  ScopedMutationOptions,
} from "./types.ts";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function identity(
  options: CreateCopilotzProcessorCapabilitiesOptions,
  fallback: string,
  mutation: ScopedMutationOptions | undefined,
): MutationIdentity {
  const operationKey = requiredText(
    mutation?.operationKey ?? fallback,
    "Mutation operation key",
  );
  return options.base.createMutationIdentity(
    operationKey,
    mutation?.metadata,
  );
}

function capabilitySourceMetadata(
  base: CopilotzCapabilityBase,
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

function contentMutationContext(
  options: CreateCopilotzProcessorCapabilitiesOptions,
) {
  return {
    transaction: activeCollectionTransaction(options.collectionRuntime) ??
      options.session,
    tables: options.eventStore.tables,
  };
}

/** Binds typed processor capabilities to one delivery's tenant and identity. */
export function createCopilotzProcessorCapabilities(
  options: CreateCopilotzProcessorCapabilitiesOptions,
): CopilotzProcessorCapabilities {
  const namespace = requiredText(options.base.event.namespace, "Namespace");
  const mutation = (
    fallback: string,
    value?: ScopedMutationOptions,
  ): MutationIdentity => identity(options, fallback, value);

  const events: CopilotzProcessorCapabilities["events"] = Object.freeze({
    async emit(input) {
      const event = createEphemeralEvent({
        ...input,
        namespace,
        threadId: input.threadId ?? options.base.event.threadId,
        routing: input.routing ?? options.base.event.routing,
        visibility: input.visibility ?? options.base.event.visibility,
        metadata: {
          ...structuredClone(input.metadata ?? {}),
          ...capabilitySourceMetadata(options.base),
        },
        causationId: input.causationId ??
          (options.base.event.durable
            ? options.base.event.id
            : options.base.event.causationId),
        correlationId: input.correlationId ??
          options.base.event.correlationId,
      }, options.now);
      if (options.publishEvent) await options.publishEvent(event);
      else await options.eventHub.publish(event);
      return event;
    },
    async list(listOptions = {}) {
      const { limit, ...filterInput } = listOptions;
      const filter = { ...filterInput, namespace, durable: true } as const;
      const values = await options.eventStore.listEvents({
        namespace,
        threadId: filter.threadId,
        correlationId: filter.correlationId,
        afterPosition: filter.afterPosition,
        limit: limit ?? 1_000,
      });
      return Object.freeze(
        values.filter((event) => matchesCopilotzEvent(event, filter)),
      );
    },
    waitFor(waitOptions) {
      const { timeoutMs, pollIntervalMs, ...filterInput } = waitOptions;
      const filter = Object.freeze({ ...filterInput, namespace });
      return waitForCopilotzEvent({
        hub: options.eventHub,
        filter,
        signal: options.base.signal,
        timeoutMs,
        pollIntervalMs,
        loadDurable: () =>
          options.eventStore.listEvents({
            namespace,
            threadId: filter.threadId,
            correlationId: filter.correlationId,
            afterPosition: filter.afterPosition,
            limit: 1_000,
          }),
      });
    },
  });

  const content: CopilotzProcessorCapabilities["content"] = Object.freeze({
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
      return options.assets.materialize(contentMutationContext(options), {
        namespace,
        content: input,
        origin: materializeOptions.origin,
      });
    },
    linkOwner(ownerId, content) {
      return options.assets.linkOwner(
        contentMutationContext(options),
        { namespace, ownerId, content },
      );
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
    stream: createContentStreamRuntime({
      namespace,
      store: options.streamBodyStore,
      async onOpen(output) {
        const threadId = output.threadId ?? options.base.event.threadId;
        if (!threadId) return;
        const event = createEphemeralEvent({
          type: "stream.output",
          namespace,
          threadId,
          streamId: output.id,
          payload: {
            streamId: output.id,
            mediaType: output.mediaType,
            role: output.role,
            ...(output.participantId
              ? { participantId: output.participantId }
              : {}),
          },
          routing: (output.routing as EventRouting | undefined) ??
            options.base.event.routing,
          visibility: (output.visibility as EventVisibility | undefined) ??
            options.base.event.visibility,
          metadata: {
            ...structuredClone(output.metadata),
            ...capabilitySourceMetadata(options.base),
            contentStream: true,
            role: output.role,
          },
          causationId: options.base.event.durable
            ? options.base.event.id
            : options.base.event.causationId,
          correlationId: output.correlationId ??
            options.base.event.correlationId,
        }, options.now);
        if (options.publishEvent) await options.publishEvent(event);
        else await options.eventHub.publish(event);
      },
    }),
  });

  const relations: CopilotzProcessorCapabilities["relations"] = Object.freeze({
    create(input, mutationOptions) {
      return options.relations.create({
        ...input,
        namespace,
        identity: mutation(
          `relation.create:${
            input.id ?? `${input.source.id}:${input.type}:${input.target.id}`
          }`,
          mutationOptions,
        ),
      });
    },
    delete(input, mutationOptions) {
      return options.relations.delete({
        ...input,
        namespace,
        identity: mutation(`relation.delete:${input.id}`, mutationOptions),
      });
    },
    get: (id) => options.relations.get(namespace, id),
    list: (listOptions = {}) =>
      options.relations.list({ ...listOptions, namespace }),
  });

  const schedules: CopilotzProcessorCapabilities["schedules"] = Object.freeze({
    runNow(id, runOptions = {}) {
      const {
        operationKey,
        metadata,
        ...settlementOptions
      } = runOptions;
      return options.schedules.runNow({
        ...settlementOptions,
        namespace,
        id,
        identity: mutation(
          `scheduled_job.run_now:${id}`,
          { operationKey, metadata },
        ),
      });
    },
  });

  const collectionsByName = Object.freeze({
    ...options.collections.withScope({
      namespace,
      createMutationIdentity: options.base.createMutationIdentity,
    }),
    ...options.collectionRuntime.withScope({
      namespace,
      createMutationIdentity: options.base.createMutationIdentity,
    }),
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

  const transaction = async <T>(
    execute: (context: ActionTransactionContext<typeof collections>) =>
      | T
      | Promise<T>,
    transactionOptions: ActionTransactionOptions = {},
  ): Promise<T> => {
    const operationKey = transactionOptions.operationKey?.trim() ||
      `transaction:${crypto.randomUUID()}`;
    const source = options.base.createMutationIdentity(
      operationKey,
      transactionOptions.identity?.metadata,
    );
    const result = await options.collectionRuntime.transaction({
      operationKey,
      namespace,
      identity: {
        causationId: transactionOptions.identity?.causationId ??
          source.causationId,
        correlationId: transactionOptions.identity?.correlationId ??
          source.correlationId,
        settlementScopeId: transactionOptions.identity?.settlementScopeId ??
          source.settlementScopeId,
        ...(transactionOptions.identity?.deduplicationId
          ? { deduplicationId: transactionOptions.identity.deduplicationId }
          : {}),
        metadata: {
          ...source.metadata,
          ...transactionOptions.identity?.metadata,
        },
      },
      execute: async () => {
        const relations = Object.freeze({
          upsert(
            input: Parameters<
              ActionTransactionContext["relations"]["upsert"]
            >[0],
          ) {
            const active = activeCollectionTransaction(
              options.collectionRuntime,
            );
            if (!active) {
              throw new Error(
                "Action transaction relation projection requires an active transaction.",
              );
            }
            return projectDomainRelation(active, options.eventStore.tables, {
              ...input,
              namespace,
            });
          },
        });
        return await execute(Object.freeze({ collections, relations }));
      },
    });
    return result.value;
  };

  const deliveries = Object.freeze({
    list: (listOptions = {}) =>
      options.eventStore.listDeliveries({
        ...listOptions,
        namespace,
      }),
  });

  const invocationKey = options.base.source?.id ??
    (options.base.event.durable
      ? options.base.event.id
      : options.base.event.correlationId);
  let rootActionIndex = 0;
  const actions = createActionCallers(options.registry.actions, {
    actionLifecycle: options.actionLifecycle,
    createInvocationKey: (actionId) =>
      `${invocationKey}:action:${++rootActionIndex}:${actionId}`,
    identity: {
      causationId: options.base.event.durable
        ? options.base.event.id
        : options.base.event.causationId,
      correlationId: options.base.event.correlationId,
      deduplicationId: invocationKey,
      settlementScopeId: options.base.settlementScopeId,
    },
    createContext({ frame, actions: nestedActions, progress }) {
      let transactionIndex = 0;
      const actionContent = Object.freeze({
        ...content,
        prepare(
          input: Parameters<typeof content.prepare>[0],
          prepareOptions: Parameters<typeof content.prepare>[1],
        ) {
          return content.prepare(input, {
            ...prepareOptions,
            operationKey:
              `${frame.operationKey}/${prepareOptions.operationKey}`,
          });
        },
        publish(
          input: Parameters<typeof content.publish>[0],
          publishOptions: Parameters<typeof content.publish>[1],
        ) {
          return content.publish(input, {
            ...publishOptions,
            operationKey:
              `${frame.operationKey}/${publishOptions.operationKey}`,
          });
        },
      });
      return Object.freeze({
        ...options.base,
        ...capabilities,
        deliveries,
        action: Object.freeze({
          id: frame.actionId,
          runId: frame.actionRunId,
          ...(frame.parentActionRunId
            ? { parentRunId: frame.parentActionRunId }
            : {}),
        }),
        operationKey: frame.operationKey,
        identity: Object.freeze({ ...(frame.identity ?? {}) }),
        actions: nestedActions,
        content: actionContent,
        streams: content.stream,
        ...(frame.signal ? { signal: frame.signal } : {}),
        progress,
        transaction: (
          execute: Parameters<ActionContext["transaction"]>[0],
          actionOptions: ActionTransactionOptions = {},
        ) => {
          const localKey = actionOptions.operationKey?.trim() ||
            `transaction:${++transactionIndex}`;
          const identity = actionTransactionIdentity(
            frame.identity,
            actionOptions.identity,
          );
          return transaction(execute as never, {
            ...actionOptions,
            operationKey: `${frame.operationKey}/${localKey}`,
            ...(identity ? { identity } : {}),
            signal: actionOptions.signal ?? frame.signal,
          }) as never;
        },
      }) as ActionContext;
    },
  });

  const capabilities: CopilotzProcessorCapabilities = Object.freeze({
    namespace,
    resources: options.registry.resources,
    adapters: options.registry.adapters,
    actions,
    events,
    content,
    streams: content.stream,
    collections,
    relations,
    schedules,
    now: options.now ?? (() => new Date()),
    transaction,
    deliveries,
  });
  return capabilities;
}
