import type {
  BodyStore,
  ContentPreparer,
  DatabaseAssetRepository,
} from "../content/index.ts";
import { createContentStreamRuntime } from "../content/index.ts";
import {
  activeCollectionTransaction,
  type CollectionRuntime,
} from "../collections/kernel.ts";
import {
  type CollectionMutation,
  type CollectionRecord,
  type CollectionWrite,
  isCollectionNoop,
} from "../collections/index.ts";
import type {
  ConversationThread,
  Participant,
  ParticipantInput,
} from "../domain/index.ts";
import { workflowMutationId } from "../domain/workflow-support.ts";
import {
  createEphemeralEvent,
  type EventCoordinator,
  type EventMutationContext,
  type EventStore,
  type SqlExecutor,
} from "../events/index.ts";
import type {
  CopilotzEvent,
  CopilotzEventHub,
  DurableEvent,
} from "../events/index.ts";
import type { DeliveryExecutor } from "../execution/index.ts";
import {
  createFeatureContext,
  type FeatureContextBindings,
} from "../features/index.ts";
import { requireFeatureActions } from "../features/context.ts";
import {
  defineProcessor,
  type TransientProcessorSet,
} from "../plugins/index.ts";
import type {
  AttachmentEventHandle,
  AttachmentEventInput,
  AttachmentMessageHandle,
  AttachmentMessageInput,
  AttachmentOutput,
  AttachmentOutputParticipant,
  AttachmentSendInput,
  AttachmentSendResult,
  ConnectAttachmentInput,
  RunHandle,
  RunInput,
  ThreadAttachment,
} from "./types.ts";

export type CreateAttachmentRuntimeOptions = Readonly<{
  databaseSchema: string;
  coordinator: EventCoordinator;
  store: EventStore;
  session: SqlExecutor;
  preparer: ContentPreparer;
  assets: Pick<DatabaseAssetRepository, "materialize" | "linkOwner">;
  eventHub: CopilotzEventHub;
  dispatchEvent?: (event: CopilotzEvent) => Promise<
    Readonly<{
      done: Promise<void>;
      cancel(reason?: string): Promise<void>;
    }>
  >;
  executor: DeliveryExecutor;
  collectionRuntime: CollectionRuntime;
  transients: TransientProcessorSet;
  featureBindings: Omit<FeatureContextBindings, "namespace">;
  streamBodyStore?: BodyStore;
  createId?: () => string;
  now?: () => Date;
  settlementPollMs?: number;
}>;

export type AttachmentRuntime = Readonly<{
  connect(input: ConnectAttachmentInput): Promise<ThreadAttachment>;
  run(input: RunInput): Promise<RunHandle>;
  /** Terminates active attachments with a transport-visible error. */
  terminate(error: unknown): Promise<void>;
  shutdown(reason?: string): Promise<void>;
}>;

type ActiveOperation = Readonly<{
  cancel(reason?: string): Promise<void>;
}>;

type AttachmentErrorCode =
  | "attachment_invalid"
  | "attachment_cancelled"
  | "attachment_dead_letter";

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

function isMessageInput(
  input: AttachmentSendInput,
): input is AttachmentMessageInput {
  return "content" in input;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim())
    ),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? { ...value as Record<string, unknown> }
    : {};
}

