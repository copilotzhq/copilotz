import type { CopilotzProcessorContext } from "@copilotz/copilotz/engine";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  base64ToBytes,
  type ContentInput,
  parseDataUrl,
} from "@copilotz/copilotz/content";
import { defineProcessor, type Processor } from "@copilotz/copilotz/plugins";
import { CORE_MESSAGE_INPUT_EVENT } from "../inputs/index.ts";
import { threadMessageFeature } from "../features/thread-message.ts";

const MEDIA_TYPES = new Set(["image", "audio", "video", "file"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireText(value: unknown, name: string): string {
  const text = optionalText(value);
  if (!text) throw new TypeError(`${name} must be non-empty.`);
  return text;
}

async function resolveThreadId(
  context: CopilotzProcessorContext,
  value: unknown,
): Promise<string> {
  const threads = context.collections.thread;
  if (!threads) throw new Error("Collection 'thread' is not bound.");

  if (typeof value === "string") {
    const idOrExternalId = requireText(value, "Message thread");
    const byId = await threads.get({ id: idOrExternalId });
    if (byId) return byId.id;
    if (threads.queries.byExternalId) {
      const [byExternal] = await threads.queries.byExternalId({
        externalId: idOrExternalId,
      });
      if (byExternal) return byExternal.id;
    }
    return idOrExternalId;
  }

  const item = record(value);
  const id = optionalText(item.id);
  if (id) {
    const byId = await threads.get({ id });
    if (byId) return byId.id;
  }
  const externalId = optionalText(item.externalId);
  if (externalId && threads.queries.byExternalId) {
    const [byExternal] = await threads.queries.byExternalId({ externalId });
    if (byExternal) return byExternal.id;
  }
  return id ?? requireText(externalId, "Message thread");
}

async function resolveParticipantId(
  context: CopilotzProcessorContext,
  value: string,
): Promise<string> {
  const idOrExternalId = requireText(value, "Message recipient");
  const participants = context.collections.participant;
  if (!participants) throw new Error("Collection 'participant' is not bound.");
  const byId = await participants.get({ id: idOrExternalId });
  if (byId) return byId.id;
  if (participants.queries.byExternalId) {
    const [byExternal] = await participants.queries.byExternalId({
      externalId: idOrExternalId,
    });
    if (byExternal) return byExternal.id;
  }
  return idOrExternalId;
}

async function resolveParticipantRecord(
  context: CopilotzProcessorContext,
  value: unknown,
): Promise<CollectionRecord | null> {
  const participants = context.collections.participant;
  if (!participants) throw new Error("Collection 'participant' is not bound.");
  if (typeof value === "string") {
    const id = optionalText(value);
    if (!id) return null;
    return await participants.get({ id }) ??
      (participants.queries.byExternalId
        ? (await participants.queries.byExternalId({ externalId: id }))[0] ??
          null
        : null);
  }
  const item = record(value);
  const id = optionalText(item.id);
  if (id) {
    const byId = await participants.get({ id });
    if (byId) return byId;
  }
  const externalId = optionalText(item.externalId);
  if (externalId && participants.queries.byExternalId) {
    const [byExternal] = await participants.queries.byExternalId({
      externalId,
    });
    if (byExternal) return byExternal;
  }
  return null;
}

function recordStringArray(
  value: unknown,
): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim())
    ).map((item) => item.trim()),
  );
}

async function defaultRecipientIds(
  context: CopilotzProcessorContext,
  threadId: string,
  senderInput: unknown,
): Promise<readonly string[]> {
  const thread = await context.collections.thread.get({ id: threadId });
  if (!thread) return Object.freeze([]);
  const sender = await resolveParticipantRecord(context, senderInput);
  const senderId = optionalText(sender?.id);
  const participantIds = recordStringArray(thread.participantIds);
  const participants = await Promise.all(
    participantIds.map((id) => context.collections.participant.get({ id })),
  );
  return Object.freeze(
    participants
      .filter((item): item is CollectionRecord => item !== null)
      .filter((item) =>
        item.participantType === "agent" && optionalText(item.id) !== senderId
      )
      .map((item) => String(item.id)),
  );
}

async function recipientIds(
  context: CopilotzProcessorContext,
  value: unknown,
  threadId: string,
  senderInput: unknown,
): Promise<readonly string[]> {
  if (!Array.isArray(value)) {
    return await defaultRecipientIds(context, threadId, senderInput);
  }
  const ids = stringArray(value);
  const resolved = await Promise.all(
    ids.map((id) => resolveParticipantId(context, id)),
  );
  return Object.freeze([...new Set(resolved)]);
}

function participant(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.trim()) {
    const id = value.trim();
    return { id, externalId: id, participantType: "human" };
  }
  const item = record(value);
  if (!item.id && !item.externalId) {
    throw new TypeError("Message participant requires id or externalId.");
  }
  return item;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim())
    ).map((item) => item.trim()),
  );
}

function contentPart(value: unknown): unknown {
  const part = record(value);
  if (!part || typeof part.type !== "string" || !MEDIA_TYPES.has(part.type)) {
    return value;
  }
  if (part.bytes instanceof Uint8Array) return value;
  const encoded = typeof part.dataBase64 === "string"
    ? {
      bytes: base64ToBytes(part.dataBase64),
      mediaType: typeof part.mediaType === "string"
        ? part.mediaType
        : "application/octet-stream",
    }
    : typeof part.url === "string"
    ? parseDataUrl(part.url)
    : null;
  if (!encoded) return value;
  const { dataBase64: _dataBase64, url: _url, ...rest } = part;
  return Object.freeze({
    ...rest,
    bytes: encoded.bytes,
    mediaType: typeof part.mediaType === "string"
      ? part.mediaType
      : encoded.mediaType,
  });
}

function contentInput(value: unknown): ContentInput | readonly ContentInput[] {
  return (Array.isArray(value)
    ? Object.freeze(value.map(contentPart))
    : contentPart(value)) as ContentInput | readonly ContentInput[];
}

export const messageInputProcessor: Processor<CopilotzProcessorContext> =
  defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.message-input",
    on: [{ eventType: CORE_MESSAGE_INPUT_EVENT }],
    requires: { features: { threadMessage: threadMessageFeature } },
    async handle(event, context) {
      if (!event.durable) return;
      const input = record(event.payload);
      const threadId = await resolveThreadId(context, input.thread);
      const content = await context.content.prepare(
        contentInput(input.content),
        {
          operationKey: "core-message-input-content",
        },
      );
      const persisted = await context.content.materialize(content);
      await context.features.threadMessage.create({
        id: optionalText(input.id) ?? event.id,
        threadId,
        sender: participant(input.participant),
        recipientIds: await recipientIds(
          context,
          input.recipientIds,
          threadId,
          input.participant,
        ),
        content: persisted,
        metadata: record(input.metadata),
        ...(input.visibility ? { visibility: input.visibility } : {}),
      }, {
        operationKey: "core-message-input",
        identity: {
          causationId: event.id,
          correlationId: event.correlationId,
          deduplicationId: event.deduplicationId,
          settlementScopeId: event.id,
        },
      });
    },
  });
