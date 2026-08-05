import type {
  CopilotzEvent,
  DurableEvent,
  DurableEventDraft,
  EphemeralEvent,
} from "@/events/types.ts";
import type {
  CommitMutationResult,
  EventStore,
} from "@/database/event-store.ts";
import type { DomainStore } from "@/database/domain-store.ts";
import type { PluginRegistry } from "@/plugins/registry.ts";
import type {
  Agent,
  ParticipantRecord,
  RealtimeProviderOutput,
  RealtimeProviderResource,
  ThreadRecord,
} from "@/types/resources.ts";

export interface StreamExecutionInput {
  streamId: string;
  type: string;
  mediaType: string;
  payload: ReadableStream<Uint8Array>;
  namespace: string;
  thread: ThreadRecord;
  participant: ParticipantRecord;
  targetId?: string;
  provider?: string;
  metadata: Record<string, unknown>;
  correlationId: string;
  signal: AbortSignal;
}

export interface StreamExecutionSink {
  event(event: CopilotzEvent): void | Promise<void>;
  stream(
    output: Extract<RealtimeProviderOutput, { kind: "stream" }>,
  ): void | Promise<void>;
}

export interface StreamExecutorOptions {
  store: EventStore;
  domain: DomainStore;
  registry: PluginRegistry;
  committed(result: CommitMutationResult<unknown>): void | Promise<void>;
}

function matchable(draft: DurableEventDraft): DurableEvent {
  const id = draft.deduplicationId ?? "uncommitted";
  return {
    durable: true,
    id,
    position: "0",
    schemaVersion: 2,
    type: draft.type,
    namespace: draft.namespace,
    ...(draft.threadId ? { threadId: draft.threadId } : {}),
    ...(draft.subject ? { subject: draft.subject } : {}),
    payload: draft.payload,
    ...(draft.delta === undefined ? {} : { delta: draft.delta }),
    routing: draft.routing ?? {},
    visibility: draft.visibility ?? { kind: "public" },
    metadata: draft.metadata ?? {},
    ...(draft.causationId ? { causationId: draft.causationId } : {}),
    correlationId: draft.correlationId ?? id,
    ...(draft.deduplicationId
      ? { deduplicationId: draft.deduplicationId }
      : {}),
    createdAt: draft.createdAt ?? new Date().toISOString(),
  };
}

function normalizeEphemeral(
  event: EphemeralEvent,
  input: StreamExecutionInput,
): EphemeralEvent {
  return {
    ...event,
    durable: false,
    namespace: event.namespace || input.namespace,
    threadId: event.threadId ?? input.thread.id,
    correlationId: event.correlationId || input.correlationId,
    streamId: event.streamId ?? input.streamId,
    createdAt: event.createdAt || new Date().toISOString(),
  };
}