function mapParticipant(record: CollectionRecord): Participant {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    externalId: String(record.externalId ?? record.id),
    participantType: record.participantType as Participant["participantType"],
    ...(optionalText(record.name) ? { name: optionalText(record.name) } : {}),
    ...(optionalText(record.email)
      ? { email: optionalText(record.email) }
      : {}),
    ...(optionalText(record.agentId)
      ? { agentId: optionalText(record.agentId) }
      : {}),
    metadata: asRecord(record.metadata),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

function mapThread(
  record: CollectionRecord,
  participants: readonly Participant[],
): ConversationThread {
  const branch = record.activeMessageBranch &&
      typeof record.activeMessageBranch === "object"
    ? record.activeMessageBranch as ConversationThread["activeMessageBranch"]
    : undefined;
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    ...(optionalText(record.externalId)
      ? { externalId: optionalText(record.externalId) }
      : {}),
    ...(optionalText(record.name) ? { name: optionalText(record.name) } : {}),
    ...(optionalText(record.description)
      ? { description: optionalText(record.description) }
      : {}),
    status: String(record.status ?? "active"),
    ...(optionalText(record.parentThreadId)
      ? { parentThreadId: optionalText(record.parentThreadId) }
      : {}),
    metadata: asRecord(record.metadata),
    participants,
    ...(branch ? { activeMessageBranch: branch } : {}),
    ...(optionalText(record.lastEventId)
      ? { lastEventId: optionalText(record.lastEventId) }
      : {}),
    ...(optionalText(record.lastEventPosition)
      ? { lastEventPosition: optionalText(record.lastEventPosition) }
      : {}),
    ...(optionalText(record.lastEventAt)
      ? { lastEventAt: optionalText(record.lastEventAt) }
      : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

function mutationContext(
  runtime: CollectionRuntime,
  session: SqlExecutor,
  tables: EventStore["tables"],
): EventMutationContext {
  return {
    transaction: activeCollectionTransaction(runtime) ?? session,
    tables,
  };
}

function toDurableEvent(
  event: CollectionMutation<CollectionRecord>["event"],
): DurableEvent {
  return Object.freeze({
    durable: true as const,
    id: event.id,
    position: event.position,
    schemaVersion: event.schemaVersion,
    type: event.eventType,
    namespace: event.namespace,
    ...(event.threadId ? { threadId: event.threadId } : {}),
    ...(event.subject ? { subject: event.subject } : {}),
    payload: { dataRef: event.dataRef },
    routing: event.routing,
    visibility: event.visibility,
    metadata: event.metadata,
    ...(event.causationId ? { causationId: event.causationId } : {}),
    correlationId: event.correlationId,
    ...(event.deduplicationId
      ? { deduplicationId: event.deduplicationId }
      : {}),
    createdAt: event.createdAt,
  });
}

function writeForSubject(
  writes: readonly CollectionWrite<CollectionRecord>[],
  eventType: string,
  id: string,
): CollectionWrite<CollectionRecord> {
  const matched = writes.filter((write) => String(write.record.id) === id);
  for (const write of matched) {
    if (!isCollectionNoop(write) && write.event.eventType === eventType) {
      return write;
    }
  }
  const noop = matched.find((write) => isCollectionNoop(write));
  if (noop) return noop;
  throw new Error(
    `Record '${id}' was created without a ${eventType} collection write.`,
  );
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

function outputParticipant(
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

function normalizeStreamOffsets(
  value: Readonly<Record<string, number>> | undefined,
): Readonly<Record<string, number>> {
  if (!value) return Object.freeze({});
  const next: Record<string, number> = {};
  for (const [streamId, offset] of Object.entries(value)) {
    const id = streamId.trim();
    if (!id) continue;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      throw attachmentError(
        "attachment_invalid",
        `Stream offset for '${id}' must be a non-negative integer.`,
      );
    }
    next[id] = offset;
  }
  return Object.freeze(next);
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
  databaseSchema: string,
  namespace: string,
  settlementScopeId: string,
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
    const settlement = await store.scopeSettlement(
      namespace,
      settlementScopeId,
    );
    if (signal.aborted) {
      throw attachmentError(
        "attachment_cancelled",
        errorText(signal.reason ?? "Attachment operation cancelled."),
      );
    }
    if (settlement.deadLetters > 0) {
      throw attachmentError(
        "attachment_dead_letter",
        `Settlement scope '${settlementScopeId}' contains dead-lettered work.`,
      );
    }
    if (settlement.cancelled > 0) {
      throw attachmentError(
        "attachment_cancelled",
        `Settlement scope '${settlementScopeId}' was cancelled.`,
      );
    }
    if (settlement.unsettled === 0) {
      // A remote Worker settles its database delivery just before the final
      // output frame reaches this Gateway. Await relays in this settlement
      // scope, then
      // confirm the durable scope once more in case a frame created more work.
      await executor.settleOutputs({
        databaseSchema,
        namespace,
        settlementScopeId,
      });
      const confirmed = await store.scopeSettlement(
        namespace,
        settlementScopeId,
      );
      if (signal.aborted) {
        throw attachmentError(
          "attachment_cancelled",
          errorText(signal.reason ?? "Attachment operation cancelled."),
        );
      }
      if (confirmed.deadLetters > 0) {
        throw attachmentError(
          "attachment_dead_letter",
          `Settlement scope '${settlementScopeId}' contains dead-lettered work.`,
        );
      }
      if (confirmed.cancelled > 0) {
        throw attachmentError(
          "attachment_cancelled",
          `Settlement scope '${settlementScopeId}' was cancelled.`,
        );
      }
      if (confirmed.unsettled === 0) return;
    }
    await delay(pollMs, signal);
  }
}

/** Creates persistent thread attachments and temporary text run handles. */
export function createAttachmentRuntime(
  options: CreateAttachmentRuntimeOptions,
): AttachmentRuntime {
  const createId = options.createId ?? (() => crypto.randomUUID());
  const now = options.now ?? (() => new Date());
  const pollMs = positivePoll(options.settlementPollMs);
  const openAttachments = new Map<
    ThreadAttachment,
    (error: unknown) => Promise<void>
  >();

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
    const collections = options.collectionRuntime.withScope({ namespace });
    const threads = collections.thread;
    const participants = collections.participant;
    if (!threads) {
      throw attachmentError(
        "attachment_invalid",
        "Thread collection is not bound.",
      );
    }
    let record = await threads.get({ id });
    if (!record && typeof value === "string" && threads.queries.byExternalId) {
      const [byExternal] = await threads.queries.byExternalId({
        externalId: id,
      });
      record = byExternal ?? null;
    }
    if (!record) {
      throw attachmentError(
        "attachment_invalid",
        `Thread '${id}' was not found in namespace '${namespace}'.`,
      );
    }
    const memberIds = stringArray(record.participantIds);
    const members: Participant[] = [];
    for (const participantId of memberIds) {
      const member = await participants?.get({ id: participantId });
      if (member) members.push(mapParticipant(member));
    }
    return mapThread(record, members);
  };

  const connect = async (
    input: ConnectAttachmentInput,
  ): Promise<ThreadAttachment> => {
    const namespace = requiredText(input.namespace, "Namespace");
    if (
      input.databaseSchema !== undefined &&
      input.databaseSchema.trim() !== options.databaseSchema
    ) {
      throw attachmentError(
        "attachment_invalid",
        `Attachment database schema '${input.databaseSchema}' does not match runtime schema '${options.databaseSchema}'.`,
      );
    }
    const thread = await resolveThread(namespace, input.thread);
    const participant = resolveParticipant(
      thread,
      input.participant,
      "Attachment participant",
    );
    const defaultRecipientIds = resolveRecipientIds(thread, input.recipientIds);
    const afterPosition = optionalText(input.afterPosition);
    const streamOffsets = normalizeStreamOffsets(input.streamOffsets);
    const id = `attachment:${createId()}`;
    const active = new Set<ActiveOperation>();
    let closed = false;
    let outputsClosed = false;
    let outputController:
      | ReadableStreamDefaultController<AttachmentOutput>
      | undefined;
    const pendingOutputs: AttachmentOutput[] = [];
    let unbindOutputs = () => {};

    const closeOutputs = (): void => {
      if (outputsClosed) return;
      if (!outputController) return;
      outputsClosed = true;
      for (const output of pendingOutputs) {
        try {
          outputController.enqueue(output);
        } catch {
          break;
        }
      }
      pendingOutputs.length = 0;
      try {
        outputController.close();
      } catch {
        // A consumer may already have cancelled the stream.
      }
    };
    const emitOutput = (output: AttachmentOutput): void => {
      if (closed || outputsClosed) return;
      if (!outputController) {
        pendingOutputs.push(output);
        return;
      }
      try {
        outputController.enqueue(output);
      } catch {
        // Closing an attachment wins races with late stream metadata.
      }
    };

    const close = async (reason = "attachment_closed"): Promise<void> => {
      if (closed) return;
      closed = true;
      unbindOutputs();
      await Promise.all(
        [...active].map((operation) =>
          operation.cancel(reason).catch(() => undefined)
        ),
      );
      active.clear();
      closeOutputs();
      openAttachments.delete(attachment);
    };

    const terminate = async (error: unknown): Promise<void> => {
      if (closed) return;
      closed = true;
      const reason = errorText(error);
      // Error the consumer-facing stream before unbinding the observer;
      // its normal completion path would otherwise race and close the output.
      if (!outputsClosed) {
        outputsClosed = true;
        try {
          outputController?.error(error);
        } catch {
          // A consumer may already have cancelled the stream.
        }
      }
      unbindOutputs();
      await Promise.all(
        [...active].map((operation) =>
          operation.cancel(reason).catch(() => undefined)
        ),
      );
      active.clear();
      openAttachments.delete(attachment);
    };

    const followedStreams = new Set<string>();
    const handledCatchupIds = new Set<string>();
    let catchingUp = afterPosition !== undefined;

    const followRuntimeStream = async (
      event: CopilotzEvent,
    ): Promise<void> => {
      if (event.durable || event.type !== "stream.output") return;
      const streamId = event.streamId?.trim();
      if (!streamId || followedStreams.has(streamId)) return;
      followedStreams.add(streamId);
      if (!options.streamBodyStore) return;
      const payloadRecord =
        event.payload && typeof event.payload === "object" &&
          !Array.isArray(event.payload)
          ? event.payload as Record<string, unknown>
          : {};
      const emitterId = typeof payloadRecord.participantId === "string"
        ? payloadRecord.participantId
        : event.routing.senderId;
      const emitter = emitterId
        ? thread.participants.find((item) =>
          participantMatches(item, emitterId)
        )
        : undefined;
      const mediaType = typeof payloadRecord.mediaType === "string" &&
          payloadRecord.mediaType.trim()
        ? payloadRecord.mediaType.trim()
        : "application/octet-stream";
      const offset = streamOffsets[streamId];
      const runtime = createContentStreamRuntime({
        namespace,
        store: options.streamBodyStore,
      });
      let followerReader:
        | ReadableStreamDefaultReader<Uint8Array>
        | undefined;
      let cancelRequested: unknown;
      let cancelled = false;
      const tracked: { operation?: ActiveOperation } = {};
      const settle = () => {
        if (tracked.operation) active.delete(tracked.operation);
      };
      const cancelFollower = async (reason: unknown) => {
        cancelled = true;
        cancelRequested = reason ?? "attachment_stream_cancelled";
        try {
          await followerReader?.cancel(cancelRequested).then(
            () => undefined,
            () => undefined,
          );
        } finally {
          settle();
        }
      };
      const payload = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (cancelled) {
              controller.close();
              return;
            }
            if (!followerReader) {
              const follower = await runtime.follow({
                id: streamId,
                ...(offset !== undefined ? { offset } : {}),
              });
              if (cancelled) {
                await follower.body.cancel(cancelRequested).then(
                  () => undefined,
                  () => undefined,
                );
                controller.close();
                return;
              }
              followerReader = follower.body.getReader();
            }
            const next = await followerReader.read();
            if (next.done) {
              controller.close();
              settle();
              return;
            }
            controller.enqueue(next.value);
          } catch (error) {
            settle();
            try {
              controller.error(error);
            } catch {
              // The consumer may already have cancelled.
            }
          }
        },
        cancel(reason) {
          return cancelFollower(reason);
        },
      }, { highWaterMark: 2 });
      const operation: ActiveOperation = Object.freeze({
        cancel: (reason) => cancelFollower(reason),
      });
      tracked.operation = operation;
      active.add(operation);
      try {
        emitOutput({
          type: "stream.output",
          streamId,
          participant: outputParticipant(emitter ?? participant),
          mediaType,
          causationId: event.causationId,
          correlationId: event.correlationId,
          metadata: Object.freeze(structuredClone(event.metadata)),
          payload,
        });
      } catch (error) {
        active.delete(operation);
        await cancelFollower(error).catch(() => undefined);
        throw error;
      }
    };

    unbindOutputs = options.transients.add(defineProcessor({
      id: `${id}:outputs`,
      on: [{
        eventType: "*",
        namespace,
        threadId: thread.id,
      }],
      handle(event) {
        if (!visibleTo(event, participant.id)) return;
        if (!event.durable && event.type === "stream.output") {
          void followRuntimeStream(event);
          return;
        }
        const eventId = event.durable ? event.id : undefined;
        if (catchingUp && eventId && handledCatchupIds.has(eventId)) return;
        emitOutput(event);
        if (catchingUp && eventId) handledCatchupIds.add(eventId);
      },
    }));

    if (afterPosition !== undefined) {
      let cursor = afterPosition;
      while (true) {
        const events = await options.store.listEvents({
          namespace,
          threadId: thread.id,
          afterPosition: cursor,
          limit: 1_000,
        });
        for (const event of events) {
          if (!visibleTo(event, participant.id)) continue;
          if (handledCatchupIds.has(event.id)) continue;
          emitOutput(event);
          handledCatchupIds.add(event.id);
        }
        if (events.length < 1_000) break;
        const nextPosition = events.at(-1)?.position;
        if (!nextPosition || nextPosition === cursor) {
          throw attachmentError(
            "attachment_invalid",
            "Attachment catch-up pagination did not advance.",
          );
        }
        cursor = nextPosition;
      }
    }
    catchingUp = false;
    handledCatchupIds.clear();

    const outputs = new ReadableStream<AttachmentOutput>({
      start(controller) {
        outputController = controller;
        const queued = pendingOutputs.splice(0);
        for (const output of queued) {
          if (outputsClosed) break;
          try {
            controller.enqueue(output);
          } catch {
            break;
          }
        }
        if (closed) closeOutputs();
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
      scopeOptions: Readonly<{
        settlementScopeId?: string;
        operations?: readonly ActiveOperation[];
      }> = {},
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
      const settlementScopeId = scopeOptions.settlementScopeId ?? event.id;
      const abort = new AbortController();
      let settled = false;
      const done = waitForScope(
        options.store,
        options.databaseSchema,
        namespace,
        settlementScopeId,
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
          abort.abort(attachmentError("attachment_cancelled", reason));
          await options.store.cancelScope(
            namespace,
            settlementScopeId,
            reason,
          );
          await Promise.all(
            (scopeOptions.operations ?? []).map((operation) =>
              operation.cancel(reason).catch(() => undefined)
            ),
          );
          await done.catch(() => undefined);
        },
      });
      return track(handle);
    };

    const dispatchedOperationsForScope = (
      result: Readonly<{
        settlementScopeId: string;
        deliveries: readonly Readonly<{
          id: string;
          settlementScopeId: string;
        }>[];
        dispatch: Readonly<{
          handles: readonly (ActiveOperation & { deliveryId: string })[];
        }>;
      }>,
    ): readonly ActiveOperation[] => {
      const deliveryIds = new Set(
        result.deliveries.filter((delivery) =>
          delivery.settlementScopeId === result.settlementScopeId
        ).map((delivery) => delivery.id),
      );
      return result.dispatch.handles.filter((handle) =>
        deliveryIds.has(handle.deliveryId)
      );
    };

    const sendMessage = async (
      message: AttachmentMessageInput,
    ): Promise<AttachmentMessageHandle> => {
      if (closed) {
        throw attachmentError("attachment_invalid", "Attachment is closed.");
      }
      assertSender(message.sender, participant);
      const explicitDedup = message.deduplicationId?.trim();
      const correlationId = message.correlationId?.trim() ||
        (explicitDedup
          ? `${namespace}:correlation:${explicitDedup}`
          : createId());
      const deduplicationId = explicitDedup ||
        `${id}:message:${correlationId}`;
      const messageId = workflowMutationId(
        "message",
        namespace,
        message.id,
        { deduplicationId },
        createId,
      );
      const settlementScopeId = messageId;
      const prepared = await options.preparer.prepare(message.content, {
        namespace,
        idempotencyKey: `${deduplicationId}:content`,
      });
      const metadata = structuredClone(message.metadata ?? {});
      const recipientIds = resolveRecipientIds(
        thread,
        message.recipientIds ?? defaultRecipientIds,
      );
      const identity = {
        correlationId,
        deduplicationId,
        settlementScopeId,
        metadata,
      };
      const tx = await options.collectionRuntime.transaction({
        operationKey: deduplicationId,
        namespace,
        identity,
        execute: async () => {
          const context = mutationContext(
            options.collectionRuntime,
            options.session,
            options.store.tables,
          );
          const content = await options.assets.materialize(context, {
            namespace,
            content: prepared,
            origin: {
              scope: { type: "thread", id: thread.id },
              producer: { type: "message", id: messageId },
            },
          });
          const features = createFeatureContext({
            ...options.featureBindings,
            namespace,
          });
          const record = await requireFeatureActions(
            features,
            "copilotz.core.thread-message",
          ).create(
            {
              id: messageId,
              threadId: thread.id,
              sender: participantInput(participant),
              recipientIds: [...recipientIds],
              content,
              metadata,
              visibility: message.visibility ?? { kind: "public" },
            },
            { operationKey: deduplicationId, identity },
          ) as CollectionRecord;
          if (content.length) {
            await options.assets.linkOwner(context, {
              namespace,
              ownerId: String(record.id),
              content,
            });
          }
          return record;
        },
      });
      const write = writeForSubject(tx.writes, "message.created", messageId);
      const created = isCollectionNoop(write)
        ? (await options.store.listEvents({
          namespace,
          threadId: thread.id,
          limit: 1_000,
        })).find((event) =>
          event.type === "message.created" && event.subject?.id === messageId
        )
        : toDurableEvent(write.event);
      if (!created) {
        throw new Error(
          `Message '${messageId}' was created without a durable event.`,
        );
      }
      const deliveries = isCollectionNoop(write)
        ? await options.store.listDeliveries({
          namespace,
          eventId: created.id,
          limit: 1_000,
        })
        : write.deliveries;
      const base = scopeHandle(created, {
        settlementScopeId: isCollectionNoop(write)
          ? tx.settlementScopeId
          : write.settlementScopeId,
        operations: dispatchedOperationsForScope({
          settlementScopeId: isCollectionNoop(write)
            ? tx.settlementScopeId
            : write.settlementScopeId,
          deliveries,
          dispatch: tx.dispatch,
        }),
      });
      return Object.freeze({
        ...base,
        messageId: String(write.record.id),
      }) as AttachmentMessageHandle;
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
      return scopeHandle(result.event, {
        settlementScopeId: result.settlementScopeId,
        operations: dispatchedOperationsForScope(result),
      });
    };

    const send = async (
      value: AttachmentSendInput,
    ): Promise<AttachmentSendResult> => {
      if (isMessageInput(value)) return await sendMessage(value);
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
    openAttachments.set(attachment, terminate);
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
      databaseSchema: input.databaseSchema,
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
      outputs: attachment.outputs,
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
    async terminate(error: unknown) {
      await Promise.all(
        [...openAttachments.values()].map((terminate) =>
          terminate(error).catch(() => undefined)
        ),
      );
    },
    async shutdown(reason = "attachment_runtime_shutdown") {
      await Promise.all(
        [...openAttachments.keys()].map((attachment) =>
          attachment.close(reason).catch(() => undefined)
        ),
      );
    },
  });
}
