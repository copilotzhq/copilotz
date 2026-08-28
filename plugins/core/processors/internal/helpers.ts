/** Shares Message, participant, and Tool projection helpers across Core Processors. @module */

import type {
  CollectionRecord,
  ScopedCollection,
} from "@copilotz/copilotz/collections";
import type { ContentSequence } from "@copilotz/copilotz/content";
import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "../../../core-collections/internal/contracts.ts";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type { ToolResource } from "@copilotz/copilotz/tools";
import type { AgentResource } from "../../resources/agent/index.ts";
import type { CoreResources } from "../../internal/runtime-context.ts";
import { resolveToolGrants } from "../../internal/capabilities/grants.ts";
import type { MessageBranch } from "../../../core-collections/internal/contracts.ts";
import { projectActiveMessageBranch } from "../../../core-collections/internal/projections.ts";
import { coreToolResultOrigin } from "../../internal/workflow-metadata.ts";

export type CoreToolEntry = Readonly<{
  alias: string;
  resource: ToolResource;
}>;

export function requiredText(value: string | undefined, name: string): string {
  const normalized = value?.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter((item): item is string =>
      typeof item === "string" && Boolean(item.trim())
    ),
  );
}

export function requireCollection<T extends CollectionRecord>(
  context: Pick<ProcessorContext, "collections">,
  name: string,
): ScopedCollection<T> {
  const bound = context.collections[name] as ScopedCollection<T> | undefined;
  if (!bound) throw new Error(`Collection '${name}' is not bound.`);
  return bound;
}

export function collectionEventRecord(
  event: { data?: unknown },
): CollectionRecord {
  const data = asRecord(event.data);
  const record = asRecord(data.record);
  if (!record.id) throw new Error("Collection event is missing data.record.");
  return record as CollectionRecord;
}