function waitForEventPoll(
  signal: AbortSignal,
  milliseconds = 25,
): Promise<void> {
  if (signal.aborted) {
    return Promise.reject(
      signal.reason ??
        new DOMException("Stream event feed aborted", "AbortError"),
    );
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      reject(
        signal.reason ??
          new DOMException("Stream event feed aborted", "AbortError"),
      );
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function createSemanticEventFeed(
  store: EventStore,
  input: StreamExecutionInput,
  afterPosition: string,
  controller: AbortController,
): ReadableStream<DurableEvent> {
  let position = afterPosition;
  return new ReadableStream<DurableEvent>({
    async pull(stream) {
      try {
        while (!controller.signal.aborted) {
          const [event] = await store.listEvents({
            namespace: input.namespace,
            threadId: input.thread.id,
            correlationId: input.correlationId,
            afterPosition: position,
            limit: 1,
          });
          if (event) {
            position = event.position;
            stream.enqueue(event);
            return;
          }
          await waitForEventPoll(controller.signal);
        }
        stream.close();
      } catch (error) {
        if (controller.signal.aborted) {
          try {
            stream.close();
          } catch {
            // The consumer may already have cancelled the stream.
          }
          return;
        }
        stream.error(error);
      }
    },
    cancel(reason) {
      controller.abort(reason);
    },
  });
}

export class StreamExecutor {
  readonly #options: StreamExecutorOptions;

  constructor(options: StreamExecutorOptions) {
    this.#options = options;
  }

  async execute(
    input: StreamExecutionInput,
    sink: StreamExecutionSink,
  ): Promise<void> {
    const opened = await this.#append({
      type: "stream.opened",
      namespace: input.namespace,
      threadId: input.thread.id,
      subject: { type: "stream", id: input.streamId },
      payload: {
        streamId: input.streamId,
        type: input.type,
        mediaType: input.mediaType,
        participantId: input.participant.id,
        targetId: input.targetId ?? null,
      },
      routing: {
        senderId: input.participant.id,
        ...(input.targetId ? { recipientIds: [input.targetId] } : {}),
      },
      visibility: { kind: "public" },
      metadata: input.metadata,
      correlationId: input.correlationId,
      deduplicationId: `${input.streamId}:opened`,
    });
    await sink.event(opened);

    try {
      const agent = this.#resolveAgent(input.targetId);
      const provider = this.#resolveProvider(input.provider, agent);
      if (!provider) {
        // The foundation remains useful without a provider: consume the stream
        // with real backpressure and expose its semantic lifecycle.
        for await (const _chunk of input.payload) {
          if (input.signal.aborted) throw input.signal.reason;
        }
      } else {
        const eventFeedController = new AbortController();
        const abortEventFeed = () =>
          eventFeedController.abort(input.signal.reason);
        input.signal.addEventListener("abort", abortEventFeed, { once: true });
        if (input.signal.aborted) abortEventFeed();
        try {
          const outputs = await provider.run({
            streamId: input.streamId,
            type: input.type,
            mediaType: input.mediaType,
            payload: input.payload,
            namespace: input.namespace,
            threadId: input.thread.id,
            participant: input.participant,
            agent,
            metadata: input.metadata,
            correlationId: input.correlationId,
            events: createSemanticEventFeed(
              this.#options.store,
              input,
              opened.position,
              eventFeedController,
            ),
            signal: input.signal,
          });
          let sequence = 0;
          for await (const output of outputs) {
            if (input.signal.aborted) throw input.signal.reason;
            if (output.kind === "stream") {
              await sink.stream({
                ...output,
                causationId: output.causationId ?? opened.id,
                correlationId: output.correlationId ?? input.correlationId,
              });
              continue;
            }
            if (output.kind === "message") {
              const participant = output.participant ??
                (agent
                  ? await this.#options.domain.ensureParticipant(
                    input.namespace,
                    {
                      externalId: agent.id,
                      participantType: "agent",
                      name: agent.name,
                      agentId: agent.id,
                    },
                    {
                      causationId: opened.id,
                      correlationId: input.correlationId,
                      deduplicationId:
                        `${input.streamId}:participant:${agent.id}`,
                    },
                  )
                  : input.participant);
              await this.#options.domain.addParticipant(
                input.namespace,
                input.thread.id,
                participant.id,
                {
                  causationId: opened.id,
                  correlationId: input.correlationId,
                  deduplicationId:
                    `${input.streamId}:membership:${participant.id}`,
                },
              );
              await this.#options.domain.createMessage({
                namespace: input.namespace,
                thread: input.thread,
                participant,
                input: {
                  ...output.input,
                  metadata: {
                    ...(output.input.metadata ?? {}),
                    runtime: "realtime",
                    realtimeStreamId: input.streamId,
                  },
                },
                correlationId: input.correlationId,
                context: {
                  causationId: opened.id,
                  correlationId: input.correlationId,
                  deduplicationId: `${input.streamId}:message:${sequence++}`,
                },
              });
              continue;
            }
            if ("durable" in output.event) {
              const event = normalizeEphemeral(output.event, input);
              await sink.event(event);
            } else {
              const event = await this.#append({
                ...output.event,
                namespace: input.namespace,
                threadId: output.event.threadId ?? input.thread.id,
                causationId: output.event.causationId ?? opened.id,
                correlationId: input.correlationId,
                deduplicationId: output.event.deduplicationId ??
                  `${input.streamId}:event:${sequence++}`,
              });
              await sink.event(event);
            }
          }
        } finally {
          input.signal.removeEventListener("abort", abortEventFeed);
          eventFeedController.abort("realtime_provider_finished");
        }
      }

      const closed = await this.#append({
        type: "stream.closed",
        namespace: input.namespace,
        threadId: input.thread.id,
        subject: { type: "stream", id: input.streamId },
        payload: { streamId: input.streamId },
        routing: { senderId: input.participant.id },
        visibility: { kind: "public" },
        metadata: input.metadata,
        causationId: opened.id,
        correlationId: input.correlationId,
        deduplicationId: `${input.streamId}:closed`,
      });
      await sink.event(closed);
    } catch (error) {
      const interrupted = input.signal.aborted;
      const terminal = await this.#append({
        type: interrupted ? "stream.interrupted" : "stream.failed",
        namespace: input.namespace,
        threadId: input.thread.id,
        subject: { type: "stream", id: input.streamId },
        payload: {
          streamId: input.streamId,
          error: error instanceof Error
            ? { name: error.name, message: error.message }
            : { name: "Error", message: String(error) },
        },
        routing: { senderId: input.participant.id },
        visibility: { kind: "public" },
        metadata: input.metadata,
        causationId: opened.id,
        correlationId: input.correlationId,
        deduplicationId: `${input.streamId}:${
          interrupted ? "interrupted" : "failed"
        }`,
      });
      await sink.event(terminal);
      throw error;
    }
  }

  #resolveAgent(targetId?: string): Agent | undefined {
    if (targetId) {
      return this.#options.registry.list("agents").find((agent) =>
        agent.id === targetId || agent.name === targetId
      );
    }
    return this.#options.registry.list("agents").find((agent) =>
      agent.runtimes?.realtime
    );
  }

  #resolveProvider(
    explicit: string | undefined,
    agent: Agent | undefined,
  ): RealtimeProviderResource | undefined {
    const id = explicit ?? agent?.runtimes?.realtime?.provider;
    if (!id) return undefined;
    const provider = this.#options.registry.get("providers", id);
    if (!provider) throw new Error(`Unknown realtime provider '${id}'.`);
    if (provider.kind !== "realtime") {
      throw new TypeError(`Provider '${id}' is not a realtime provider.`);
    }
    return provider;
  }

  async #append(draft: DurableEventDraft): Promise<DurableEvent> {
    const result = await this.#options.store.append(
      draft,
      this.#options.registry.matchDurable(matchable(draft)).map((processor) =>
        processor.id
      ),
    );
    if (!result.deduplicated) await this.#options.committed(result);
    return result.event;
  }
}
