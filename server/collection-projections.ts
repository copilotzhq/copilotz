import type {
  CollectionRecord,
  ScopedCollections,
} from "../runtime/collections/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "@copilotz/copilotz/core";
import {
  mapMessageRecord,
  mapParticipantRecord,
  mapThreadRecord,
} from "@copilotz/copilotz/core";

function strings(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

export async function projectThread(
  collections: ScopedCollections,
  record: CollectionRecord,
): Promise<ConversationThread> {
  const loaded = await Promise.all(
    strings(record.participantIds).map((id) =>
      collections.participant.get({ id })
    ),
  );
  return mapThreadRecord(
    record,
    loaded.filter((item): item is CollectionRecord => item !== null).map(
      mapParticipantRecord,
    ),
  );
}

export async function getThread(
  collections: ScopedCollections,
  id: string,
): Promise<ConversationThread | null> {
  const record = await collections.thread.get({ id });
  return record ? await projectThread(collections, record) : null;
}

export async function listThreads(
  collections: ScopedCollections,
  options: Readonly<{
    participantId?: string;
    status?: readonly string[];
    after?: string;
    limit?: number;
    order?: "asc" | "desc";
  }> = {},
): Promise<readonly ConversationThread[]> {
  const records = await collections.thread.list({
    ...(options.status?.length ? { where: { status: options.status[0] } } : {}),
    ...(options.after ? { after: options.after } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
    order: { field: "createdAt", direction: options.order ?? "asc" },
  });
  const projected = await Promise.all(
    records.map((record) => projectThread(collections, record)),
  );
  return Object.freeze(
    options.participantId
      ? projected.filter((thread) =>
        thread.participants.some((item) => item.id === options.participantId)
      )
      : projected,
  );
}

export async function projectMessage(
  collections: ScopedCollections,
  record: CollectionRecord,
): Promise<ConversationMessage> {
  const sender = await collections.participant.get({
    id: String(record.senderId ?? ""),
  });
  if (!sender) throw new Error(`Message '${record.id}' sender was not found.`);
  return mapMessageRecord(record, mapParticipantRecord(sender));
}

export async function getMessage(
  collections: ScopedCollections,
  id: string,
): Promise<ConversationMessage | null> {
  const record = await collections.message.get({ id });
  return record ? await projectMessage(collections, record) : null;
}

export async function listMessages(
  collections: ScopedCollections,
  threadId: string,
  options: Readonly<{
    after?: string;
    before?: string;
    limit?: number;
    order?: "asc" | "desc";
    view?: "active" | "all";
  }> = {},
): Promise<readonly ConversationMessage[]> {
  const records = await collections.message.queries.history({
    threadId,
    ...options,
  });
  return Object.freeze(
    await Promise.all(
      records.map((record) => projectMessage(collections, record)),
    ),
  );
}

export function projectParticipant(record: CollectionRecord): Participant {
  return mapParticipantRecord(record);
}
