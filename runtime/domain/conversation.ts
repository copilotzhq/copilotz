import { ulid } from "../../dependencies/ulid.ts";
import type { ContentRef, ContentSequence } from "../content/index.ts";
import type { SqlExecutor } from "../events/index.ts";
import type {
  ConversationMessage,
  ConversationRepository,
  ConversationThread,
  CreateConversationRepositoryOptions,
  MessageBranch,
  MessageRevision,
  MessageRevisionResult,
  MutationIdentity,
  Participant,
  ParticipantInput,
  ParticipantPatch,
  ParticipantType,
  ThreadPatch,
} from "./types.ts";

type NodeRow = Record<string, unknown> & {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: unknown;
  source_type: string | null;
  source_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function iso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectValue(value: unknown): Record<string, unknown> {
  return structuredClone(record(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function requireText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Message limit must be a positive integer.");
  }
  return Math.min(value, 1_000);
}

const CONTENT_KINDS = new Set([
  "text",
  "json",
  "image",
  "audio",
  "video",
  "file",
]);

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string when provided.`);
  }
  return value.trim();
}

function nullableText(
  value: string | null | undefined,
  name: string,
): string | null | undefined {
  if (value === undefined || value === null) return value;
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${name} must be non-empty or null.`);
  }
  return normalized;
}

function changedPatchFields(
  patch: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  label: string,
): readonly string[] {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(patch).filter((key) => !allowedSet.has(key));
  if (unknown.length) {
    throw new TypeError(
      `${label} contains unknown fields: ${unknown.join(", ")}.`,
    );
  }
  const fields = Object.keys(patch).filter((key) => patch[key] !== undefined);
  if (!fields.length) throw new TypeError(`${label} must change a field.`);
  return Object.freeze(fields.sort());
}

function normalizeContent(content: ContentSequence): ContentSequence {
  if (!Array.isArray(content)) {
    throw new TypeError(
      "Message content must be an ordered array of asset refs.",
    );
  }
  const refs = content.map((candidate, index): ContentRef => {
    if (
      !candidate || typeof candidate !== "object" || Array.isArray(candidate)
    ) {
      throw new TypeError(`Message content[${index}] must be an asset ref.`);
    }
    const value = candidate as ContentRef;
    const kind = requireText(value.kind, `Message content[${index}].kind`);
    if (!CONTENT_KINDS.has(kind)) {
      throw new TypeError(
        `Message content[${index}] has invalid kind '${kind}'.`,
      );
    }
    const disposition = value.disposition;
    if (
      disposition !== undefined && disposition !== "inline" &&
      disposition !== "attachment"
    ) {
      throw new TypeError(
        `Message content[${index}].disposition must be inline or attachment.`,
      );
    }
    return {
      assetId: requireText(
        value.assetId,
        `Message content[${index}].assetId`,
      ),
      kind: kind as ContentRef["kind"],
      role: requireText(value.role, `Message content[${index}].role`),
      mediaType: requireText(
        value.mediaType,
        `Message content[${index}].mediaType`,
      ),
      ...(optionalText(value.name, `Message content[${index}].name`)
        ? { name: value.name!.trim() }
        : {}),
      ...(optionalText(value.alt, `Message content[${index}].alt`)
        ? { alt: value.alt!.trim() }
        : {}),
      ...(optionalText(value.language, `Message content[${index}].language`)
        ? { language: value.language!.trim() }
        : {}),
      ...(disposition ? { disposition } : {}),
      ...(value.metadata ? { metadata: objectValue(value.metadata) } : {}),
    };
  });
  return deepFreeze(refs);
}

function normalizeRecipientIds(
  values: readonly string[] | undefined,
): readonly string[] {
  const result = new Set<string>();
  for (const value of values ?? []) {
    result.add(requireText(value, "Recipient ID"));
  }
  return Object.freeze([...result]);
}

function stableMutationId(
  type: string,
  namespace: string,
  explicit: string | undefined,
  identity: MutationIdentity | undefined,
  createId: () => string,
): string {
  if (explicit?.trim()) return explicit.trim();
  if (identity?.deduplicationId?.trim()) {
    return `${namespace}:${type}:${identity.deduplicationId.trim()}`;
  }
  return createId();
}

function participantType(value: unknown): ParticipantType {
  if (
    value === "human" || value === "agent" || value === "tool" ||
    value === "job"
  ) return value;
  throw new Error(`Stored participant has invalid type '${String(value)}'.`);
}

function positiveRevisionIndex(value: unknown, name: string): number {
  const result = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(result) || result < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return result;
}

function messageBranch(value: unknown): MessageBranch | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const rootMessageId = stringValue(input.rootMessageId);
  const headMessageId = stringValue(input.headMessageId);
  const previousRevisionMessageId = stringValue(
    input.previousRevisionMessageId,
  );
  if (!rootMessageId || !headMessageId || !previousRevisionMessageId) {
    throw new Error("Stored message branch is incomplete.");
  }
  return deepFreeze({
    rootMessageId,
    headMessageId,
    previousRevisionMessageId,
    revisionIndex: positiveRevisionIndex(
      input.revisionIndex,
      "Stored message branch revision index",
    ),
  });
}

function messageRevision(
  value: unknown,
  revisedAt: string,
): MessageRevision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Record<string, unknown>;
  const rootMessageId = stringValue(input.rootMessageId);
  const previousRevisionMessageId = stringValue(
    input.previousRevisionMessageId,
  );
  if (!rootMessageId || !previousRevisionMessageId) {
    throw new Error("Stored message revision is incomplete.");
  }
  return deepFreeze({
    rootMessageId,
    previousRevisionMessageId,
    revisionIndex: positiveRevisionIndex(
      input.revisionIndex,
      "Stored message revision index",
    ),
    revisedAt,
  });
}

function assertParticipantCompatible(
  participant: Participant,
  input: ParticipantInput,
): Participant {
  if (participant.participantType !== input.participantType) {
    throw new Error(
      `Participant '${participant.externalId}' is already '${participant.participantType}', not '${input.participantType}'.`,
    );
  }
  if (input.agentId && participant.agentId !== input.agentId) {
    throw new Error(
      `Participant '${participant.externalId}' belongs to a different agent.`,
    );
  }
  return participant;
}