export function mapParticipant(record: CollectionRecord): Participant {
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

export function mapMessage(
  record: CollectionRecord,
  sender: Participant,
): ConversationMessage {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    threadId: String(record.threadId),
    sender,
    recipientIds: stringArray(record.recipientIds),
    content:
      (Array.isArray(record.content) ? record.content : []) as ContentSequence,
    metadata: asRecord(record.metadata),
    ...(record.revision && typeof record.revision === "object"
      ? { revision: record.revision as ConversationMessage["revision"] }
      : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

export function mapThread(
  record: CollectionRecord,
  participants: readonly Participant[],
): ConversationThread {
  return Object.freeze({
    id: String(record.id),
    namespace: String(record.namespace),
    ...(optionalText(record.externalId)
      ? { externalId: optionalText(record.externalId) }
      : {}),
    ...(optionalText(record.name) ? { name: optionalText(record.name) } : {}),
    status: String(record.status ?? "active"),
    metadata: asRecord(record.metadata),
    participants,
    ...(record.activeMessageBranch &&
        typeof record.activeMessageBranch === "object"
      ? {
        activeMessageBranch: record
          .activeMessageBranch as ConversationThread["activeMessageBranch"],
      }
      : {}),
    createdAt: String(record.createdAt),
    updatedAt: String(record.updatedAt),
  });
}

export function participantAgentId(participant: CollectionRecord): string {
  return optionalText(participant.agentId) ??
    String(participant.externalId ?? participant.id);
}

export function participantInput(participant: CollectionRecord) {
  return {
    id: String(participant.id),
    externalId: String(participant.externalId ?? participant.id),
    participantType: participant
      .participantType as Participant["participantType"],
    ...(optionalText(participant.name)
      ? { name: optionalText(participant.name) }
      : {}),
    ...(optionalText(participant.email)
      ? { email: optionalText(participant.email) }
      : {}),
    ...(optionalText(participant.agentId)
      ? { agentId: optionalText(participant.agentId) }
      : {}),
    metadata: structuredClone(asRecord(participant.metadata)),
  } as const;
}

export async function listThreadMessages(
  context: Pick<ProcessorContext, "collections">,
  threadId: string,
  options: Readonly<{ historyScopeId?: string }> = {},
): Promise<readonly CollectionRecord[]> {
  const threads = requireCollection(context, "thread");
  const messages = requireCollection(context, "message");
  const thread = await threads.get({ id: threadId });
  const records = (await messages.list({
    where: { threadId },
    order: { field: "createdAt", direction: "asc" },
    limit: 1_000,
  })).filter((record) => {
    const scope = optionalText(record.historyScopeId);
    const visibility = asRecord(record.visibility);
    if (!scope) return visibility.kind !== "internal";
    return scope === options.historyScopeId && visibility.kind === "internal";
  });
  return orderToolPlanResults(projectActiveMessageBranch(
    records,
    thread?.activeMessageBranch as MessageBranch | undefined,
  ));
}

/**
 * A plan may settle in any wall-clock order (and clocks may share a tick), but
 * its provider transcript is declared order. Keep each plan's projected root
 * results contiguous at its first message position and order by durable cursor.
 */
export function orderToolPlanResults(
  records: readonly CollectionRecord[],
): readonly CollectionRecord[] {
  const groups = new Map<string, CollectionRecord[]>();
  const first = new Map<string, number>();
  records.forEach((entry, index) => {
    const cursor = coreToolResultOrigin(entry.metadata);
    if (!cursor) return;
    const bucket = groups.get(cursor.planId) ?? [];
    bucket.push(entry);
    groups.set(cursor.planId, bucket);
    if (!first.has(cursor.planId)) first.set(cursor.planId, index);
  });
  for (const bucket of groups.values()) {
    bucket.sort((left, right) =>
      coreToolResultOrigin(left.metadata)!.planIndex -
      coreToolResultOrigin(right.metadata)!.planIndex
    );
  }
  const emitted = new Set<string>();
  const result: CollectionRecord[] = [];
  records.forEach((entry, index) => {
    const cursor = coreToolResultOrigin(entry.metadata);
    if (!cursor) {
      result.push(entry);
      return;
    }
    if (first.get(cursor.planId) !== index || emitted.has(cursor.planId)) {
      return;
    }
    emitted.add(cursor.planId);
    result.push(...(groups.get(cursor.planId) ?? []));
  });
  return Object.freeze(result);
}

/** Resolves one Agent's least-authority Tool Resources in stable grant order. */
export function toolsForAgent(
  context:
    & Pick<ProcessorContext, "actions">
    & Readonly<{
      resources: CoreResources;
    }>,
  agent: AgentResource,
): readonly CoreToolEntry[] {
  const entries = Object.entries(context.resources.tools ?? {}).flatMap(
    ([alias, resource]): readonly CoreToolEntry[] => {
      if (!resource) return Object.freeze([]);
      if (resource.action !== alias) {
        throw new TypeError(
          `Tool Resource '${alias}' must reference Action alias '${alias}'.`,
        );
      }
      if (
        typeof resource.name !== "string" || !resource.name.trim() ||
        typeof resource.description !== "string" ||
        !resource.description.trim()
      ) {
        throw new TypeError(
          `Tool Resource '${alias}' requires a name and description.`,
        );
      }
      if (typeof context.actions[alias] !== "function") {
        throw new Error(
          `Tool Resource '${alias}' has no composed Action '${alias}'.`,
        );
      }
      return Object.freeze([Object.freeze({ alias, resource })]);
    },
  );
  return resolveToolGrants(agent, entries, {
    agents: Object.values(context.resources.agents ?? {}).filter(
      (value): value is AgentResource => Boolean(value),
    ),
    skills: Object.values(context.resources.skills ?? {}).filter(
      (value): value is NonNullable<typeof value> => Boolean(value),
    ),
  });
}

export async function loadParticipant(
  context: Pick<ProcessorContext, "collections">,
  id: string,
): Promise<CollectionRecord | null> {
  return await requireCollection(context, "participant").get({ id });
}
