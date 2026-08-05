import { ulid } from "ulid";
import type { DomainStore } from "@/database/domain-store.ts";
import type {
  CommitMutationResult,
  EventStore,
} from "@/database/event-store.ts";
import type {
  CopilotzEvent,
  DurableEvent,
  DurableEventDraft,
  EventSendHandle,
} from "@/events/types.ts";
import type { PluginRegistry } from "@/plugins/registry.ts";
import type { DeliveryCoordinator } from "@/execution/coordinator.ts";
import type { SettlementMonitor } from "@/execution/settlement.ts";
import type { StreamCoordinator } from "@/execution/stream-coordinator.ts";
import type { MessagePayload, ParticipantRecord } from "@/types/resources.ts";
import type { OutputHub } from "./output-hub.ts";
import {
  type Attachment,
  type AttachmentOutput,
  type ConnectOptions,
  type DiscreteEventInput,
  isAttachmentStreamOutput,
  isDiscreteEventInput,
  isStreamInput,
  type RunHandle,
  type RunOptions,
  type StreamInput,
  type StreamSendHandle,
} from "./types.ts";

export interface AttachmentManagerOptions {
  domain: DomainStore;
  events: EventStore;
  registry: PluginRegistry;
  deliveries: DeliveryCoordinator;
  streams: StreamCoordinator;
  settlement: SettlementMonitor;
  outputs: OutputHub;
  schema: string;
  defaultNamespace?: string;
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

function participantKeys(participant: ParticipantRecord): Set<string> {
  return new Set([
    participant.id,
    participant.externalId,
    ...(participant.agentId ? [participant.agentId] : []),
  ]);
}

function projectEvent(
  event: CopilotzEvent,
  participant: ParticipantRecord,
): CopilotzEvent | null {
  const keys = participantKeys(participant);
  const visibility = event.visibility;
  if (visibility.kind === "internal") return null;
  if (
    visibility.kind === "participants" &&
    !visibility.participantIds.some((id) => keys.has(id))
  ) return null;
  if (visibility.kind !== "tool" || visibility.policy === "public") {
    return event;
  }
  if (keys.has(visibility.requesterId)) return event;
  if (visibility.policy === "requester_only") return null;
  return {
    ...event,
    payload: {
      subject: event.durable ? event.subject : undefined,
      status: "completed",
      redacted: true,
    },
  } as CopilotzEvent;
}

function participantType(
  sender: MessagePayload["sender"],
): ParticipantRecord["participantType"] {
  return sender?.type === "agent"
    ? "agent"
    : sender?.type === "job" || sender?.type === "tool"
    ? "job"
    : "human";
}

export class AttachmentManager {
  readonly #options: AttachmentManagerOptions;

  constructor(options: AttachmentManagerOptions) {
    this.#options = options;
  }