function mapParticipant(row: NodeRow): Participant {
  const data = record(row.data);
  const externalId = stringValue(data.externalId) ?? row.source_id;
  if (!externalId) {
    throw new Error(`Participant '${row.id}' has no external ID.`);
  }
  return deepFreeze({
    id: row.id,
    namespace: row.namespace,
    externalId,
    participantType: participantType(data.participantType),
    ...(stringValue(data.name) ? { name: stringValue(data.name) } : {}),
    ...(stringValue(data.email) ? { email: stringValue(data.email) } : {}),
    ...(stringValue(data.agentId)
      ? { agentId: stringValue(data.agentId) }
      : {}),
    metadata: objectValue(data.metadata),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapThread(
  row: NodeRow,
  participants: readonly Participant[],
): ConversationThread {
  const data = record(row.data);
  return deepFreeze({
    id: row.id,
    namespace: row.namespace,
    ...(row.source_id ? { externalId: row.source_id } : {}),
    status: stringValue(data.status) ?? "active",
    ...(stringValue(data.parentThreadId)
      ? { parentThreadId: stringValue(data.parentThreadId) }
      : {}),
    metadata: objectValue(data.metadata),
    participants: [...participants],
    ...(messageBranch(data.activeMessageBranch)
      ? { activeMessageBranch: messageBranch(data.activeMessageBranch) }
      : {}),
    ...(stringValue(data.lastEventId)
      ? { lastEventId: stringValue(data.lastEventId) }
      : {}),
    ...(data.lastEventPosition !== undefined
      ? { lastEventPosition: String(data.lastEventPosition) }
      : {}),
    ...(stringValue(data.lastEventAt)
      ? { lastEventAt: stringValue(data.lastEventAt) }
      : {}),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  });
}

function mapMessage(row: NodeRow, sender: Participant): ConversationMessage {
  const data = record(row.data);
  const threadId = stringValue(data.threadId);
  if (!threadId) throw new Error(`Message '${row.id}' has no thread ID.`);
  const content = normalizeContent(
    (Array.isArray(data.content) ? data.content : []) as ContentSequence,
  );
  const recipientIds = Array.isArray(data.recipientIds)
    ? data.recipientIds.filter((value): value is string =>
      typeof value === "string"
    )
    : [];
  const updatedAt = iso(row.updated_at);
  return deepFreeze({
    id: row.id,
    namespace: row.namespace,
    threadId,
    sender,
    recipientIds,
    content,
    metadata: objectValue(data.metadata),
    ...(messageRevision(data.revision, iso(row.created_at))
      ? { revision: messageRevision(data.revision, iso(row.created_at)) }
      : {}),
    createdAt: iso(row.created_at),
    updatedAt,
  });
}

function projectActiveMessageBranch(
  messages: readonly ConversationMessage[],
  branch: MessageBranch | undefined,
): readonly ConversationMessage[] {
  if (!branch) return messages;
  const rootIndex = messages.findIndex((message) =>
    message.id === branch.rootMessageId
  );
  const headIndex = messages.findIndex((message) =>
    message.id === branch.headMessageId
  );
  if (rootIndex < 0 || headIndex <= rootIndex) return messages;
  return Object.freeze([
    ...messages.slice(0, rootIndex),
    messages[headIndex],
    ...messages.slice(headIndex + 1),
  ]);
}

function identityDraft(identity: MutationIdentity | undefined) {
  return {
    ...(identity?.causationId ? { causationId: identity.causationId } : {}),
    ...(identity?.correlationId
      ? { correlationId: identity.correlationId }
      : {}),
    ...(identity?.deduplicationId
      ? { deduplicationId: identity.deduplicationId }
      : {}),
    metadata: structuredClone(identity?.metadata ?? {}),
  };
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

/** Creates typed graph-native participant, thread, and message operations. */
export function createConversationRepository(
  options: CreateConversationRepositoryOptions,
): ConversationRepository {
  const createId = options.createId ?? ulid;
  const coordinator = options.coordinator;
  const assets = options.assets;
  const readSession = options.session;
  const names = options.eventStore.tables;

  const findNode = async (
    transaction: SqlExecutor,
    table: string,
    namespace: string,
    id: string,
    type: string,
  ): Promise<NodeRow | null> => {
    const result = await transaction.query<NodeRow>(
      `SELECT * FROM ${table}
       WHERE namespace = $1 AND id = $2 AND type = $3 LIMIT 1`,
      [namespace, id, type],
    );
    return result.rows[0] ?? null;
  };

  const findParticipantByExternalId = async (
    transaction: SqlExecutor,
    table: string,
    namespace: string,
    externalId: string,
  ): Promise<NodeRow | null> => {
    const result = await transaction.query<NodeRow>(
      `SELECT * FROM ${table}
       WHERE namespace = $1 AND type = 'participant'
         AND source_type = 'participant_external_id' AND source_id = $2
       LIMIT 1`,
      [namespace, externalId],
    );
    return result.rows[0] ?? null;
  };

  const findThreadByExternalId = async (
    transaction: SqlExecutor,
    table: string,
    namespace: string,
    externalId: string,
  ): Promise<NodeRow | null> => {
    const result = await transaction.query<NodeRow>(
      `SELECT * FROM ${table}
       WHERE namespace = $1 AND type = 'thread'
         AND source_type = 'thread_external_id' AND source_id = $2
       LIMIT 1`,
      [namespace, externalId],
    );
    return result.rows[0] ?? null;
  };

  const ensureParticipant = async (
    transaction: SqlExecutor,
    table: string,
    namespace: string,
    input: ParticipantInput,
  ): Promise<Participant> => {
    const externalId = requireText(input.externalId, "Participant externalId");
    const normalizedType = participantType(input.participantType);
    const existing = await findParticipantByExternalId(
      transaction,
      table,
      namespace,
      externalId,
    );
    if (existing) {
      if (input.id?.trim() && input.id.trim() !== existing.id) {
        throw new Error(
          `Participant '${externalId}' already exists as '${existing.id}'.`,
        );
      }
      return assertParticipantCompatible(mapParticipant(existing), input);
    }
    const id = input.id?.trim() || createId();
    const data = {
      externalId,
      participantType: normalizedType,
      name: input.name ?? null,
      email: input.email ?? null,
      agentId: input.agentId ?? null,
      metadata: structuredClone(input.metadata ?? {}),
    };
    const inserted = await transaction.query<NodeRow>(
      `INSERT INTO ${table} (
         id, namespace, type, name, data, source_type, source_id
       ) VALUES ($1, $2, 'participant', $3, $4::jsonb,
                 'participant_external_id', $5)
       ON CONFLICT (namespace, source_id)
         WHERE type = 'participant'
           AND source_type = 'participant_external_id'
           AND source_id IS NOT NULL
       DO NOTHING RETURNING *`,
      [
        id,
        namespace,
        input.name ?? externalId,
        JSON.stringify(data),
        externalId,
      ],
    );
    if (inserted.rows[0]) return mapParticipant(inserted.rows[0]);
    const raced = await findParticipantByExternalId(
      transaction,
      table,
      namespace,
      externalId,
    );
    if (!raced) {
      throw new Error(`Participant '${externalId}' could not be created.`);
    }
    if (input.id?.trim() && input.id.trim() !== raced.id) {
      throw new Error(
        `Participant '${externalId}' already exists as '${raced.id}'.`,
      );
    }
    return assertParticipantCompatible(mapParticipant(raced), input);
  };

  const insertParticipant = async (
    transaction: SqlExecutor,
    table: string,
    namespace: string,
    input: ParticipantInput,
    id: string,
  ): Promise<Participant> => {
    const externalId = requireText(input.externalId, "Participant externalId");
    const normalizedType = participantType(input.participantType);
    const existing = await findParticipantByExternalId(
      transaction,
      table,
      namespace,
      externalId,
    );
    if (existing) {
      throw new Error(
        `Participant '${externalId}' already exists as '${existing.id}'.`,
      );
    }
    const result = await transaction.query<NodeRow>(
      `INSERT INTO ${table} (
         id, namespace, type, name, data, source_type, source_id
       ) VALUES ($1, $2, 'participant', $3, $4::jsonb,
                 'participant_external_id', $5)
       RETURNING *`,
      [
        id,
        namespace,
        input.name ?? externalId,
        JSON.stringify({
          externalId,
          participantType: normalizedType,
          name: input.name ?? null,
          email: input.email ?? null,
          agentId: input.agentId ?? null,
          metadata: structuredClone(input.metadata ?? {}),
        }),
        externalId,
      ],
    );
    return mapParticipant(result.rows[0]);
  };

  const listParticipants = async (
    transaction: SqlExecutor,
    nodes: string,
    edges: string,
    namespace: string,
    threadId: string,
  ): Promise<readonly Participant[]> => {
    const result = await transaction.query<NodeRow>(
      `SELECT participant.* FROM ${nodes} participant
       JOIN ${edges} edge ON edge.source_node_id = participant.id
       WHERE edge.namespace = $1 AND edge.target_node_id = $2
         AND edge.type = 'participates_in'
         AND participant.namespace = $1 AND participant.type = 'participant'
       ORDER BY edge.created_at, participant.id`,
      [namespace, threadId],
    );
    return result.rows.map(mapParticipant);
  };

  const getThreadWith = async (
    transaction: SqlExecutor,
    nodes: string,
    edges: string,
    namespace: string,
    id: string,
  ): Promise<ConversationThread | null> => {
    const row = await findNode(transaction, nodes, namespace, id, "thread");
    if (!row) return null;
    return mapThread(
      row,
      await listParticipants(transaction, nodes, edges, namespace, id),
    );
  };

  const getMessageWith = async (
    transaction: SqlExecutor,
    nodes: string,
    namespace: string,
    id: string,
  ): Promise<ConversationMessage | null> => {
    const row = await findNode(transaction, nodes, namespace, id, "message");
    if (!row) return null;
    const data = record(row.data);
    const senderId = stringValue(data.senderId);
    if (!senderId) throw new Error(`Message '${id}' has no sender ID.`);
    const senderRow = await findNode(
      transaction,
      nodes,
      namespace,
      senderId,
      "participant",
    );
    if (!senderRow) throw new Error(`Message '${id}' sender was not found.`);
    return mapMessage(row, mapParticipant(senderRow));
  };

  const repository: ConversationRepository = {
    createParticipant(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const externalId = requireText(
        input.participant.externalId,
        "Participant externalId",
      );
      const id = stableMutationId(
        "participant",
        namespace,
        input.participant.id,
        input.identity,
        createId,
      );
      return coordinator.commitMutation({
        draft: {
          type: "participant.created",
          namespace,
          subject: { type: "participant", id },
          payload: { participantId: id },
          ...identityDraft(input.identity),
        },
        mutate: ({ transaction, tables: names }) =>
          insertParticipant(
            transaction,
            names.nodes,
            namespace,
            { ...input.participant, externalId },
            id,
          ),
        recoverDuplicate: async (_event, { transaction, tables: names }) => {
          const row = await findNode(
            transaction,
            names.nodes,
            namespace,
            id,
            "participant",
          );
          if (!row) throw new Error(`Participant '${id}' was not found.`);
          return mapParticipant(row);
        },
      });
    },
    updateParticipant(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const id = requireText(input.id, "Participant ID");
      const patch = input.patch as ParticipantPatch & Record<string, unknown>;
      const fields = changedPatchFields(
        patch,
        ["name", "email", "agentId", "metadata"],
        "Participant patch",
      );
      const name = nullableText(patch.name, "Participant name");
      const email = nullableText(patch.email, "Participant email");
      const agentId = nullableText(patch.agentId, "Participant agentId");
      if (
        patch.metadata !== undefined &&
        (!patch.metadata || typeof patch.metadata !== "object" ||
          Array.isArray(patch.metadata))
      ) {
        throw new TypeError("Participant metadata must be an object.");
      }
      return coordinator.commitMutation({
        draft: {
          type: "participant.updated",
          namespace,
          subject: { type: "participant", id },
          payload: { participantId: id },
          delta: { fields },
          ...identityDraft(input.identity),
        },
        mutate: async ({ transaction, tables: names }) => {
          const row = await findNode(
            transaction,
            names.nodes,
            namespace,
            id,
            "participant",
          );
          if (!row) throw new Error(`Participant '${id}' was not found.`);
          const current = mapParticipant(row);
          const data = record(row.data);
          const nextName = name === undefined
            ? current.name
            : name ?? undefined;
          const nextEmail = email === undefined
            ? current.email
            : email ?? undefined;
          const nextAgentId = agentId === undefined
            ? current.agentId
            : agentId ?? undefined;
          const nextMetadata = patch.metadata === undefined
            ? current.metadata
            : structuredClone(patch.metadata);
          const result = await transaction.query<NodeRow>(
            `UPDATE ${names.nodes}
             SET name = $4, data = $5::jsonb, updated_at = CURRENT_TIMESTAMP
             WHERE namespace = $1 AND id = $2 AND type = $3
             RETURNING *`,
            [
              namespace,
              id,
              "participant",
              nextName ?? current.externalId,
              JSON.stringify({
                ...data,
                externalId: current.externalId,
                participantType: current.participantType,
                name: nextName ?? null,
                email: nextEmail ?? null,
                agentId: nextAgentId ?? null,
                metadata: nextMetadata,
              }),
            ],
          );
          return mapParticipant(result.rows[0]);
        },
        recoverDuplicate: async (_event, { transaction, tables: names }) => {
          const row = await findNode(
            transaction,
            names.nodes,
            namespace,
            id,
            "participant",
          );
          if (!row) throw new Error(`Participant '${id}' was not found.`);
          return mapParticipant(row);
        },
      });
    },
    async getParticipant(namespaceInput, idInput) {
      const namespace = requireText(namespaceInput, "Namespace");
      const id = requireText(idInput, "Participant ID");
      return await readParticipant(namespace, id);
    },
    async getParticipantByExternalId(namespaceInput, externalIdInput) {
      return await readParticipantByExternalId(
        requireText(namespaceInput, "Namespace"),
        requireText(externalIdInput, "Participant externalId"),
      );
    },
    listParticipants(namespaceInput, listOptions = {}) {
      return readParticipants(
        requireText(namespaceInput, "Namespace"),
        listOptions,
      );
    },
    createThread(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const id = stableMutationId(
        "thread",
        namespace,
        input.id,
        input.identity,
        createId,
      );
      const externalId = input.externalId?.trim() || undefined;
      const parentThreadId = input.parentThreadId?.trim() || undefined;
      if (parentThreadId === id) {
        throw new TypeError("A thread cannot be its own parent.");
      }
      const status = requireText(input.status ?? "active", "Thread status");
      return coordinator.commitMutation({
        draft: {
          type: "thread.created",
          namespace,
          threadId: id,
          subject: { type: "thread", id },
          payload: { threadId: id },
          ...identityDraft(input.identity),
        },
        mutate: async ({ transaction, tables: names }) => {
          if (externalId) {
            const existing = await findThreadByExternalId(
              transaction,
              names.nodes,
              namespace,
              externalId,
            );
            if (existing) {
              throw new Error(
                `Thread '${externalId}' already exists as '${existing.id}'.`,
              );
            }
          }
          if (parentThreadId) {
            const parent = await findNode(
              transaction,
              names.nodes,
              namespace,
              parentThreadId,
              "thread",
            );
            if (!parent) {
              throw new Error(
                `Parent thread '${parentThreadId}' was not found.`,
              );
            }
          }
          const inserted = await transaction.query<NodeRow>(
            `INSERT INTO ${names.nodes} (
               id, namespace, type, name, data, source_type, source_id
             ) VALUES ($1, $2, 'thread', $3, $4::jsonb, $5, $6)
             RETURNING *`,
            [
              id,
              namespace,
              externalId ?? id,
              JSON.stringify({
                status,
                parentThreadId: parentThreadId ?? null,
                metadata: structuredClone(input.metadata ?? {}),
              }),
              externalId ? "thread_external_id" : null,
              externalId ?? null,
            ],
          );
          for (const participantInput of input.participants ?? []) {
            const participant = await ensureParticipant(
              transaction,
              names.nodes,
              namespace,
              participantInput,
            );
            await transaction.query(
              `INSERT INTO ${names.edges} (
                 id, namespace, source_node_id, target_node_id, type, data, weight
               ) VALUES ($1, $2, $3, $4, 'participates_in', '{}', 1)
               ON CONFLICT DO NOTHING`,
              [createId(), namespace, participant.id, id],
            );
          }
          if (parentThreadId) {
            await transaction.query(
              `INSERT INTO ${names.edges} (
                 id, namespace, source_node_id, target_node_id, type, data, weight
               ) VALUES ($1, $2, $3, $4, 'has_child_thread', '{}', 1)`,
              [createId(), namespace, parentThreadId, id],
            );
          }
          return mapThread(
            inserted.rows[0],
            await listParticipants(
              transaction,
              names.nodes,
              names.edges,
              namespace,
              id,
            ),
          );
        },
        recoverDuplicate: async (_event, { transaction, tables: names }) => {
          const thread = await getThreadWith(
            transaction,
            names.nodes,
            names.edges,
            namespace,
            id,
          );
          if (!thread) throw new Error(`Thread '${id}' was not found.`);
          return thread;
        },
      });
    },
    addThreadParticipant(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const threadId = requireText(input.threadId, "Thread ID");
      const externalId = requireText(
        input.participant.externalId,
        "Participant externalId",
      );
      return coordinator.commitMutation({
        draft: {
          type: "thread.participant_added",
          namespace,
          threadId,
          subject: { type: "thread", id: threadId },
          payload: { threadId, participantExternalId: externalId },
          ...identityDraft(input.identity),
        },
        mutate: async ({ transaction, tables: names }) => {
          const thread = await findNode(
            transaction,
            names.nodes,
            namespace,
            threadId,
            "thread",
          );
          if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
          const participant = await ensureParticipant(
            transaction,
            names.nodes,
            namespace,
            { ...input.participant, externalId },
          );
          await transaction.query(
            `INSERT INTO ${names.edges} (
               id, namespace, source_node_id, target_node_id, type, data, weight
             ) VALUES ($1, $2, $3, $4, 'participates_in', '{}', 1)
             ON CONFLICT DO NOTHING`,
            [createId(), namespace, participant.id, threadId],
          );
          const updated = await getThreadWith(
            transaction,
            names.nodes,
            names.edges,
            namespace,
            threadId,
          );
          if (!updated) throw new Error(`Thread '${threadId}' was not found.`);
          return updated;
        },
        recoverDuplicate: async (_event, { transaction, tables: names }) => {
          const thread = await getThreadWith(
            transaction,
            names.nodes,
            names.edges,
            namespace,
            threadId,
          );
          if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
          return thread;
        },
      });
    },
    updateThread(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const id = requireText(input.id, "Thread ID");
      const patch = input.patch as ThreadPatch & Record<string, unknown>;
      const fields = changedPatchFields(
        patch,
        ["status", "metadata"],
        "Thread patch",
      );
      const status = patch.status === undefined
        ? undefined
        : requireText(patch.status, "Thread status");
      if (
        patch.metadata !== undefined &&
        (!patch.metadata || typeof patch.metadata !== "object" ||
          Array.isArray(patch.metadata))
      ) {
        throw new TypeError("Thread metadata must be an object.");
      }
      return coordinator.commitMutation({
        draft: {
          type: "thread.updated",
          namespace,
          threadId: id,
          subject: { type: "thread", id },
          payload: { threadId: id },
          delta: { fields },
          ...identityDraft(input.identity),
        },
        mutate: async ({ transaction, tables: names }) => {
          const row = await findNode(
            transaction,
            names.nodes,
            namespace,
            id,
            "thread",
          );
          if (!row) throw new Error(`Thread '${id}' was not found.`);
          const data = record(row.data);
          const result = await transaction.query<NodeRow>(
            `UPDATE ${names.nodes}
             SET data = $4::jsonb, updated_at = CURRENT_TIMESTAMP
             WHERE namespace = $1 AND id = $2 AND type = $3
             RETURNING *`,
            [
              namespace,
              id,
              "thread",
              JSON.stringify({
                ...data,
                status: status ?? stringValue(data.status) ?? "active",
                metadata: patch.metadata === undefined
                  ? objectValue(data.metadata)
                  : structuredClone(patch.metadata),
              }),
            ],
          );
          return mapThread(
            result.rows[0],
            await listParticipants(
              transaction,
              names.nodes,
              names.edges,
              namespace,
              id,
            ),
          );
        },
        recoverDuplicate: async (_event, { transaction, tables: names }) => {
          const thread = await getThreadWith(
            transaction,
            names.nodes,
            names.edges,
            namespace,
            id,
          );
          if (!thread) throw new Error(`Thread '${id}' was not found.`);
          return thread;
        },
      });
    },
    deleteThread(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const id = requireText(input.id, "Thread ID");
      return coordinator.commitMutation({
        draft: {
          type: "thread.deleted",
          namespace,
          threadId: id,
          subject: { type: "thread", id },
          payload: { threadId: id },
          visibility: { kind: "internal" },
          ...identityDraft(input.identity),
        },
        mutate: async ({ transaction, tables: names }) => {
          const locked = await transaction.query<NodeRow>(
            `SELECT * FROM ${names.nodes}
             WHERE namespace = $1 AND id = $2 AND type = 'thread'
             FOR UPDATE`,
            [namespace, id],
          );
          if (!locked.rows[0]) {
            throw new Error(`Thread '${id}' was not found.`);
          }
          const children = await transaction.query<NodeRow>(
            `SELECT child.* FROM ${names.nodes} child
             JOIN ${names.edges} edge ON edge.target_node_id = child.id
             WHERE edge.namespace = $1 AND edge.source_node_id = $2
               AND edge.type = 'has_child_thread'
               AND child.namespace = $1 AND child.type = 'thread'
             FOR UPDATE OF child`,
            [namespace, id],
          );
          for (const child of children.rows) {
            await transaction.query(
              `UPDATE ${names.nodes}
               SET data = COALESCE(data, '{}'::jsonb) ||
                    '{"parentThreadId":null}'::jsonb,
                   updated_at = CURRENT_TIMESTAMP
               WHERE namespace = $1 AND id = $2 AND type = 'thread'`,
              [namespace, child.id],
            );
          }
          await transaction.query(
            `DELETE FROM ${names.nodes}
             WHERE namespace = $1 AND type = 'message'
               AND source_type = 'thread' AND source_id = $2`,
            [namespace, id],
          );
          await transaction.query(
            `DELETE FROM ${names.nodes}
             WHERE namespace = $1 AND id = $2 AND type = 'thread'`,
            [namespace, id],
          );
          return Object.freeze({ id, deleted: true as const });
        },
        recoverDuplicate: () =>
          Promise.resolve(Object.freeze({ id, deleted: true as const })),
      });
    },
    getThread(namespaceInput, idInput) {
      return readThread(
        requireText(namespaceInput, "Namespace"),
        requireText(idInput, "Thread ID"),
      );
    },
    getThreadByExternalId(namespaceInput, externalIdInput) {
      return readThreadByExternalId(
        requireText(namespaceInput, "Namespace"),
        requireText(externalIdInput, "Thread externalId"),
      );
    },
    listThreads(namespaceInput, listOptions = {}) {
      return readThreads(
        requireText(namespaceInput, "Namespace"),
        listOptions,
      );
    },
    createMessage(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const threadId = requireText(input.threadId, "Thread ID");
      const id = stableMutationId(
        "message",
        namespace,
        input.id,
        input.identity,
        createId,
      );
      const senderExternalId = requireText(
        input.sender.externalId,
        "Sender externalId",
      );
      const senderRoutingId = input.sender.id?.trim() || senderExternalId;
      const recipientIds = normalizeRecipientIds(input.recipientIds);
      return coordinator.commitMutation({
        draft: {
          type: "message.created",
          namespace,
          threadId,
          subject: { type: "message", id },
          payload: { messageId: id },
          routing: { senderId: senderRoutingId, recipientIds },
          visibility: input.visibility ?? { kind: "public" },
          ...identityDraft(input.identity),
        },
        mutate: async ({ transaction, tables: names }) => {
          const mutationContext = { transaction, tables: names };
          const thread = await findNode(
            transaction,
            names.nodes,
            namespace,
            threadId,
            "thread",
          );
          if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
          const sender = await ensureParticipant(
            transaction,
            names.nodes,
            namespace,
            { ...input.sender, externalId: senderExternalId },
          );
          const recipients: Participant[] = [];
          for (const recipientId of recipientIds) {
            const recipient = await findNode(
              transaction,
              names.nodes,
              namespace,
              recipientId,
              "participant",
            );
            if (!recipient) {
              throw new Error(`Recipient '${recipientId}' was not found.`);
            }
            recipients.push(mapParticipant(recipient));
          }
          const content = normalizeContent(
            await assets.materialize(
              mutationContext,
              { namespace, content: input.content },
            ),
          );
          const inserted = await transaction.query<NodeRow>(
            `INSERT INTO ${names.nodes} (
               id, namespace, type, name, data, source_type, source_id
             ) VALUES ($1, $2, 'message', $3, $4::jsonb, 'thread', $5)
             RETURNING *`,
            [
              id,
              namespace,
              input.sender.name ?? input.sender.externalId,
              JSON.stringify({
                threadId,
                senderId: sender.id,
                recipientIds,
                content,
                metadata: structuredClone(input.metadata ?? {}),
              }),
              threadId,
            ],
          );
          await transaction.query(
            `INSERT INTO ${names.edges} (
               id, namespace, source_node_id, target_node_id, type, data, weight
             ) VALUES
               ($1, $2, $3, $4, 'has_message', '{}', 1),
               ($5, $2, $6, $4, 'sent_by', '{}', 1)`,
            [createId(), namespace, threadId, id, createId(), sender.id],
          );
          await transaction.query(
            `INSERT INTO ${names.edges} (
               id, namespace, source_node_id, target_node_id, type, data, weight
             ) VALUES ($1, $2, $3, $4, 'participates_in', '{}', 1)
             ON CONFLICT DO NOTHING`,
            [createId(), namespace, sender.id, threadId],
          );
          for (const recipient of recipients) {
            await transaction.query(
              `INSERT INTO ${names.edges} (
                 id, namespace, source_node_id, target_node_id, type, data, weight
               ) VALUES ($1, $2, $3, $4, 'participates_in', '{}', 1)
               ON CONFLICT DO NOTHING`,
              [createId(), namespace, recipient.id, threadId],
            );
          }
          await assets.linkOwner(mutationContext, {
            namespace,
            ownerId: id,
            content,
          });
          return mapMessage(inserted.rows[0], sender);
        },
        recoverDuplicate: async (_event, { transaction, tables: names }) => {
          const expectedContent = normalizeContent(
            await assets.resolvePrepared(
              { transaction, tables: names },
              { namespace, content: input.content },
            ),
          );
          const message = await getMessageWith(
            transaction,
            names.nodes,
            namespace,
            id,
          );
          if (!message) throw new Error(`Message '${id}' was not found.`);
          if (
            canonicalJson(message.content) !== canonicalJson(expectedContent)
          ) {
            throw new Error(
              `Message deduplication identity was reused with different content: '${id}'.`,
            );
          }
          return message;
        },
      });
    },
    async reviseMessage(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const threadId = requireText(input.threadId, "Thread ID");
      const previousRevisionMessageId = requireText(
        input.messageId,
        "Message ID",
      );
      const id = stableMutationId(
        "message_revision",
        namespace,
        input.id,
        input.identity,
        createId,
      );
      const existingRevision = await getMessageWith(
        readSession,
        names.nodes,
        namespace,
        id,
      );
      const previous = existingRevision ?? await getMessageWith(
        readSession,
        names.nodes,
        namespace,
        previousRevisionMessageId,
      );
      if (!previous) {
        throw new Error(
          `Message '${previousRevisionMessageId}' was not found.`,
        );
      }
      if (previous.threadId !== threadId) {
        throw new Error(
          `Message '${previousRevisionMessageId}' does not belong to thread '${threadId}'.`,
        );
      }
      if (previous.sender.participantType !== "human") {
        throw new Error("Only human messages can be revised.");
      }
      const rootMessageId = existingRevision?.revision?.rootMessageId ??
        previous.revision?.rootMessageId ?? previous.id;
      const resolvedPreviousId = existingRevision?.revision
        ?.previousRevisionMessageId ?? previousRevisionMessageId;
      let revisionIndex = existingRevision?.revision?.revisionIndex;
      if (revisionIndex === undefined) {
        const max = await readSession.query<
          { revision_index: number | string }
        >(
          `SELECT COALESCE(MAX(
             NULLIF(data->'revision'->>'revisionIndex', '')::integer
           ), 0) AS revision_index
           FROM ${names.nodes}
           WHERE namespace = $1 AND type = 'message'
             AND data->'revision'->>'rootMessageId' = $2`,
          [namespace, rootMessageId],
        );
        revisionIndex = Number(max.rows[0]?.revision_index ?? 0) + 1;
      }
      const recipientIds = normalizeRecipientIds(previous.recipientIds);
      const eventPayload = {
        messageId: id,
        rootMessageId,
        previousRevisionMessageId: resolvedPreviousId,
        revisionIndex,
      };
      return coordinator.commitMutation<MessageRevisionResult>({
        draft: {
          type: "message.revised",
          namespace,
          threadId,
          subject: { type: "message", id },
          payload: eventPayload,
          routing: {
            senderId: previous.sender.id,
            recipientIds,
          },
          visibility: input.visibility ?? { kind: "public" },
          ...identityDraft(input.identity),
        },
        mutate: async ({ transaction, tables: names }) => {
          const lockedThread = await transaction.query<NodeRow>(
            `SELECT * FROM ${names.nodes}
             WHERE namespace = $1 AND id = $2 AND type = 'thread'
             FOR UPDATE`,
            [namespace, threadId],
          );
          if (!lockedThread.rows[0]) {
            throw new Error(`Thread '${threadId}' was not found.`);
          }
          const target = await getMessageWith(
            transaction,
            names.nodes,
            namespace,
            resolvedPreviousId,
          );
          if (!target || target.threadId !== threadId) {
            throw new Error(
              `Message '${resolvedPreviousId}' was not found in thread '${threadId}'.`,
            );
          }
          if (target.sender.participantType !== "human") {
            throw new Error("Only human messages can be revised.");
          }
          const targetRoot = target.revision?.rootMessageId ?? target.id;
          if (targetRoot !== rootMessageId) {
            throw new Error("Message revision root changed before commit.");
          }
          const max = await transaction.query<{
            revision_index: number | string;
          }>(
            `SELECT COALESCE(MAX(
               NULLIF(data->'revision'->>'revisionIndex', '')::integer
             ), 0) AS revision_index
             FROM ${names.nodes}
             WHERE namespace = $1 AND type = 'message'
               AND data->'revision'->>'rootMessageId' = $2`,
            [namespace, rootMessageId],
          );
          if (Number(max.rows[0]?.revision_index ?? 0) + 1 !== revisionIndex) {
            throw new Error(
              `Message '${rootMessageId}' was revised concurrently.`,
            );
          }
          const mutationContext = { transaction, tables: names };
          const content = normalizeContent(
            await assets.materialize(
              mutationContext,
              { namespace, content: input.content },
            ),
          );
          const metadata = {
            ...structuredClone(target.metadata),
            ...structuredClone(input.metadata ?? {}),
          };
          const inserted = await transaction.query<NodeRow>(
            `INSERT INTO ${names.nodes} (
               id, namespace, type, name, data, source_type, source_id
             ) VALUES ($1, $2, 'message', $3, $4::jsonb, 'thread', $5)
             RETURNING *`,
            [
              id,
              namespace,
              target.sender.name ?? target.sender.externalId,
              JSON.stringify({
                threadId,
                senderId: target.sender.id,
                recipientIds,
                content,
                metadata,
                revision: {
                  rootMessageId,
                  previousRevisionMessageId: resolvedPreviousId,
                  revisionIndex,
                },
              }),
              threadId,
            ],
          );
          await transaction.query(
            `INSERT INTO ${names.edges} (
               id, namespace, source_node_id, target_node_id, type, data, weight
             ) VALUES
               ($1, $2, $3, $4, 'has_message', '{}', 1),
               ($5, $2, $6, $4, 'sent_by', '{}', 1),
               ($7, $2, $4, $8, 'revises', $9::jsonb, 1)`,
            [
              createId(),
              namespace,
              threadId,
              id,
              createId(),
              target.sender.id,
              createId(),
              resolvedPreviousId,
              JSON.stringify({ rootMessageId, revisionIndex }),
            ],
          );
          await assets.linkOwner(mutationContext, {
            namespace,
            ownerId: id,
            content,
          });
          await transaction.query(
            `UPDATE ${names.nodes}
             SET data = COALESCE(data, '{}'::jsonb) || $1::jsonb,
                 updated_at = CURRENT_TIMESTAMP
             WHERE namespace = $2 AND id = $3 AND type = 'thread'`,
            [
              JSON.stringify({
                activeMessageBranch: {
                  rootMessageId,
                  headMessageId: id,
                  previousRevisionMessageId: resolvedPreviousId,
                  revisionIndex,
                },
              }),
              namespace,
              threadId,
            ],
          );
          const message = mapMessage(inserted.rows[0], target.sender);
          return Object.freeze({
            message,
            rootMessageId,
            previousRevisionMessageId: resolvedPreviousId,
            revisionIndex,
          });
        },
        recoverDuplicate: async (_event, { transaction, tables: names }) => {
          const expectedContent = normalizeContent(
            await assets.resolvePrepared(
              { transaction, tables: names },
              { namespace, content: input.content },
            ),
          );
          const message = await getMessageWith(
            transaction,
            names.nodes,
            namespace,
            id,
          );
          if (!message?.revision) {
            throw new Error(`Message revision '${id}' was not found.`);
          }
          if (
            canonicalJson(message.content) !== canonicalJson(expectedContent)
          ) {
            throw new Error(
              `Message revision identity was reused with different content: '${id}'.`,
            );
          }
          return Object.freeze({
            message,
            rootMessageId: message.revision.rootMessageId,
            previousRevisionMessageId:
              message.revision.previousRevisionMessageId,
            revisionIndex: message.revision.revisionIndex,
          });
        },
      });
    },
    deleteThreadMessages(input) {
      const namespace = requireText(input.namespace, "Namespace");
      const threadId = requireText(input.threadId, "Thread ID");
      return coordinator.commitMutation({
        draft: {
          type: "thread.messages_deleted",
          namespace,
          threadId,
          subject: { type: "thread", id: threadId },
          payload: { threadId },
          visibility: { kind: "internal" },
          ...identityDraft(input.identity),
        },
        mutate: async ({ transaction, tables: names }) => {
          const locked = await transaction.query<NodeRow>(
            `SELECT * FROM ${names.nodes}
             WHERE namespace = $1 AND id = $2 AND type = 'thread'
             FOR UPDATE`,
            [namespace, threadId],
          );
          if (!locked.rows[0]) {
            throw new Error(`Thread '${threadId}' was not found.`);
          }
          await transaction.query(
            `DELETE FROM ${names.nodes}
             WHERE namespace = $1 AND type = 'message'
               AND source_type = 'thread' AND source_id = $2`,
            [namespace, threadId],
          );
          await transaction.query(
            `UPDATE ${names.nodes}
             SET data = COALESCE(data, '{}'::jsonb) - 'activeMessageBranch',
                 updated_at = CURRENT_TIMESTAMP
             WHERE namespace = $1 AND id = $2 AND type = 'thread'`,
            [namespace, threadId],
          );
          return Object.freeze({ threadId, deleted: true as const });
        },
        recoverDuplicate: () =>
          Promise.resolve(Object.freeze({
            threadId,
            deleted: true as const,
          })),
      });
    },
    getMessage(namespaceInput, idInput) {
      return readMessage(
        requireText(namespaceInput, "Namespace"),
        requireText(idInput, "Message ID"),
      );
    },
    listMessages(namespaceInput, threadIdInput, listOptions = {}) {
      return readMessages(
        requireText(namespaceInput, "Namespace"),
        requireText(threadIdInput, "Thread ID"),
        listOptions,
      );
    },
    listMessageRevisions(namespaceInput, rootMessageIdInput) {
      return readMessageRevisions(
        requireText(namespaceInput, "Namespace"),
        requireText(rootMessageIdInput, "Root message ID"),
      );
    },
  };

  const readParticipant = async (namespace: string, id: string) => {
    const row = await findNode(
      readSession,
      names.nodes,
      namespace,
      id,
      "participant",
    );
    return row ? mapParticipant(row) : null;
  };
  const readParticipantByExternalId = async (
    namespace: string,
    externalId: string,
  ) => {
    const row = await findParticipantByExternalId(
      readSession,
      names.nodes,
      namespace,
      externalId,
    );
    return row ? mapParticipant(row) : null;
  };
  const readParticipants = async (
    namespace: string,
    listOptions: Parameters<ConversationRepository["listParticipants"]>[1] = {},
  ): Promise<readonly Participant[]> => {
    const params: unknown[] = [namespace];
    const filters = ["namespace = $1", "type = 'participant'"];
    if (listOptions.participantType) {
      params.push(participantType(listOptions.participantType));
      filters.push(`data->>'participantType' = $${params.length}`);
    }
    const after = listOptions.after?.trim();
    if (after) {
      const cursor = await readSession.query<{
        id: string;
        created_at: string | Date;
      }>(
        `SELECT id, created_at FROM ${names.nodes}
         WHERE namespace = $1 AND type = 'participant' AND id = $2
         LIMIT 1`,
        [namespace, after],
      );
      const row = cursor.rows[0];
      if (!row) {
        throw new Error(
          `Participant cursor '${after}' was not found in '${namespace}'.`,
        );
      }
      params.push(row.created_at, row.id);
      filters.push(
        `(created_at > $${params.length - 1} OR ` +
          `(created_at = $${params.length - 1} AND id > $${params.length}))`,
      );
    }
    params.push(boundedLimit(listOptions.limit));
    const result = await readSession.query<NodeRow>(
      `SELECT * FROM ${names.nodes}
       WHERE ${filters.join(" AND ")}
       ORDER BY created_at, id
       LIMIT $${params.length}`,
      params,
    );
    return Object.freeze(result.rows.map(mapParticipant));
  };
  const readThread = (
    namespace: string,
    id: string,
  ) => getThreadWith(readSession, names.nodes, names.edges, namespace, id);
  const readThreadByExternalId = async (
    namespace: string,
    externalId: string,
  ): Promise<ConversationThread | null> => {
    const row = await findThreadByExternalId(
      readSession,
      names.nodes,
      namespace,
      externalId,
    );
    return row
      ? mapThread(
        row,
        await listParticipants(
          readSession,
          names.nodes,
          names.edges,
          namespace,
          row.id,
        ),
      )
      : null;
  };
  const readThreads = async (
    namespace: string,
    listOptions: Parameters<ConversationRepository["listThreads"]>[1] = {},
  ): Promise<readonly ConversationThread[]> => {
    const params: unknown[] = [namespace];
    const filters = ["thread.namespace = $1", "thread.type = 'thread'"];
    const participantId = listOptions.participantId?.trim();
    if (participantId) {
      params.push(participantId);
      filters.push(
        `EXISTS (
          SELECT 1 FROM ${names.edges} participation
          WHERE participation.namespace = thread.namespace
            AND participation.source_node_id = $${params.length}
            AND participation.target_node_id = thread.id
            AND participation.type = 'participates_in'
        )`,
      );
    }
    const rawStatuses = listOptions.status === undefined
      ? []
      : typeof listOptions.status === "string"
      ? [listOptions.status]
      : [...listOptions.status];
    const statuses = [
      ...new Set(
        rawStatuses.map((status) => requireText(status, "Thread status")),
      ),
    ];
    if (statuses.length) {
      const placeholders = statuses.map((status) => {
        params.push(status);
        return `$${params.length}`;
      });
      filters.push(`thread.data->>'status' IN (${placeholders.join(", ")})`);
    }
    const order = listOptions.order ?? "desc";
    if (order !== "asc" && order !== "desc") {
      throw new TypeError("Thread order must be 'asc' or 'desc'.");
    }
    const direction = order.toUpperCase();
    const position =
      `COALESCE(NULLIF(thread.data->>'lastEventPosition', '')::bigint, 0)`;
    const after = listOptions.after?.trim();
    if (after) {
      const cursor = await readSession.query<{
        id: string;
        activity_position: string | number | bigint;
      }>(
        `SELECT id,
                COALESCE(NULLIF(data->>'lastEventPosition', '')::bigint, 0)
                  AS activity_position
         FROM ${names.nodes}
         WHERE namespace = $1 AND type = 'thread' AND id = $2
         LIMIT 1`,
        [namespace, after],
      );
      const row = cursor.rows[0];
      if (!row) {
        throw new Error(
          `Thread cursor '${after}' was not found in '${namespace}'.`,
        );
      }
      params.push(String(row.activity_position), row.id);
      const comparator = order === "asc" ? ">" : "<";
      filters.push(
        `(${position} ${comparator} $${params.length - 1}::bigint OR ` +
          `(${position} = $${params.length - 1}::bigint AND ` +
          `thread.id ${comparator} $${params.length}))`,
      );
    }
    params.push(boundedLimit(listOptions.limit));
    const result = await readSession.query<NodeRow>(
      `SELECT thread.* FROM ${names.nodes} thread
       WHERE ${filters.join(" AND ")}
       ORDER BY ${position} ${direction}, thread.id ${direction}
       LIMIT $${params.length}`,
      params,
    );
    const threads: ConversationThread[] = [];
    for (const row of result.rows) {
      threads.push(mapThread(
        row,
        await listParticipants(
          readSession,
          names.nodes,
          names.edges,
          namespace,
          row.id,
        ),
      ));
    }
    return Object.freeze(threads);
  };
  const readMessage = (
    namespace: string,
    id: string,
  ) => getMessageWith(readSession, names.nodes, namespace, id);
  const readMessages = async (
    namespace: string,
    threadId: string,
    listOptions: Parameters<ConversationRepository["listMessages"]>[2] = {},
  ): Promise<readonly ConversationMessage[]> => {
    const thread = await readThread(namespace, threadId);
    if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
    const view = listOptions.view ?? "active";
    if (view !== "active" && view !== "all") {
      throw new TypeError("Message view must be 'active' or 'all'.");
    }
    const result = await readSession.query<NodeRow>(
      `SELECT message.* FROM ${names.nodes} message
       JOIN ${names.edges} edge ON edge.target_node_id = message.id
       JOIN ${names.events} semantic_event
         ON semantic_event.namespace = message.namespace
        AND semantic_event.thread_id = edge.source_node_id
        AND semantic_event.type IN ('message.created', 'message.revised')
        AND semantic_event.subject_type = 'message'
        AND semantic_event.subject_id = message.id
       WHERE edge.namespace = $1 AND edge.source_node_id = $2
         AND edge.type = 'has_message'
         AND message.namespace = $1 AND message.type = 'message'
       ORDER BY semantic_event.position`,
      [namespace, threadId],
    );
    const messages: ConversationMessage[] = [];
    for (const row of result.rows) {
      const mapped = await getMessageWith(
        readSession,
        names.nodes,
        namespace,
        row.id,
      );
      if (mapped) messages.push(mapped);
    }
    const projected = view === "all"
      ? Object.freeze(messages)
      : projectActiveMessageBranch(messages, thread.activeMessageBranch);
    const after = listOptions.after?.trim();
    let offset = 0;
    if (after) {
      const cursor = projected.findIndex((message) => message.id === after);
      if (cursor < 0) {
        throw new Error(
          `Message cursor '${after}' was not found in the ${view} history for thread '${threadId}'.`,
        );
      }
      offset = cursor + 1;
    }
    return Object.freeze(
      projected.slice(offset, offset + boundedLimit(listOptions.limit)),
    );
  };
  const readMessageRevisions = async (
    namespace: string,
    rootMessageId: string,
  ): Promise<readonly ConversationMessage[]> => {
    const candidate = await readMessage(namespace, rootMessageId);
    if (!candidate) return Object.freeze([]);
    const root = candidate.revision?.rootMessageId ?? candidate.id;
    const messages = await readMessages(namespace, candidate.threadId, {
      view: "all",
      limit: 1_000,
    });
    return Object.freeze(
      messages.filter((message) =>
        message.id === root || message.revision?.rootMessageId === root
      ),
    );
  };

  return Object.freeze(repository);
}
