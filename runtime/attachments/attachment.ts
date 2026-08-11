import type { ContentPreparer } from "../content/index.ts";
import type {
  ConversationRepository,
  ConversationThread,
  Participant,
  ParticipantInput,
} from "../domain/index.ts";
import {
  createEphemeralEvent,
  type EventCoordinator,
  type EventStore,
} from "../events/index.ts";
import type {
  CopilotzEvent,
  CopilotzEventHub,
  EventVisibility,
} from "../events/index.ts";
import type {
  DeliveryExecutor,
  ExecutionWorkInput,
} from "../execution/index.ts";
import type { PluginRegistry } from "../plugins/index.ts";
import {
  type AttachmentEventHandle,
  type AttachmentEventInput,
  type AttachmentMessageHandle,
  type AttachmentMessageInput,
  type AttachmentOutput,
  type AttachmentOutputParticipant,
  type AttachmentSendInput,
  type AttachmentSendResult,
  type AttachmentStreamHandle,
  type AttachmentStreamInput,
  type AttachmentStreamOutput,
  type ConnectAttachmentInput,
  COPILOTZ_STREAM_WORKLOAD,
  type RealtimeProviderResource,
  type RunHandle,
  type RunInput,
  type StreamDispatchMetadata,
  type ThreadAttachment,
} from "./types.ts";
import { isRealtimeProviderResource } from "./workload.ts";
import type { Agent } from "../resources/index.ts";

export type CreateAttachmentRuntimeOptions = Readonly<{
  schema: string;
  coordinator: EventCoordinator;
  store: EventStore;
  conversation: ConversationRepository;
  preparer: ContentPreparer;
  eventHub: CopilotzEventHub;
  dispatchEvent?: (event: CopilotzEvent) => Promise<
    Readonly<{
      done: Promise<void>;
      cancel(reason?: string): Promise<void>;
    }>
  >;
  executor: DeliveryExecutor;
  registry: PluginRegistry;
  workload?: string;
  createId?: () => string;
  now?: () => Date;
  settlementPollMs?: number;
}>;

export type AttachmentRuntime = Readonly<{
  connect(input: ConnectAttachmentInput): Promise<ThreadAttachment>;
  run(input: RunInput): Promise<RunHandle>;
  shutdown(reason?: string): Promise<void>;
}>;

type ActiveOperation = Readonly<{
  cancel(reason?: string): Promise<void>;
}>;

type AttachmentErrorCode =
  | "attachment_invalid"
  | "attachment_cancelled"
  | "attachment_dead_letter"
  | "stream_failed";

function attachmentError(
  code: AttachmentErrorCode,
  message: string,
  cause?: unknown,
): Error & { code: AttachmentErrorCode } {
  return Object.assign(
    new Error(message, cause === undefined ? {} : { cause }),
    {
      name: "CopilotzAttachmentError",
      code,
    },
  );
}

function errorText(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw attachmentError("attachment_invalid", `${name} must be non-empty.`);
  }
  return value.trim();
}

function positivePoll(value: number | undefined): number {
  const resolved = value ?? 10;
  if (!Number.isSafeInteger(resolved) || resolved < 1) {
    throw new TypeError("Attachment settlementPollMs must be positive.");
  }
  return resolved;
}

function isByteStream(value: unknown): value is ReadableStream<Uint8Array> {
  return Boolean(
    value && typeof value === "object" &&
      typeof (value as { getReader?: unknown }).getReader === "function",
  );
}

function isStreamOutput(
  value: AttachmentOutput,
): value is AttachmentStreamOutput {
  return value.type === "stream.output" && "payload" in value &&
    isByteStream(value.payload);
}

function jsonDispatchMetadata(
  value: StreamDispatchMetadata,
): NonNullable<ExecutionWorkInput["metadata"]> {
  try {
    const encoded = JSON.stringify(value);
    const parsed = JSON.parse(encoded) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError("Stream dispatch metadata must be a JSON object.");
    }
    return parsed as NonNullable<ExecutionWorkInput["metadata"]>;
  } catch (cause) {
    throw attachmentError(
      "attachment_invalid",
      "Stream metadata must be JSON-compatible.",
      cause,
    );
  }
}