  async connect(options: ConnectOptions): Promise<Attachment> {
    if (options.schema && options.schema !== this.#options.schema) {
      throw new Error(
        `This engine is bound to schema '${this.#options.schema}', not '${options.schema}'.`,
      );
    }
    const namespace = options.namespace ?? this.#options.defaultNamespace ??
      "default";
    const correlationId = ulid();
    const thread = await this.#options.domain.ensureThread(
      namespace,
      options.thread,
      { correlationId, deduplicationId: `connect:${correlationId}:thread` },
    );
    const participantInput = typeof options.participant === "string"
      ? options.participant
      : {
        ...options.participant,
        participantType: options.participant.participantType ??
          "human" as const,
      };
    const participant = await this.#options.domain.ensureParticipant(
      namespace,
      participantInput,
      {
        correlationId,
        deduplicationId: `connect:${correlationId}:participant`,
      },
    );
    await this.#options.domain.addParticipant(
      namespace,
      thread.id,
      participant.id,
      { correlationId, deduplicationId: `connect:${correlationId}:membership` },
    );

    const subscription = this.#options.outputs.subscribe((output) => {
      if (isAttachmentStreamOutput(output)) {
        return output.namespace === namespace && output.threadId === thread.id;
      }
      return output.namespace === namespace && output.threadId === thread.id;
    });
    const projected = new TransformStream<AttachmentOutput, AttachmentOutput>({
      transform(output, controller) {
        if (isAttachmentStreamOutput(output)) {
          controller.enqueue(output);
          return;
        }
        const event = projectEvent(output, participant);
        if (event) controller.enqueue(event);
      },
    });
    const outputs = subscription.stream.pipeThrough(projected);
    const activeStreams = new Set<StreamSendHandle>();
    let closed = false;

    const send = async (
      input: MessagePayload | DiscreteEventInput | StreamInput,
    ): Promise<EventSendHandle | StreamSendHandle> => {
      if (closed) throw new Error("Attachment is closed.");
      if (isStreamInput(input)) {
        const streamId = ulid();
        const correlationId = input.correlationId ?? streamId;
        const target = input.target
          ? await this.#resolveParticipant(
            namespace,
            input.target,
            correlationId,
          )
          : null;
        if (target) {
          await this.#options.domain.addParticipant(
            namespace,
            thread.id,
            target.id,
            {
              correlationId,
              deduplicationId: `stream:${correlationId}:target-membership`,
            },
          );
        }
        const raw = await this.#options.streams.open({
          streamId,
          type: input.type,
          mediaType: input.mediaType,
          payload: input.payload,
          namespace,
          thread,
          participant,
          targetId: target?.agentId ?? target?.externalId ?? target?.id,
          provider: input.provider,
          metadata: input.metadata,
          correlationId,
        });
        const done = raw.done.then(() =>
          this.#options.settlement.wait(namespace, correlationId)
        );
        const handle: StreamSendHandle = {
          streamId,
          correlationId,
          done,
          cancel: async (reason?: string) => {
            await raw.cancel(reason);
            await this.#options.events.cancelCorrelation(
              namespace,
              correlationId,
              reason,
            );
            await this.#options.deliveries.cancelCorrelation(
              namespace,
              correlationId,
              reason,
            );
          },
        };
        activeStreams.add(handle);
        void done.finally(() => activeStreams.delete(handle)).catch(() =>
          undefined
        );
        return handle;
      }
      if (isDiscreteEventInput(input) && !("content" in input)) {
        return await this.#sendDiscrete(
          namespace,
          thread.id,
          participant,
          input,
        );
      }
      const message = input as MessagePayload;
      const correlationId = typeof message.metadata?.correlationId === "string"
        ? message.metadata.correlationId
        : ulid();
      const sender = await this.#resolveSender(
        namespace,
        participant,
        message,
        correlationId,
      );
      await this.#options.domain.addParticipant(
        namespace,
        thread.id,
        sender.id,
        {
          correlationId,
          deduplicationId: `message:${correlationId}:sender-membership`,
        },
      );
      const target = message.target
        ? await this.#resolveParticipant(
          namespace,
          message.target,
          correlationId,
        )
        : null;
      if (target) {
        await this.#options.domain.addParticipant(
          namespace,
          thread.id,
          target.id,
          {
            correlationId,
            deduplicationId: `message:${correlationId}:target-membership`,
          },
        );
      }
      const result = await this.#options.domain.createMessage({
        namespace,
        thread,
        participant: sender,
        input: message,
        target,
        correlationId,
        context: {
          correlationId,
          deduplicationId: message.externalId
            ? `message:${message.externalId}`
            : undefined,
        },
      });
      return this.#eventHandle(namespace, thread.id, result.event);
    };

    return {
      thread,
      participant,
      namespace,
      outputs,
      send: send as Attachment["send"],
      async close() {
        if (closed) return;
        closed = true;
        subscription.close();
        await Promise.all(
          [...activeStreams].map((handle) =>
            handle.cancel("attachment_closed")
          ),
        );
      },
    };
  }

  async run(
    message: MessagePayload,
    options: RunOptions = {},
  ): Promise<RunHandle> {
    const participant = options.participant ?? {
      externalId: message.sender?.externalId ?? message.sender?.id ?? "user",
      participantType: participantType(message.sender),
      name: message.sender?.name ?? "User",
      agentId: message.sender?.type === "agent" ? message.sender.id : undefined,
    };
    const attachment = await this.connect({
      thread: options.thread ?? {
        externalId: `run:${ulid()}`,
        name: "Copilotz run",
        metadata: options.metadata,
      },
      participant,
      namespace: options.namespace,
      schema: options.schema,
    });
    const input: MessagePayload = {
      ...message,
      metadata: {
        ...(message.metadata ?? {}),
        ...(options.metadata ?? {}),
        ...(options.correlationId
          ? { correlationId: options.correlationId }
          : {}),
      },
    };
    const sent = await attachment.send(input) as EventSendHandle;
    let controller!: ReadableStreamDefaultController<CopilotzEvent>;
    const events = new ReadableStream<CopilotzEvent>({
      start(value) {
        controller = value;
      },
      cancel: (reason) => sent.cancel(String(reason ?? "stream_cancelled")),
    });
    const pump = (async () => {
      try {
        for await (const output of attachment.outputs) {
          if (
            !isAttachmentStreamOutput(output) &&
            output.correlationId === sent.correlationId
          ) controller.enqueue(output);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    })();
    const done = sent.done.finally(async () => {
      await attachment.close();
      await pump;
    });
    return {
      eventId: sent.eventId,
      threadId: sent.threadId,
      correlationId: sent.correlationId,
      events,
      done,
      cancel: sent.cancel,
    };
  }

  async #sendDiscrete(
    namespace: string,
    threadId: string,
    participant: ParticipantRecord,
    input: DiscreteEventInput,
  ): Promise<EventSendHandle> {
    const correlationId = input.correlationId ?? ulid();
    const sender = await this.#resolveSender(
      namespace,
      participant,
      { sender: input.sender },
      correlationId,
    );
    await this.#options.domain.addParticipant(
      namespace,
      threadId,
      sender.id,
      {
        correlationId,
        deduplicationId: `event:${correlationId}:sender-membership`,
      },
    );
    const target = input.target
      ? await this.#resolveParticipant(namespace, input.target, correlationId)
      : null;
    if (target) {
      await this.#options.domain.addParticipant(
        namespace,
        threadId,
        target.id,
        {
          correlationId,
          deduplicationId: `event:${correlationId}:target-membership`,
        },
      );
    }
    const draft: DurableEventDraft = {
      type: input.type,
      namespace,
      threadId,
      payload: input.payload ?? {},
      routing: {
        senderId: sender.id,
        ...(target ? { recipientIds: [target.id] } : {}),
      },
      visibility: { kind: "public" },
      metadata: input.metadata ?? {},
      correlationId,
      deduplicationId: input.deduplicationId,
    };
    const result = await this.#options.events.append(
      draft,
      this.#options.registry.matchDurable(matchable(draft)).map((processor) =>
        processor.id
      ),
    );
    if (!result.deduplicated) await this.#options.committed(result);
    return this.#eventHandle(namespace, threadId, result.event);
  }

  #eventHandle(
    namespace: string,
    threadId: string,
    event: DurableEvent,
  ): EventSendHandle {
    return {
      eventId: event.id,
      threadId,
      correlationId: event.correlationId,
      done: this.#options.settlement.wait(namespace, event.correlationId),
      cancel: async (reason?: string) => {
        await this.#options.events.cancelCorrelation(
          namespace,
          event.correlationId,
          reason,
        );
        await this.#options.deliveries.cancelCorrelation(
          namespace,
          event.correlationId,
          reason,
        );
      },
    };
  }

  async #resolveSender(
    namespace: string,
    fallback: ParticipantRecord,
    message: MessagePayload,
    correlationId: string,
  ): Promise<ParticipantRecord> {
    const sender = message.sender;
    const externalId = sender?.externalId ?? sender?.id;
    if (!externalId || participantKeys(fallback).has(externalId)) {
      return fallback;
    }
    return await this.#options.domain.ensureParticipant(
      namespace,
      {
        externalId,
        participantType: participantType(sender),
        name: sender?.name ?? externalId,
        agentId: sender?.type === "agent" ? sender.id : undefined,
        metadata: sender?.metadata,
      },
      {
        correlationId,
        deduplicationId: `participant:${externalId}`,
      },
    );
  }

  async #resolveParticipant(
    namespace: string,
    id: string,
    correlationId: string,
  ): Promise<ParticipantRecord> {
    const existing = await this.#options.domain.findParticipant(namespace, id);
    if (existing) return existing;
    const agent = this.#options.registry.list("agents").find((candidate) =>
      candidate.id === id || candidate.name === id
    );
    return await this.#options.domain.ensureParticipant(
      namespace,
      agent
        ? {
          externalId: agent.id,
          participantType: "agent",
          name: agent.name,
          agentId: agent.id,
        }
        : { externalId: id, participantType: "human", name: id },
      { correlationId },
    );
  }
}
