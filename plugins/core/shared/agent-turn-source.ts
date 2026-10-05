/** Verifies an immutable private source reference using the existing history batch. */
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { encodeContent, isContentRef } from "@copilotz/copilotz/content/codec";
import { digestContent } from "@copilotz/copilotz/content";
import {
  type CoreAgentTurnMetadata,
  coreAgentTurnMetadata,
} from "./workflow-metadata.ts";

export async function agentTurnSourceDigest(
  source: NonNullable<CoreAgentTurnMetadata["sourceHistory"]>,
): Promise<string> {
  // PostgreSQL JSON objects may reorder keys; arrays retain their exact order.
  const text = JSON.stringify(source, (_key, value) => {
    const canonical = isContentRef(value) ? encodeContent(value) : value;
    return canonical && typeof canonical === "object" &&
        !Array.isArray(canonical)
      ? Object.fromEntries(
        Object.entries(canonical).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        ),
      )
      : canonical;
  });
  return await digestContent(new TextEncoder().encode(text));
}

export async function resolveAgentTurnSource(
  turn: CoreAgentTurnMetadata,
  records: readonly CollectionRecord[],
  input: Readonly<
    { namespace: string; threadId: string; participantId: string }
  >,
): Promise<CoreAgentTurnMetadata["sourceHistory"]> {
  if (!turn.sourceHistoryRef) return turn.sourceHistory;
  const root = records.find((item) =>
    item.id === turn.sourceHistoryRef!.messageId
  );
  const rootTurn = root ? coreAgentTurnMetadata(root.metadata) : null;
  if (
    !root || root.namespace !== input.namespace ||
    root.threadId !== input.threadId ||
    root.historyScopeId !== turn.id ||
    (root.visibility as { kind?: string })?.kind !== "internal" ||
    !Array.isArray(root.recipientIds) ||
    !root.recipientIds.includes(input.participantId) ||
    rootTurn?.id !== turn.id ||
    turn.ownerParticipantId !== input.participantId ||
    rootTurn.ownerParticipantId !== input.participantId ||
    rootTurn.completeOn?.action !== turn.completeOn?.action ||
    !rootTurn.sourceHistory ||
    await agentTurnSourceDigest(rootTurn.sourceHistory) !==
      turn.sourceHistoryRef.digest
  ) {
    throw new Error(
      "Agent turn source reference is unavailable, changed, or belongs to another scope.",
    );
  }
  return rootTurn.sourceHistory;
}
