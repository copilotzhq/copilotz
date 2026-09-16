import { asRecord } from "./validation.ts";
export { asRecord, requiredText } from "./validation.ts";
/** Shares Message, participant, and Tool projection helpers across Core Processors. @module */

import type {
  CollectionRecord,
  ScopedCollection,
} from "@copilotz/copilotz/collections";

import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "./contracts.ts";
import {
  loadThreadMessageRecordWindow,
  mapMessageRecord,
  mapParticipantRecord,
  mapThreadRecord,
  threadMessageRecordInWindow,
} from "./projections.ts";
import type { ProcessorContext } from "@copilotz/copilotz/plugins";
import type { ToolResource } from "@copilotz/copilotz/core";
import type { AgentResource } from "../authoring/define-agent/index.ts";
import type { CoreResources } from "./runtime-context.ts";
import { resolveToolGrants } from "./capabilities/grants.ts";

export type CoreToolEntry = Readonly<{
  alias: string;
  resource: ToolResource;
}>;

/** One causally complete, chronological Core history selection. */
export type CoreThreadMessageSnapshot = Readonly<{
  active: boolean;
  thread: ConversationThread;
  participantRecords: readonly CollectionRecord[];
  records: readonly CollectionRecord[];
  messages: readonly ConversationMessage[];
}>;

/** Reads only thread/participant metadata so context can certify a lower bound before tail selection. */
export async function loadCoreThreadMetadata(
  context: Pick<ProcessorContext, "collections">,
  threadId: string,
): Promise<
  Readonly<
    {
      thread: ConversationThread;
      participantRecords: readonly CollectionRecord[];
    }
  >
> {
  const thread = await requireCollection(context, "thread").get({
    id: threadId,
  });
  if (!thread) throw new Error(`Thread '${threadId}' was not found.`);
  const participantRecords = (await Promise.all(
    stringArray(thread.participantIds)
      .map((id) => requireCollection(context, "participant").get({ id })),
  ))
    .filter((item): item is CollectionRecord => Boolean(item));
  return ({
    thread: mapThreadRecord(
      thread,
      participantRecords.map(mapParticipantRecord),
    ),
    participantRecords: participantRecords,
  } as const);
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return ([] as const);
  return (value.filter((item): item is string =>
    typeof item === "string" && Boolean(item.trim())
  ));
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

export function participantAgentId(participant: CollectionRecord): string {
  return optionalText(participant.agentId) ??
    String(participant.externalId ?? participant.id);
}

/**
 * Selects the complete latest authorized history. The trigger is validated as
 * an active branch member, but never determines the history end.
 */
export async function loadCoreThreadMessageSnapshot(
  context: Pick<ProcessorContext, "collections">,
  threadId: string,
  trigger: CollectionRecord,
  options: Readonly<
    {
      historyScopeId?: string;
      internalOnly?: boolean;
      afterMessageId?: string;
      /** Exact inclusive range used to verify a reserved memory source. */
      range?: Readonly<{ startMessageId: string; endMessageId: string }>;
      viewerIds?: readonly string[];
    }
  > = {},
): Promise<CoreThreadMessageSnapshot> {
  const messages = requireCollection(context, "message");
  const boundary = options.afterMessageId
    ? await messages.get({ id: options.afterMessageId })
    : null;
  if (
    options.afterMessageId &&
    (!boundary || String(boundary.threadId) !== threadId)
  ) {
    throw new Error("Certified history boundary is no longer available.");
  }
  const start = options.range
    ? await messages.get({ id: options.range.startMessageId })
    : null;
  const end = options.range
    ? await messages.get({ id: options.range.endMessageId })
    : null;
  if (
    options.range &&
    (!start || !end || start.threadId !== threadId || end.threadId !== threadId)
  ) {
    throw new Error("Memory source range is no longer available.");
  }
  const window = await loadThreadMessageRecordWindow(context, threadId, {
    ...(start && end ? { from: start, anchor: end } : {}),
    ...(options.historyScopeId
      ? { historyScopeId: options.historyScopeId }
      : {}),
    ...(options.viewerIds ? { viewerIds: options.viewerIds } : {}),
    ...(options.internalOnly ? { internalOnly: true } : {}),
    ...(boundary ? { after: boundary } : {}),
  });
  const currentTrigger = await messages.get({ id: String(trigger.id) });
  const active = window.anchorActive && Boolean(
    currentTrigger &&
      String(currentTrigger.createdAt) === String(trigger.createdAt) &&
      threadMessageRecordInWindow(
        { ...window, after: undefined },
        currentTrigger,
      ),
  );
  const records = active ? window.records : [];
  const participantRecords = new Map(
    window.participantRecords.map((record) => [String(record.id), record]),
  );
  const missingSenderIds = new Set(
    records.map((record) => String(record.senderId)).filter((id) =>
      !participantRecords.has(id)
    ),
  );
  const missingSenders = await Promise.all(
    [...missingSenderIds].map((id) =>
      requireCollection(context, "participant").get({ id })
    ),
  );
  for (const sender of missingSenders) {
    if (sender) participantRecords.set(String(sender.id), sender);
  }
  const mappedParticipants = new Map(
    [...participantRecords].map(([id, record]) => [
      id,
      mapParticipantRecord(record),
    ]),
  );
  const threadParticipants = stringArray(window.threadRecord.participantIds)
    .map((id) => mappedParticipants.get(id))
    .filter((participant): participant is Participant => Boolean(participant));
  const thread = mapThreadRecord(window.threadRecord, threadParticipants);
  const hydrated = records.map((record) => {
    const sender = mappedParticipants.get(String(record.senderId));
    if (!sender) {
      throw new Error(`Message '${record.id}' sender was not found.`);
    }
    return ({
      ...mapMessageRecord(record, sender),
      ...(record.visibility === undefined
        ? {}
        : { visibility: structuredClone(asRecord(record.visibility)) }),
    } as const);
  });
  return ({
    active,
    thread,
    participantRecords: [...participantRecords.values()] as const,
    records,
    messages: hydrated,
  } as const);
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
      if (!resource) return ([] as const);
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
      return ([{ alias, resource } as const] as const);
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
