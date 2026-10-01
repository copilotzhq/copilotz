/** Projects typed Core Message inputs through the storage Action. @module */

import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  defineProcessor,
  type Processor,
  type ProcessorEvent,
} from "@copilotz/copilotz/plugins";
import type { ParticipantInput } from "../../shared/contracts.ts";
import type { CoreProcessorContext } from "../../shared/runtime-context.ts";
import { CORE_MESSAGE_INPUT_EVENT } from "./input/index.ts";

type MembershipRecipient =
  | Readonly<{ externalId: string }>
  | Readonly<{
    participantId: string;
  }>;

type RecipientSelection = Readonly<{
  recipientIds: readonly string[];
  membershipParticipants: readonly ParticipantInput[];
  membershipRecipients: readonly MembershipRecipient[];
  newParticipants: readonly ParticipantInput[];
}>;

type SenderResolution = Readonly<{
  participant: ParticipantInput;
  isNew: boolean;
}>;

type ThreadResolution = Readonly<{
  id: string;
  bootstrap?: Readonly<{ id: string; externalId?: string }>;
}>;

type DurableProcessorEvent = Extract<ProcessorEvent, { durable: true }>;

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

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return ([] as const);
  return (value.filter((item): item is string =>
    typeof item === "string" && Boolean(item.trim())
  ).map((item) => item.trim()));
}

async function scopedRecordId(
  namespace: string,
  kind: "thread" | "participant",
  externalId: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(
    JSON.stringify([
      "copilotz.core.message-input",
      namespace,
      kind,
      externalId,
    ]),
  );
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = [...digest].map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `core-${kind}-${hex}`;
}

async function findThread(
  context: CoreProcessorContext,
  idOrExternalId: string,
): Promise<CollectionRecord | null> {
  const threads = context.collections.thread;
  if (!threads) throw new Error("Collection 'thread' is not bound.");
  const byId = await threads.get({ id: idOrExternalId });
  if (byId) return byId;
  if (threads.queries.byExternalId) {
    return (await threads.queries.byExternalId({
      externalId: idOrExternalId,
    }))[0] ?? null;
  }
  return null;
}

async function resolveThread(
  context: CoreProcessorContext,
  value: unknown,
): Promise<ThreadResolution> {
  if (typeof value === "string") {
    const idOrExternalId = requireText(value, "Message thread");
    const existing = await findThread(context, idOrExternalId);
    // String references keep their established behavior: the message Action
    // reports the missing Thread instead of creating one implicitly.
    return ({ id: existing?.id ?? idOrExternalId } as const);
  }

  const item = record(value);
  const id = optionalText(item.id);
  const externalId = optionalText(item.externalId);
  const lookup = id ?? externalId;
  if (!lookup) throw new TypeError("Message thread requires id or externalId.");
  const existingById = id ? await context.collections.thread.get({ id }) : null;
  const existing = existingById ??
    (externalId
      ? (context.collections.thread.queries.byExternalId
        ? (await context.collections.thread.queries.byExternalId({
          externalId,
        }))[0] ?? null
        : null)
      : null);
  if (existing) return ({ id: existing.id } as const);

  const bootstrapId = id ?? await scopedRecordId(
    context.namespace,
    "thread",
    externalId!,
  );
  return ({
    id: bootstrapId,
    bootstrap: {
      id: bootstrapId,
      ...(externalId ? { externalId } : {}),
    },
  } as const);
}

async function resolveParticipantRecord(
  context: CoreProcessorContext,
  value: string,
): Promise<CollectionRecord | null> {
  const participants = context.collections.participant;
  if (!participants) throw new Error("Collection 'participant' is not bound.");
  const byId = await participants.get({ id: value });
  if (byId) return byId;
  if (participants.queries.byExternalId) {
    return (await participants.queries.byExternalId({ externalId: value }))[
      0
    ] ??
      null;
  }
  return null;
}

function participantRecordInput(item: CollectionRecord): ParticipantInput {
  return ({
    id: String(item.id),
    externalId: String(item.externalId ?? item.id),
    participantType: String(item.participantType) as ParticipantInput[
      "participantType"
    ],
    ...(optionalText(item.name) ? { name: optionalText(item.name) } : {}),
    ...(optionalText(item.email) ? { email: optionalText(item.email) } : {}),
    ...(optionalText(item.agentId)
      ? { agentId: optionalText(item.agentId) }
      : {}),
    metadata: record(item.metadata),
  } as const);
}