function isMessageInput(
  input: AttachmentSendInput,
): input is AttachmentMessageInput {
  return "content" in input;
}

function isStreamInput(
  input: AttachmentSendInput,
): input is AttachmentStreamInput {
  return "payload" in input && isByteStream(input.payload);
}

function participantInput(participant: Participant): ParticipantInput {
  return {
    id: participant.id,
    externalId: participant.externalId,
    participantType: participant.participantType,
    ...(participant.name ? { name: participant.name } : {}),
    ...(participant.email ? { email: participant.email } : {}),
    ...(participant.agentId ? { agentId: participant.agentId } : {}),
    metadata: structuredClone(participant.metadata),
  };
}

function participantOutput(
  participant: Participant,
): AttachmentOutputParticipant {
  return Object.freeze({
    id: participant.id,
    externalId: participant.externalId,
    type: participant.participantType === "human"
      ? "user"
      : participant.participantType,
    ...(participant.name ? { name: participant.name } : {}),
  });
}

function visibleTo(event: CopilotzEvent, participantId: string): boolean {
  const visibility = event.visibility;
  if (visibility.kind === "public") return true;
  if (visibility.kind === "internal") return false;
  if (visibility.kind === "participants") {
    return visibility.participantIds.includes(participantId);
  }
  return visibility.policy !== "requester_only" ||
    visibility.requesterId === participantId;
}

function participantMatches(
  participant: Participant,
  value: string,
): boolean {
  const normalized = value.trim().toLowerCase();
  return participant.id.toLowerCase() === normalized ||
    participant.externalId.toLowerCase() === normalized ||
    participant.agentId?.toLowerCase() === normalized;
}

function resolveParticipant(
  thread: ConversationThread,
  value: string | Participant,
  name: string,
): Participant {
  const id = typeof value === "string" ? requiredText(value, name) : value.id;
  const matches = thread.participants.filter((participant) =>
    participantMatches(participant, id)
  );
  if (matches.length === 0) {
    throw attachmentError(
      "attachment_invalid",
      `${name} '${id}' is not a participant in thread '${thread.id}'.`,
    );
  }
  if (matches.length > 1) {
    throw attachmentError(
      "attachment_invalid",
      `${name} '${id}' is ambiguous; use its participant ID.`,
    );
  }
  if (typeof value !== "string" && value.namespace !== thread.namespace) {
    throw attachmentError(
      "attachment_invalid",
      `${name} belongs to another namespace.`,
    );
  }
  return matches[0];
}

function resolveRecipientIds(
  thread: ConversationThread,
  values: readonly string[] | undefined,
): readonly string[] {
  const result = new Set<string>();
  for (const value of values ?? []) {
    result.add(resolveParticipant(thread, value, "Recipient").id);
  }
  return Object.freeze([...result]);
}

