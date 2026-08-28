/** Resolves scheduled-message recipient selections deterministically. @module */

import type { ActionContext } from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { CoreResources } from "../../core/internal/runtime-context.ts";
import { coreToolActionMetadata } from "../../core/internal/workflow-metadata.ts";
import type { CoreScheduledMessageThread } from "./contracts.ts";

export type CoreScheduledAgent = NonNullable<
  CoreResources["agents"][string]
>;

export type ScheduledRecipientSelection =
  | "caller"
  | "all"
  | readonly string[];

type ScheduledRecipientContext = Pick<
  ActionContext<CoreResources>,
  "action" | "collections" | "resources"
>;

/** Resolves an exact alias/id or one unambiguous display name. */
export function resolveConfiguredScheduledAgent(
  reference: string,
  agents: CoreResources["agents"],
): CoreScheduledAgent | null {
  const direct = agents[reference] ??
    Object.values(agents).find((agent) => agent?.id === reference);
  if (direct) return direct;

  const normalizedName = reference.toLowerCase();
  const named = new Map(
    Object.values(agents)
      .filter((agent): agent is CoreScheduledAgent =>
        agent?.name.toLowerCase() === normalizedName
      )
      .map((agent) => [agent.id, agent]),
  );
  if (named.size > 1) {
    throw new Error(`Scheduled recipient '${reference}' is ambiguous.`);
  }
  return named.values().next().value ?? null;
}

async function byExternalId(
  context: ScheduledRecipientContext,
  collection: "participant" | "thread",
  externalId: string,
): Promise<CollectionRecord | null> {
  const values = await context.collections[collection].queries.byExternalId({
    externalId,
  });
  return values[0] ?? null;
}

async function existingThread(
  descriptor: CoreScheduledMessageThread | undefined,
  context: ScheduledRecipientContext,
): Promise<CollectionRecord | null> {
  if (descriptor?.id) {
    return await context.collections.thread.get({ id: descriptor.id });
  }
  if (descriptor?.externalId) {
    return await byExternalId(context, "thread", descriptor.externalId);
  }
  return null;
}

async function canonicalRecipient(
  reference: string,
  context: ScheduledRecipientContext,
): Promise<string> {
  const id = reference.trim();
  if (!id) throw new TypeError("Scheduled recipient must be non-empty.");
  const participant = await context.collections.participant.get({ id }) ??
    await byExternalId(context, "participant", id);
  if (participant) return String(participant.id);
  const agent = resolveConfiguredScheduledAgent(
    id,
    context.resources.agents ?? {},
  );
  if (agent) return agent.id;
  throw new TypeError(`Scheduled recipient '${id}' was not found.`);
}

/** Resolves one authoring selection to a creation-time canonical snapshot. */
export async function resolveScheduledRecipientSelection(
  selection: ScheduledRecipientSelection,
  threadDescriptor: CoreScheduledMessageThread | undefined,
  context: ScheduledRecipientContext,
): Promise<readonly string[]> {
  if (selection === "caller") {
    const metadata = coreToolActionMetadata(context.action.metadata);
    if (!metadata) {
      throw new TypeError(
        "The caller recipient requires trusted Core Tool provenance.",
      );
    }
    const caller = await context.collections.participant.get({
      id: metadata.agentParticipantId,
    });
    if (!caller || caller.participantType !== "agent") {
      throw new TypeError("The scheduled job caller is not an Agent.");
    }
    return Object.freeze([String(caller.id)]);
  }

  if (selection === "all") {
    const thread = await existingThread(threadDescriptor, context);
    if (!thread) {
      throw new TypeError(
        "All scheduled recipients require an existing thread.",
      );
    }
    const participantIds = Array.isArray(thread.participantIds)
      ? thread.participantIds.filter((value): value is string =>
        typeof value === "string"
      )
      : [];
    const participants = await Promise.all(
      participantIds.map((id) => context.collections.participant.get({ id })),
    );
    const agentIds = participants
      .filter((value): value is CollectionRecord =>
        value !== null && value.participantType === "agent"
      )
      .map((value) => String(value.id));
    if (agentIds.length === 0) {
      throw new TypeError("The scheduled thread has no Agent participants.");
    }
    return Object.freeze([...new Set(agentIds)]);
  }

  return Object.freeze([
    ...new Set(
      await Promise.all(
        selection.map((reference) => canonicalRecipient(reference, context)),
      ),
    ),
  ]);
}