async function resolveSender(
  context: CoreProcessorContext,
  value: unknown,
): Promise<SenderResolution> {
  const input = participant(value);
  const id = optionalText(input.id);
  const externalId = optionalText(input.externalId) ?? id;
  const participants = context.collections.participant;
  if (!participants) throw new Error("Collection 'participant' is not bound.");
  const existingById = id ? await participants.get({ id }) : null;
  const existingByExternal = !existingById && externalId &&
      participants.queries.byExternalId
    ? (await participants.queries.byExternalId({ externalId }))[0] ?? null
    : null;
  const existing = existingById ?? existingByExternal;
  if (existing) {
    return ({ participant: participantRecordInput(existing), isNew: false });
  }
  if (!externalId) {
    throw new TypeError("Message participant requires id or externalId.");
  }
  const participantType = optionalText(input.participantType);
  if (
    !participantType ||
    !["human", "agent", "tool", "job"].includes(participantType)
  ) {
    throw new TypeError(
      "Sender participantType must be human, agent, tool, or job.",
    );
  }
  const canonicalSender: ParticipantInput = {
    ...(id && typeof value !== "string" ? { id } : {
      id: await scopedRecordId(context.namespace, "participant", externalId),
    }),
    externalId,
    participantType: participantType as ParticipantInput["participantType"],
    ...(optionalText(input.name) ? { name: optionalText(input.name) } : {}),
    ...(optionalText(input.email) ? { email: optionalText(input.email) } : {}),
    ...(optionalText(input.agentId)
      ? { agentId: optionalText(input.agentId) }
      : {}),
    metadata: record(input.metadata),
  } as const;
  return ({ participant: canonicalSender, isNew: true } as const);
}

function configuredAgent(
  context: CoreProcessorContext,
  reference: string,
): { id: string; name: string } | undefined {
  for (const [alias, agent] of Object.entries(context.resources.agents ?? {})) {
    if (agent && (alias === reference || agent.id === reference)) {
      return { id: agent.id, name: agent.name };
    }
  }
  return undefined;
}

async function defaultRecipientIds(
  context: CoreProcessorContext,
  threadId: string | undefined,
  senderInput: unknown,
): Promise<readonly string[]> {
  if (!threadId) return ([] as const);
  const thread = await context.collections.thread.get({ id: threadId });
  if (!thread) return ([] as const);
  const sender = typeof senderInput === "string"
    ? await resolveParticipantRecord(context, optionalText(senderInput) ?? "")
    : await resolveParticipantRecord(
      context,
      optionalText(record(senderInput).id) ??
        optionalText(record(senderInput).externalId) ?? "",
    );
  const senderId = optionalText(sender?.id);
  const participantIds = stringArray(thread.participantIds);
  const participants = await Promise.all(
    participantIds.map((id) => context.collections.participant.get({ id })),
  );
  return (participants
    .filter((item): item is CollectionRecord => item !== null)
    .filter((item) =>
      item.participantType === "agent" && optionalText(item.id) !== senderId
    )
    .map((item) => String(item.id)));
}

