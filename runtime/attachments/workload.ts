import type { Agent } from "../resources/index.ts";
import type { EventStore } from "../events/index.ts";
import type { DeliveryWorkload } from "../execution/index.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import type {
  RealtimeProviderContextFactory,
  RealtimeProviderResource,
  StreamDispatchMetadata,
} from "./types.ts";

export type CreateRealtimeStreamWorkloadOptions = Readonly<{
  registry: PluginRegistry;
  /** Required only when realtime providers need typed semantic capabilities. */
  eventStore?: Pick<EventStore, "getEvent">;
  createContext?: RealtimeProviderContextFactory;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(
  value: Readonly<Record<string, unknown>>,
  key: keyof StreamDispatchMetadata,
): string {
  const candidate = value[key];
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new TypeError(`Stream dispatch metadata requires '${key}'.`);
  }
  return candidate.trim();
}

export function parseStreamDispatchMetadata(
  value: Readonly<Record<string, unknown>>,
): StreamDispatchMetadata {
  if (value.schema !== "copilotz.stream.dispatch.v1") {
    throw new TypeError(
      `Unsupported stream dispatch schema '${String(value.schema)}'.`,
    );
  }
  return Object.freeze({
    schema: "copilotz.stream.dispatch.v1",
    streamId: requiredText(value, "streamId"),
    eventId: requiredText(value, "eventId"),
    namespace: requiredText(value, "namespace"),
    threadId: requiredText(value, "threadId"),
    correlationId: requiredText(value, "correlationId"),
    inputType: requiredText(value, "inputType"),
    mediaType: requiredText(value, "mediaType"),
    participantId: requiredText(value, "participantId"),
    recipientId: requiredText(value, "recipientId"),
    agentId: requiredText(value, "agentId"),
    providerId: requiredText(value, "providerId"),
    metadata: Object.freeze(structuredClone(record(value.metadata))),
  });
}

export function isRealtimeProviderResource(
  value: unknown,
): value is RealtimeProviderResource {
  const candidate = record(value);
  return typeof candidate.id === "string" && candidate.id.trim().length > 0 &&
    candidate.type === "realtime" && typeof candidate.open === "function";
}

export function defineRealtimeProviderResource(
  resource: RealtimeProviderResource,
): RealtimeProviderResource {
  const id = resource.id?.trim();
  if (!id) throw new TypeError("Realtime provider resource ID is required.");
  if (resource.type !== "realtime" || typeof resource.open !== "function") {
    throw new TypeError(`Realtime provider '${id}' requires an open function.`);
  }
  return Object.freeze({ ...resource, id });
}

/** Resolves and executes one raw Web Stream entirely inside an Oxian worker. */
export function createRealtimeStreamWorkload(
  options: CreateRealtimeStreamWorkloadOptions,
): DeliveryWorkload {
  if (options.createContext && !options.eventStore) {
    throw new TypeError(
      "A realtime context factory requires an event store.",
    );
  }
  return async ({ metadata: rawMetadata, input, signal }) => {
    const metadata = parseStreamDispatchMetadata(rawMetadata);
    const provider = options.registry.get<RealtimeProviderResource>(
      "providers",
      metadata.providerId,
    );
    if (!provider || !isRealtimeProviderResource(provider)) {
      throw new Error(
        `Realtime provider '${metadata.providerId}' is not registered.`,
      );
    }
    const agent = options.registry.get<Agent>("agents", metadata.agentId);
    if (!agent) {
      throw new Error(`Agent '${metadata.agentId}' is not registered.`);
    }
    let context;
    if (options.createContext) {
      const event = await options.eventStore!.getEvent(metadata.eventId);
      if (!event) {
        throw new Error(`Stream event '${metadata.eventId}' was not found.`);
      }
      if (
        event.namespace !== metadata.namespace ||
        event.threadId !== metadata.threadId ||
        event.correlationId !== metadata.correlationId
      ) {
        throw new TypeError("Stream event dispatch scope does not match.");
      }
      const createMutationIdentity = (
        operationKey: string,
        mutationMetadata: Record<string, unknown> = {},
      ) => {
        const key = operationKey.trim();
        if (!key) {
          throw new TypeError(
            "A realtime mutation operation key is required.",
          );
        }
        return Object.freeze({
          causationId: event.id,
          correlationId: event.correlationId,
          deduplicationId: `stream:${metadata.streamId}:${key}`,
          metadata: Object.freeze({
            ...structuredClone(mutationMetadata),
            sourceEventId: event.id,
            sourceStreamId: metadata.streamId,
            sourceProviderId: metadata.providerId,
            sourceAgentId: metadata.agentId,
          }),
        });
      };
      context = await options.createContext(Object.freeze({
        event,
        metadata,
        signal,
        createMutationIdentity,
      }));
    }
    const result = await provider.open({
      streamId: metadata.streamId,
      namespace: metadata.namespace,
      threadId: metadata.threadId,
      correlationId: metadata.correlationId,
      inputType: metadata.inputType,
      mediaType: metadata.mediaType,
      participantId: metadata.participantId,
      recipientId: metadata.recipientId,
      agentId: metadata.agentId,
      agent,
      input,
      metadata: metadata.metadata,
      ...(context ? { context } : {}),
      signal,
    });
    const hasOutput = result.output !== undefined;
    return {
      metadata: {
        ...(result.metadata ?? {}),
        schema: "copilotz.stream.result.v1",
        streamId: metadata.streamId,
        hasOutput,
        mediaType: result.mediaType ?? metadata.mediaType,
      },
      ...(hasOutput ? { body: result.output } : {}),
    };
  };
}
