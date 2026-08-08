import type { MutationIdentity } from "../domain/index.ts";
import {
  createEphemeralEvent,
  matchesCopilotzEvent,
  waitForCopilotzEvent,
} from "../events/index.ts";
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

  const resources: CopilotzProcessorCapabilities["resources"] = Object.freeze({
    list: <T extends object = object>(
      type: Parameters<typeof options.registry.list>[0],
    ) => options.registry.list<T>(type),
    get: <T extends object = object>(
      type: Parameters<typeof options.registry.get>[0],
      id: string,
    ) => options.registry.get<T>(type, id),
    require: <T extends object = object>(
      type: Parameters<typeof options.registry.require>[0],
      id: string,
    ) => options.registry.require<T>(type, id),
    origin: (type, id) => options.registry.origin(type, id),
  });

  const content: CopilotzProcessorCapabilities["content"] = Object.freeze({
    prepare(input, prepareOptions) {
      const preparedIdentity = mutation(
        `content.prepare:${prepareOptions.operationKey}`,
      );
      return options.preparer.prepare(input, {
        namespace,
        idempotencyKey: preparedIdentity.deduplicationId,
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

  const conversation: CopilotzProcessorCapabilities["conversation"] = Object
    .freeze({
      createParticipant(input, mutationOptions) {
        const key = input.participant.id ?? input.participant.externalId;
        return options.conversation.createParticipant({
          ...input,
          namespace,
          identity: mutation(`participant.create:${key}`, mutationOptions),
        });
      },
      updateParticipant(id, patch, mutationOptions) {
        return options.conversation.updateParticipant({
          namespace,
          id,
          patch,
          identity: mutation(
            `participant.update:${id}`,
            mutationOptions,
          ),
        });
      },
      getParticipant: (id) =>
        options.conversation.getParticipant(namespace, id),
      getParticipantByExternalId: (externalId) =>
        options.conversation.getParticipantByExternalId(namespace, externalId),
      listParticipants: (listOptions) =>
        options.conversation.listParticipants(namespace, listOptions),
      createThread(input, mutationOptions) {
        const key = input.id ?? input.externalId ?? "thread";
        return options.conversation.createThread({
          ...input,
          namespace,
          identity: mutation(`thread.create:${key}`, mutationOptions),
        });
      },
      addThreadParticipant(input, mutationOptions) {
        return options.conversation.addThreadParticipant({
          ...input,
          namespace,
          identity: mutation(
            `thread.participant.add:${input.threadId}:${input.participant.externalId}`,
            mutationOptions,
          ),
        });
      },
      updateThread(id, patch, mutationOptions) {
        return options.conversation.updateThread({
          namespace,
          id,
          patch,
          identity: mutation(`thread.update:${id}`, mutationOptions),
        });
      },
      deleteThread(id, mutationOptions) {
        return options.conversation.deleteThread({
          namespace,
          id,
          identity: mutation(`thread.delete:${id}`, mutationOptions),
        });
      },
      getThread: (id) => options.conversation.getThread(namespace, id),
      getThreadByExternalId: (externalId) =>
        options.conversation.getThreadByExternalId(namespace, externalId),
      listThreads: (listOptions) =>
        options.conversation.listThreads(namespace, listOptions),
      createMessage(input, mutationOptions) {
        const key = input.id ?? input.threadId;
        return options.conversation.createMessage({
          ...input,
          namespace,
          identity: mutation(`message.create:${key}`, mutationOptions),
        });
      },
      reviseMessage(input, mutationOptions) {
        const key = input.id ?? input.messageId;
        return options.conversation.reviseMessage({
          ...input,
          namespace,
          identity: mutation(`message.revise:${key}`, mutationOptions),
        });
      },
      deleteThreadMessages(threadId, mutationOptions) {
        return options.conversation.deleteThreadMessages({
          namespace,
          threadId,
          identity: mutation(
            `thread.messages.delete:${threadId}`,
            mutationOptions,
          ),
        });
      },
      getMessage: (id) => options.conversation.getMessage(namespace, id),
      listMessages: (threadId, listOptions) =>
        options.conversation.listMessages(namespace, threadId, listOptions),
      listMessageRevisions: (rootMessageId) =>
        options.conversation.listMessageRevisions(namespace, rootMessageId),
    });

  const llmAttempts: CopilotzProcessorCapabilities["llmAttempts"] = Object
    .freeze({
      create(input, mutationOptions) {
        const key = input.id ??
          `${input.threadId}:${input.attemptIndex ?? 0}:${
            input.provider ?? "logical"
          }`;
        return options.llmAttempts.create({
          ...input,
          namespace,
          identity: mutation(`llm_attempt.create:${key}`, mutationOptions),
        });
      },
      update(input, mutationOptions) {
        return options.llmAttempts.update({
          ...input,
          namespace,
          identity: mutation(
            `llm_attempt.update:${input.id}`,
            mutationOptions,
          ),
        });
      },
      complete(input, mutationOptions) {
        return options.llmAttempts.complete({
          ...input,
          namespace,
          identity: mutation(
            `llm_attempt.complete:${input.id}`,
            mutationOptions,
          ),
        });
      },
      fail(input, mutationOptions) {
        return options.llmAttempts.fail({
          ...input,
          namespace,
          identity: mutation(`llm_attempt.fail:${input.id}`, mutationOptions),
        });
      },
      cancel(input, mutationOptions) {
        return options.llmAttempts.cancel({
          ...input,
          namespace,
          identity: mutation(
            `llm_attempt.cancel:${input.id}`,
            mutationOptions,
          ),
        });
      },
      get: (id) => options.llmAttempts.get(namespace, id),
      list: (threadId, listOptions) =>
        options.llmAttempts.list(namespace, threadId, listOptions),
    });

  const toolExecutions: CopilotzProcessorCapabilities["toolExecutions"] = Object
    .freeze({
      create(input, mutationOptions) {
        const key = input.id ?? `${input.threadId}:${input.toolCallId}`;
        return options.toolExecutions.create({
          ...input,
          namespace,
          identity: mutation(
            `tool_execution.create:${key}`,
            mutationOptions,
          ),
        });
      },
      update(input, mutationOptions) {
        return options.toolExecutions.update({
          ...input,
          namespace,
          identity: mutation(
            `tool_execution.update:${input.id}`,
            mutationOptions,
          ),
        });
      },
      complete(input, mutationOptions) {
        return options.toolExecutions.complete({
          ...input,
          namespace,
          identity: mutation(
            `tool_execution.complete:${input.id}`,
            mutationOptions,
          ),
        });
      },
      fail(input, mutationOptions) {
        return options.toolExecutions.fail({
          ...input,
          namespace,
          identity: mutation(
            `tool_execution.fail:${input.id}`,
            mutationOptions,
          ),
        });
      },
      cancel(input, mutationOptions) {
        return options.toolExecutions.cancel({
          ...input,
          namespace,
          identity: mutation(
            `tool_execution.cancel:${input.id}`,
            mutationOptions,
          ),
        });
      },
      get: (id) => options.toolExecutions.get(namespace, id),
      getByToolCallId: (threadId, toolCallId) =>
        options.toolExecutions.getByToolCallId(
          namespace,
          threadId,
          toolCallId,
        ),
      list: (threadId, listOptions) =>
        options.toolExecutions.list(namespace, threadId, listOptions),
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
    create(input, mutationOptions) {
      const key = input.id ?? input.name;
      return options.schedules.create({
        ...input,
        namespace,
        identity: mutation(`scheduled_job.create:${key}`, mutationOptions),
      });
    },
    update(input, mutationOptions) {
      return options.schedules.update({
        ...input,
        namespace,
        identity: mutation(
          `scheduled_job.update:${input.id}`,
          mutationOptions,
        ),
      });
    },
    pause(id, mutationOptions) {
      return options.schedules.pause(
        namespace,
        id,
        mutation(`scheduled_job.pause:${id}`, mutationOptions),
      );
    },
    resume(id, mutationOptions) {
      return options.schedules.resume(
        namespace,
        id,
        mutation(`scheduled_job.resume:${id}`, mutationOptions),
      );
    },
    cancel(id, mutationOptions) {
      return options.schedules.cancel(
        namespace,
        id,
        mutation(`scheduled_job.cancel:${id}`, mutationOptions),
      );
    },
    get: (id) => options.schedules.get(namespace, id),
    list: (listOptions) => options.schedules.list(namespace, listOptions),
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

  const knowledge: CopilotzProcessorCapabilities["knowledge"] = Object.freeze({
    create(input, mutationOptions) {
      const key = input.id ?? input.externalId ??
        (input.source.kind === "uri" ? input.source.uri : "document");
      return options.knowledge.create({
        ...input,
        namespace,
        identity: mutation(`document.create:${key}`, mutationOptions),
      });
    },
    begin(id, mutationOptions) {
      return options.knowledge.begin(
        namespace,
        id,
        mutation(`document.begin:${id}`, mutationOptions),
      );
    },
    complete(input, mutationOptions) {
      return options.knowledge.complete({
        ...input,
        namespace,
        identity: mutation(`document.complete:${input.id}`, mutationOptions),
      });
    },
    markDuplicate(input, mutationOptions) {
      return options.knowledge.markDuplicate({
        ...input,
        namespace,
        identity: mutation(
          `document.duplicate:${input.id}`,
          mutationOptions,
        ),
      });
    },
    fail(input, mutationOptions) {
      return options.knowledge.fail({
        ...input,
        namespace,
        identity: mutation(`document.fail:${input.id}`, mutationOptions),
      });
    },
    delete(id, mutationOptions) {
      return options.knowledge.delete(
        namespace,
        id,
        mutation(`document.delete:${id}`, mutationOptions),
      );
    },
    get: (id) => options.knowledge.get(namespace, id),
    getByHash: (hash) => options.knowledge.getByHash(namespace, hash),
    getBySourceUri: (sourceUri) =>
      options.knowledge.getBySourceUri(namespace, sourceUri),
    list: (listOptions) => options.knowledge.list(namespace, listOptions),
    listChunks: (documentId) =>
      options.knowledge.listChunks(namespace, documentId),
    search: (input) => options.knowledge.search({ ...input, namespace }),
  });

  return Object.freeze({
    namespace,
    events,
    resources,
    content,
    conversation,
    collections: options.collections.withScope({
      namespace,
      createMutationIdentity: options.base.createMutationIdentity,
    }),
    llmAttempts,
    toolExecutions,
    relations,
    schedules,
    knowledge,
  });
}