async function resolveRecipients(
  context: CoreProcessorContext,
  value: unknown,
  threadId: string | undefined,
  senderInput: unknown,
  rejectUnknown: boolean,
): Promise<RecipientSelection> {
  if (!Array.isArray(value)) {
    return ({
      recipientIds: await defaultRecipientIds(context, threadId, senderInput),
      membershipParticipants: [],
      membershipRecipients: [],
      newParticipants: [],
    } as const);
  }

  const recipientIds: string[] = [];
  const membershipParticipants = new Map<string, ParticipantInput>();
  const membershipRecipients: MembershipRecipient[] = [];
  const newParticipants: ParticipantInput[] = [];
  const seenRecipients = new Set<string>();
  const seenAgentRecipients = new Set<string>();

  for (const reference of stringArray(value)) {
    if (seenRecipients.has(reference)) continue;
    seenRecipients.add(reference);

    // A real participant reference wins over resource name matching. This
    // preserves human/tool/job types when their external IDs resemble aliases.
    const existing = await resolveParticipantRecord(context, reference);
    if (existing) {
      membershipParticipants.set(
        String(existing.id),
        participantRecordInput(existing),
      );
      membershipRecipients.push({ participantId: String(existing.id) });
      recipientIds.push(String(existing.id));
      continue;
    }

    const agent = configuredAgent(context, reference);
    if (!agent) {
      if (rejectUnknown) {
        throw new Error(`Message recipient '${reference}' was not found.`);
      }
      recipientIds.push(reference);
      continue;
    }

    if (seenAgentRecipients.has(agent.id)) continue;
    seenAgentRecipients.add(agent.id);
    const canonical = await resolveParticipantRecord(context, agent.id);
    if (canonical && canonical.participantType !== "agent") {
      throw new Error(
        `Agent '${agent.id}' conflicts with an existing non-agent participant.`,
      );
    }
    if (
      !canonical &&
      optionalText(record(senderInput).externalId) === agent.id &&
      record(senderInput).participantType !== "agent"
    ) {
      throw new Error(
        `Agent '${agent.id}' conflicts with the message sender external ID.`,
      );
    }

    if (canonical) {
      membershipParticipants.set(
        String(canonical.id),
        participantRecordInput(canonical),
      );
      membershipRecipients.push({ participantId: String(canonical.id) });
      recipientIds.push(String(canonical.id));
      continue;
    }

    const participant: ParticipantInput = {
      id: await scopedRecordId(context.namespace, "participant", agent.id),
      externalId: agent.id,
      participantType: "agent",
      agentId: agent.id,
      name: agent.name,
    };
    membershipParticipants.set(agent.id, participant);
    newParticipants.push(participant);
    membershipRecipients.push({ externalId: agent.id });
  }

  return ({
    recipientIds: [...new Set(recipientIds)],
    membershipParticipants: [...membershipParticipants.values()],
    membershipRecipients,
    newParticipants,
  } as const);
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

async function createOrReuseThread(
  context: CoreProcessorContext,
  bootstrap: NonNullable<ThreadResolution["bootstrap"]>,
): Promise<string> {
  try {
    const created = await context.actions.createThread({
      id: bootstrap.id,
      ...(bootstrap.externalId ? { externalId: bootstrap.externalId } : {}),
      participants: [],
      metadata: {},
    }, { operationKey: "core-message-input-thread-bootstrap" }) as {
      id: string;
    };
    return created.id;
  } catch (error) {
    // Collection IDs are globally unique across namespaces. For a generated
    // external-ID reference, accept the same canonical record after a
    // concurrent creator commits, while preserving unrelated failures.
    const existing = await context.collections.thread.get({ id: bootstrap.id });
    if (
      existing &&
      (bootstrap.externalId === undefined ||
        existing.externalId === bootstrap.externalId)
    ) return existing.id;
    throw error;
  }
}

async function projectMessage(
  event: DurableProcessorEvent,
  context: CoreProcessorContext,
  input: Record<string, unknown>,
  thread: ThreadResolution,
  sender: SenderResolution,
  rejectUnknownRecipients: boolean,
): Promise<void> {
  const recipients = await resolveRecipients(
    context,
    input.recipientIds,
    thread.bootstrap ? undefined : thread.id,
    sender.participant,
    rejectUnknownRecipients,
  );

  const threadId = thread.bootstrap
    ? await createOrReuseThread(context, thread.bootstrap)
    : thread.id;
  const membership = recipients.membershipParticipants.length ||
      recipients.membershipRecipients.length
    ? {
      participants: recipients.membershipParticipants,
      recipients: recipients.membershipRecipients,
    }
    : undefined;
  const messageId = optionalText(input.id) ?? event.id;
  const actionInput = {
    id: messageId,
    threadId,
    sender: sender.participant,
    recipientIds: [...recipients.recipientIds],
    ...(membership ? { membership } : {}),
    content: input.content ?? [],
    metadata: record(input.metadata),
    ...(input.visibility ? { visibility: record(input.visibility) } : {}),
  } as const;
  const actionOptions = {
    operationKey: "core-message-input",
    identity: {
      causationId: event.id,
      correlationId: event.correlationId,
      deduplicationId: event.deduplicationId,
      settlementScopeId: event.id,
    },
  } as const;
  try {
    await context.actions.createThreadMessage(actionInput, actionOptions);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    const missedAtPlan = [
      ...(sender.isNew ? [sender.participant] : []),
      ...recipients.newParticipants,
    ];
    const racedParticipant = missedAtPlan.find((item) =>
      text ===
        `Collection 'participant' '${item.id}' was created while its mutation was prepared.`
    );
    const racedThread = text ===
      `Collection 'thread' '${threadId}' changed while its mutation was prepared.`;
    if (!racedParticipant && !racedThread) throw error;

    const alreadyCreated = await context.collections.message?.get({
      id: messageId,
    });
    if (alreadyCreated) return;
    if (racedParticipant) {
      const matchesExpected = async (item: ParticipantInput) => {
        const stored = item.id
          ? await context.collections.participant.get({ id: item.id })
          : null;
        return Boolean(
          stored && stored.externalId === item.externalId &&
            stored.participantType === item.participantType &&
            (item.agentId === undefined || stored.agentId === item.agentId),
        );
      };
      if (!(await matchesExpected(racedParticipant))) throw error;
      // The competing transaction may have committed only the shared record;
      // this failed transaction was atomic, so absent private participants
      // remain safe to create on the single bounded retry.
      for (const item of missedAtPlan) {
        if (item.id === racedParticipant.id) continue;
        const stored = item.id
          ? await context.collections.participant.get({ id: item.id })
          : null;
        if (stored && !(await matchesExpected(item))) throw error;
      }
    }
    const currentThread = await context.collections.thread.get({
      id: threadId,
    });
    if (!currentThread) throw error;
    await context.actions.createThreadMessage(actionInput, {
      ...actionOptions,
      operationKey: `core-message-input-retry:${event.id}`,
    });
  }
}

export const messageInputProcessor: Processor<CoreProcessorContext> =
  defineProcessor<CoreProcessorContext>({
    id: "copilotz.core.message-input",
    on: [{ eventType: CORE_MESSAGE_INPUT_EVENT }],
    async handle(event, context) {
      if (!event.durable) return;
      const input = record(event.payload);
      const sender = await resolveSender(context, input.participant);
      const thread = await resolveThread(context, input.thread);
      await projectMessage(
        event,
        context,
        input,
        thread,
        sender,
        typeof input.thread !== "string",
      );
    },
  });

export default messageInputProcessor;