function assertSender(
  sender: AttachmentMessageInput["sender"],
  bound: Participant,
): void {
  if (sender === undefined) return;
  if (typeof sender === "string") {
    if (!participantMatches(bound, sender)) {
      throw attachmentError(
        "attachment_invalid",
        "A thread attachment cannot send as another participant.",
      );
    }
    return;
  }
  if (
    (sender.id && sender.id !== bound.id) ||
    sender.externalId !== bound.externalId ||
    sender.participantType !== bound.participantType
  ) {
    throw attachmentError(
      "attachment_invalid",
      "A thread attachment cannot send as another participant.",
    );
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function waitForScope(
  store: EventStore,
  namespace: string,
  eventId: string,
  correlationId: string,
  executor: DeliveryExecutor,
  signal: AbortSignal,
  pollMs: number,
): Promise<void> {
  while (true) {
    if (signal.aborted) {
      throw attachmentError(
        "attachment_cancelled",
        errorText(signal.reason ?? "Attachment operation cancelled."),
      );
    }
    const settlement = await store.scopeSettlement(namespace, eventId);
    if (settlement.deadLetters > 0) {
      throw attachmentError(
        "attachment_dead_letter",
        `Causal event scope '${eventId}' contains dead-lettered work.`,
      );
    }
    if (settlement.cancelled > 0) {
      throw attachmentError(
        "attachment_cancelled",
        `Causal event scope '${eventId}' was cancelled.`,
      );
    }
    if (settlement.unsettled === 0) {
      // A remote Worker settles its database delivery just before the final
      // output frame reaches this Gateway. Await correlated relays, then
      // confirm the durable scope once more in case a frame created more work.
      await executor.settleOutputs({ namespace, correlationId });
      const confirmed = await store.scopeSettlement(namespace, eventId);
      if (confirmed.deadLetters > 0) {
        throw attachmentError(
          "attachment_dead_letter",
          `Causal event scope '${eventId}' contains dead-lettered work.`,
        );
      }
      if (confirmed.cancelled > 0) {
        throw attachmentError(
          "attachment_cancelled",
          `Causal event scope '${eventId}' was cancelled.`,
        );
      }
      if (confirmed.unsettled === 0) return;
    }
    await delay(pollMs, signal);
  }
}

function streamResultMetadata(
  value: Readonly<Record<string, unknown>>,
): Readonly<{
  hasOutput: boolean;
  mediaType: string;
  metadata: Readonly<Record<string, unknown>>;
}> {
  if (value.schema !== "copilotz.stream.result.v1") {
    throw attachmentError(
      "stream_failed",
      `Unsupported stream result schema '${String(value.schema)}'.`,
    );
  }
  const mediaType = requiredText(value.mediaType, "Output media type");
  const { schema: _schema, streamId: _streamId, hasOutput, ...metadata } =
    value;
  return Object.freeze({
    hasOutput: hasOutput === true,
    mediaType,
    metadata: Object.freeze(structuredClone(metadata)),
  });
}

/** Creates persistent thread attachments and temporary text run handles. */
export function createAttachmentRuntime(
  options: CreateAttachmentRuntimeOptions,
): AttachmentRuntime {
  const workload = requiredText(
    options.workload ?? COPILOTZ_STREAM_WORKLOAD,
    "Stream workload",
  );
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const pollMs = positivePoll(options.settlementPollMs);
  const openAttachments = new Set<ThreadAttachment>();

  const resolveThread = async (
    namespace: string,
    value: string | ConversationThread,
  ): Promise<ConversationThread> => {
    if (typeof value !== "string" && value.namespace !== namespace) {
      throw attachmentError(
        "attachment_invalid",
        "Thread belongs to another namespace.",
      );
    }
    const id = typeof value === "string"
      ? requiredText(value, "Thread")
      : value.id;
    const byId = await options.conversation.getThread(namespace, id);
    const thread = byId ??
      (typeof value === "string"
        ? await options.conversation.getThreadByExternalId(namespace, id)
        : null);
    if (!thread) {
      throw attachmentError(
        "attachment_invalid",
        `Thread '${id}' was not found in namespace '${namespace}'.`,
      );
    }
    return thread;
  };

  const connect = async (
    input: ConnectAttachmentInput,
  ): Promise<ThreadAttachment> => {
    const namespace = requiredText(input.namespace, "Namespace");
    if (input.schema !== undefined && input.schema.trim() !== options.schema) {
      throw attachmentError(
        "attachment_invalid",
        `Attachment schema '${input.schema}' does not match engine schema '${options.schema}'.`,
      );
    }
    const thread = await resolveThread(namespace, input.thread);
    const participant = resolveParticipant(
      thread,
      input.participant,
      "Attachment participant",
    );
    const defaultRecipientIds = resolveRecipientIds(thread, input.recipientIds);
    const id = `attachment:${createId()}`;
    const active = new Set<ActiveOperation>();
    let closed = false;
    let outputsClosed = false;
    let outputController:
      | ReadableStreamDefaultController<AttachmentOutput>
      | undefined;
    const semantic = options.eventHub.subscribe({
      namespace,
      threadId: thread.id,
    });
    const semanticReader = semantic.getReader();

    const closeOutputs = (): void => {
      if (outputsClosed) return;
      outputsClosed = true;
      try {
        outputController?.close();
      } catch {
        // A consumer may already have cancelled the stream.
      }
    };
    const emitOutput = (output: AttachmentOutput): void => {
      if (closed || outputsClosed) return;
      try {
        outputController?.enqueue(output);
      } catch {
        // Closing an attachment wins races with late stream metadata.
      }
    };

    const close = async (reason = "attachment_closed"): Promise<void> => {
      if (closed) return;
      closed = true;
      await semanticReader.cancel(reason).catch(() => undefined);
      await Promise.all(
        [...active].map((operation) =>
          operation.cancel(reason).catch(() => undefined)
        ),
      );
      active.clear();
      closeOutputs();
      openAttachments.delete(attachment);
    };

    const outputs = new ReadableStream<AttachmentOutput>({
      start(controller) {
        outputController = controller;
        void (async () => {
          try {
            while (!closed) {
              const next = await semanticReader.read();
              if (next.done) break;
              if (visibleTo(next.value, participant.id)) emitOutput(next.value);
            }
            closeOutputs();
          } catch (error) {
            if (!closed && !outputsClosed) {
              outputsClosed = true;
              controller.error(error);
            }
          }
        })();
      },
      cancel(reason) {
        return close(errorText(reason ?? "attachment_output_cancelled"));
      },
    }, { highWaterMark: 256 });

    const track = <
      T extends { done: Promise<void>; cancel(reason?: string): Promise<void> },
    >(
      handle: T,
    ): T => {
      const operation: ActiveOperation = Object.freeze({
        cancel: handle.cancel,
      });
      active.add(operation);
      void handle.done.then(
        () => active.delete(operation),
        () => active.delete(operation),
      );
      handle.done.catch(() => undefined);
      return handle;
    };

    const scopeHandle = (
      event: CopilotzEvent,
      operations: readonly ActiveOperation[] = [],
    ): AttachmentEventHandle => {
      const correlationId = event.correlationId;
      if (!event.durable) {
        return Object.freeze({
          event,
          correlationId,
          done: Promise.resolve(),
          cancel: () => Promise.resolve(),
        });
      }
      const abort = new AbortController();
      let settled = false;
      const done = waitForScope(
        options.store,
        namespace,
        event.id,
        event.correlationId,
        options.executor,
        abort.signal,
        pollMs,
      ).finally(() => {
        settled = true;
      });
      const handle: AttachmentEventHandle = Object.freeze({
        event,
        eventId: event.id,
        correlationId,
        done,
        async cancel(reason = "attachment_operation_cancelled") {
          if (settled || abort.signal.aborted) return;
          await options.store.cancelScope(namespace, event.id, reason);
          await Promise.all(
            operations.map((operation) =>
              operation.cancel(reason).catch(() => undefined)
            ),
          );
          abort.abort(attachmentError("attachment_cancelled", reason));
          await done.catch(() => undefined);
        },
      });
      return track(handle);
    };

    const sendMessage = async (
      message: AttachmentMessageInput,
    ): Promise<AttachmentMessageHandle> => {
      if (closed) {
        throw attachmentError("attachment_invalid", "Attachment is closed.");
      }
      assertSender(message.sender, participant);
      const correlationId = message.correlationId?.trim() || createId();
      const deduplicationId = message.deduplicationId?.trim() ||
        `${id}:message:${correlationId}`;
      const content = await options.preparer.prepare(message.content, {
        namespace,
        idempotencyKey: `${deduplicationId}:content`,
      });
      const metadata = structuredClone(message.metadata ?? {});
      const result = await options.conversation.createMessage({
        namespace,
        ...(message.id ? { id: requiredText(message.id, "Message ID") } : {}),
        threadId: thread.id,
        sender: participantInput(participant),
        recipientIds: resolveRecipientIds(
          thread,
          message.recipientIds ?? defaultRecipientIds,
        ),
        content,
        visibility: message.visibility ?? { kind: "public" },
        metadata,
        identity: {
          correlationId,
          deduplicationId,
          metadata,
        },
      });
      const messageId = result.value?.id;
      if (!messageId) throw new Error("Message mutation returned no record.");
      const base = scopeHandle(result.event, result.dispatch.handles);
      return Object.freeze({ ...base, messageId }) as AttachmentMessageHandle;
    };

    const sendEvent = async (
      inputEvent: AttachmentEventInput,
    ): Promise<AttachmentEventHandle> => {
      if (closed) {
        throw attachmentError("attachment_invalid", "Attachment is closed.");
      }
      const type = requiredText(inputEvent.type, "Event type");
      const correlationId = inputEvent.correlationId?.trim() || createId();
      const routing = {
        senderId: participant.id,
        recipientIds: resolveRecipientIds(
          thread,
          inputEvent.recipientIds ?? defaultRecipientIds,
        ),
      };
      const metadata = structuredClone(inputEvent.metadata ?? {});
      if (inputEvent.durable === false) {
        const event = createEphemeralEvent({
          type,
          namespace,
          threadId: thread.id,
          payload: inputEvent.payload,
          routing,
          visibility: inputEvent.visibility ?? { kind: "public" },
          metadata,
          causationId: inputEvent.causationId,
          correlationId,
        }, now);
        if (!options.dispatchEvent) {
          await options.eventHub.publish(event);
          return scopeHandle(event);
        }
        const dispatched = await options.dispatchEvent(event);
        const handle: AttachmentEventHandle = Object.freeze({
          event,
          correlationId,
          done: dispatched.done,
          cancel: dispatched.cancel,
        });
        return track(handle);
      }
      const result = await options.coordinator.append({
        type,
        namespace,
        threadId: thread.id,
        subject: inputEvent.subject,
        payload: inputEvent.payload,
        routing,
        visibility: inputEvent.visibility ?? { kind: "public" },
        metadata,
        causationId: inputEvent.causationId,
        correlationId,
        deduplicationId: inputEvent.deduplicationId?.trim() ||
          `${id}:event:${correlationId}:${type}`,
      });
      return scopeHandle(result.event, result.dispatch.handles);
    };

    const appendStreamTerminal = async (
      streamId: string,
      rootEventId: string,
      correlationId: string,
      inputType: string,
      mediaType: string,
      recipient: Participant,
      visibility: EventVisibility,
      metadata: Readonly<Record<string, unknown>>,
      terminal: "closed" | "cancelled" | "failed",
      detail?: string,
    ) => {
      return await options.coordinator.append({
        type: `stream.${terminal}`,
        namespace,
        threadId: thread.id,
        subject: { type: "stream", id: streamId },
        payload: {
          streamId,
          inputType,
          mediaType,
          participantId: participant.id,
          recipientId: recipient.id,
          ...(detail ? { detail } : {}),
        },
        routing: {
          senderId: participant.id,
          recipientIds: [recipient.id],
        },
        visibility,
        metadata: structuredClone(metadata),
        causationId: rootEventId,
        correlationId,
        deduplicationId: `${id}:stream:${streamId}:${terminal}`,
      });
    };

    const sendStream = async (
      stream: AttachmentStreamInput,
    ): Promise<AttachmentStreamHandle> => {
      if (closed) {
        throw attachmentError("attachment_invalid", "Attachment is closed.");
      }
      const inputType = requiredText(stream.type, "Stream input type");
      const mediaType = requiredText(stream.mediaType, "Stream media type");
      if (!isByteStream(stream.payload)) {
        throw attachmentError(
          "attachment_invalid",
          "Stream payload must be a Web ReadableStream.",
        );
      }
      const candidateRecipients = stream.recipientId
        ? [stream.recipientId]
        : defaultRecipientIds;
      if (candidateRecipients.length !== 1) {
        throw attachmentError(
          "attachment_invalid",
          "A stream input requires exactly one recipient agent.",
        );
      }
      const recipient = resolveParticipant(
        thread,
        candidateRecipients[0],
        "Stream recipient",
      );
      if (recipient.participantType !== "agent") {
        throw attachmentError(
          "attachment_invalid",
          "A stream recipient must be an agent participant.",
        );
      }
      const agentId = requiredText(
        recipient.agentId ?? recipient.externalId,
        "Realtime agent ID",
      );
      const agent = options.registry.get<Agent>("agents", agentId);
      if (!agent) throw new Error(`Agent '${agentId}' is not registered.`);
      const runtime = agent.runtimes?.realtime;
      if (!runtime || runtime.type !== "realtime") {
        throw attachmentError(
          "attachment_invalid",
          `Agent '${agent.id}' has no realtime runtime.`,
        );
      }
      const provider = options.registry.get<RealtimeProviderResource>(
        "providers",
        runtime.provider,
      );
      if (!provider || !isRealtimeProviderResource(provider)) {
        throw attachmentError(
          "attachment_invalid",
          `Realtime provider '${runtime.provider}' is not registered.`,
        );
      }

      const streamId = `stream:${createId()}`;
      const correlationId = stream.correlationId?.trim() || createId();
      const visibility = stream.visibility ?? { kind: "public" };
      const metadata = Object.freeze({
        ...structuredClone(stream.metadata ?? {}),
        ...(stream.outputMediaType
          ? {
            outputMediaType: requiredText(
              stream.outputMediaType,
              "Output media type",
            ),
          }
          : {}),
      });
      const opened = await options.coordinator.append({
        type: "stream.opened",
        namespace,
        threadId: thread.id,
        subject: { type: "stream", id: streamId },
        payload: {
          streamId,
          inputType,
          mediaType,
          participantId: participant.id,
          recipientId: recipient.id,
          agentId,
          providerId: provider.id,
        },
        routing: {
          senderId: participant.id,
          recipientIds: [recipient.id],
        },
        visibility,
        metadata: structuredClone(metadata),
        correlationId,
        deduplicationId: `${id}:stream:${streamId}:opened`,
      });
      const dispatchMetadata: StreamDispatchMetadata = Object.freeze({
        schema: "copilotz.stream.dispatch.v1",
        streamId,
        eventId: opened.event.id,
        namespace,
        threadId: thread.id,
        correlationId,
        inputType,
        mediaType,
        participantId: participant.id,
        recipientId: recipient.id,
        agentId,
        providerId: provider.id,
        metadata,
      });

      let work: Awaited<ReturnType<DeliveryExecutor["dispatchWork"]>>;
      try {
        work = await options.executor.dispatchWork({
          workload,
          metadata: jsonDispatchMetadata(dispatchMetadata),
          body: stream.payload,
        });
      } catch (error) {
        await stream.payload.cancel(error).catch(() => undefined);
        await appendStreamTerminal(
          streamId,
          opened.event.id,
          correlationId,
          inputType,
          mediaType,
          recipient,
          visibility,
          metadata,
          "failed",
          errorText(error),
        );
        throw error;
      }

      let cancellationReason: string | undefined;
      let settled = false;
      const responseMetadata = work.metadata.then((value) => {
        const response = streamResultMetadata(value);
        if (response.hasOutput) {
          const output: AttachmentStreamOutput = Object.freeze({
            type: "stream.output",
            streamId,
            participant: participantOutput(recipient),
            mediaType: response.mediaType,
            causationId: opened.event.id,
            correlationId,
            metadata: response.metadata,
            payload: work.output,
          });
          emitOutput(output);
        } else {
          void work.output.pipeTo(new WritableStream<Uint8Array>()).catch(
            () => undefined,
          );
        }
        return response;
      });
      responseMetadata.catch(() => undefined);

      const done = (async () => {
        const terminal = await work.completed;
        const response = await responseMetadata.catch((error) => ({
          hasOutput: false,
          mediaType,
          metadata: Object.freeze({ responseError: errorText(error) }),
        }));
        const failed = terminal.status !== "completed";
        const terminalType = cancellationReason
          ? "cancelled" as const
          : failed
          ? "failed" as const
          : "closed" as const;
        const detail = cancellationReason ?? terminal.terminal?.message ??
          (failed ? `Oxian stream ended as '${terminal.status}'.` : undefined);
        await appendStreamTerminal(
          streamId,
          opened.event.id,
          correlationId,
          inputType,
          response.mediaType,
          recipient,
          visibility,
          metadata,
          terminalType,
          detail,
        );
        await waitForScope(
          options.store,
          namespace,
          opened.event.id,
          correlationId,
          options.executor,
          new AbortController().signal,
          pollMs,
        );
        settled = true;
        if (terminalType === "cancelled") {
          throw attachmentError(
            "attachment_cancelled",
            detail ?? "Stream cancelled.",
          );
        }
        if (terminalType === "failed") {
          throw attachmentError(
            "stream_failed",
            detail ?? "Realtime stream failed.",
          );
        }
      })();
      const handle: AttachmentStreamHandle = Object.freeze({
        streamId,
        eventId: opened.event.id,
        correlationId,
        done,
        async cancel(reason = "stream_cancelled") {
          if (settled || cancellationReason) return;
          cancellationReason = reason;
          await options.store.cancelScope(namespace, opened.event.id, reason);
          await Promise.all(
            opened.dispatch.handles.map((operation) =>
              operation.cancel(reason).catch(() => undefined)
            ),
          );
          await work.cancel(reason).catch(() => undefined);
          await done.catch(() => undefined);
        },
      });
      track(handle);
      try {
        await work.started;
      } catch (error) {
        await done.catch(() => undefined);
        throw error;
      }
      return handle;
    };

    const send = async (
      value: AttachmentSendInput,
    ): Promise<AttachmentSendResult> => {
      if (isMessageInput(value)) return await sendMessage(value);
      if (isStreamInput(value)) return await sendStream(value);
      return await sendEvent(value);
    };

    const attachment: ThreadAttachment = Object.freeze({
      id,
      namespace,
      thread,
      participant,
      outputs,
      send: send as ThreadAttachment["send"],
      close,
    });
    openAttachments.add(attachment);
    return attachment;
  };

  const run = async (
    input: RunInput,
  ): Promise<RunHandle> => {
    const attachment = await connect({
      namespace: input.namespace,
      thread: input.thread,
      participant: input.participant,
      recipientIds: input.recipientIds,
      schema: input.schema,
    });
    let sent: AttachmentMessageHandle;
    try {
      sent = await attachment.send({
        content: input.content,
        sender: input.sender,
        recipientIds: input.recipientIds,
        id: input.messageId,
        correlationId: input.correlationId,
        deduplicationId: input.deduplicationId,
        metadata: input.metadata,
        visibility: input.visibility,
      });
    } catch (error) {
      await attachment.close("run_send_failed");
      throw error;
    }
    const source = attachment.outputs.getReader();
    const events = new ReadableStream<CopilotzEvent>({
      async pull(controller) {
        while (true) {
          const next = await source.read();
          if (next.done) {
            controller.close();
            return;
          }
          if (!isStreamOutput(next.value)) {
            controller.enqueue(next.value);
            return;
          }
          await next.value.payload.cancel(
            "Unexpected stream output in text run",
          );
        }
      },
      async cancel(reason) {
        await source.cancel(reason).catch(() => undefined);
        await attachment.close(errorText(reason ?? "run_events_cancelled"));
      },
    });
    const done = (async () => {
      try {
        await sent.done;
      } finally {
        await attachment.close("run_settled");
      }
    })();
    done.catch(() => undefined);
    return Object.freeze({
      eventId: sent.eventId,
      threadId: attachment.thread.id,
      correlationId: sent.correlationId,
      events,
      done,
      async cancel(reason = "run_cancelled") {
        await sent.cancel(reason);
        await attachment.close(reason);
      },
    });
  };

  return Object.freeze({
    connect,
    run,
    async shutdown(reason = "attachment_runtime_shutdown") {
      await Promise.all(
        [...openAttachments].map((attachment) =>
          attachment.close(reason).catch(() => undefined)
        ),
      );
    },
  });
}
