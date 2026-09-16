/** Shared participant resolution for built-in participant Tools.
 *
 * @module
 */

import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { ParticipantInput } from "@copilotz/copilotz/core";
import type { ActionContext } from "@copilotz/copilotz/actions";
import { optionalText, record } from "./input.ts";

export function metadataText(
  context: ActionContext,
  key: string,
): string | undefined {
  return optionalText(context.action.metadata[key]);
}

export async function participantByExternalId(
  context: ActionContext,
  externalId: string,
): Promise<CollectionRecord | null> {
  return (await context.collections.participant.queries.byExternalId({
    externalId,
  }))[0] ?? null;
}

export async function loadCallerParticipant(
  context: ActionContext,
): Promise<CollectionRecord | null> {
  const participantId = metadataText(context, "agentParticipantId") ??
    metadataText(context, "participantId");
  if (participantId) {
    return await context.collections.participant.get({ id: participantId });
  }
  const agentId = metadataText(context, "agentId");
  return agentId ? await participantByExternalId(context, agentId) : null;
}

export function participantInput(
  participant: CollectionRecord,
): ParticipantInput {
  const metadata = record(participant.metadata);
  return ({
    id: participant.id,
    externalId: String(participant.externalId ?? participant.id),
    participantType: participant
      .participantType as ParticipantInput["participantType"],
    ...(typeof participant.name === "string" && participant.name
      ? { name: participant.name }
      : {}),
    ...(typeof participant.email === "string" && participant.email
      ? { email: participant.email }
      : {}),
    ...(typeof participant.agentId === "string" && participant.agentId
      ? { agentId: participant.agentId }
      : {}),
    metadata: structuredClone(metadata),
  } as const);
}
