/** Evidence handles refer only to bodies the ordinary transcript exposes. @module */
import {
  agentAskMetadata,
  buildLlmTranscript,
  compareThreadMessageRecords,
  type ContextSourceRef,
  type ConversationMessage,
  coreToolActionMetadata,
  type FrozenContextContribution,
  loadCoreThreadMessageSnapshot,
} from "@copilotz/copilotz/core";
import type { MemoryActionContext } from "./contracts.ts";
import { memorySourceHandle } from "../authoring/consolidation/index.ts";

export function visibleMemorySources(
  messages: readonly ConversationMessage[],
  participantId: string,
) {
  if (!messages.length) return [];
  const visible = new Set(
    buildLlmTranscript({
      threadId: messages[0].threadId,
      history: messages,
      participantId,
    }).filter((entry) =>
      !entry.peerToolStatus || entry.peerToolStatus.showsOutput
    ).map((entry) => entry.sourceId),
  );
  return messages.filter((message) => visible.has(message.id));
}

/** Both IDs appear on received tool_results; call IDs alone can repeat. */
export function toolSourceHandle(planId: string, toolCallId: string): string {
  return `tool:${JSON.stringify([planId, toolCallId])}`;
}

export function sourceCatalog(
  messages: readonly ConversationMessage[],
  snapshot: readonly FrozenContextContribution[],
  participantId: string,
  toolMessages: readonly ConversationMessage[] = [],
) {
  const sources = new Map<string, ContextSourceRef>();
  const ambiguous = new Set<string>();
  const addMessage = (message: ConversationMessage) => {
    const source = { type: "message" as const, id: message.id };
    sources.set(memorySourceHandle(source), source);
    for (const ref of message.content) {
      if (
        ref.assetId && ref.disposition !== "attachment" &&
        !(ref.kind === "file" && ref.disposition == null)
      ) {
        sources.set(memorySourceHandle({ type: "asset", id: ref.assetId }), {
          type: "asset",
          id: ref.assetId,
        });
      }
    }
    return source;
  };
  for (const message of visibleMemorySources(messages, participantId)) {
    if (
      message.sender.participantType !== "tool" ||
      message.metadata.toolStatus === "completed"
    ) addMessage(message);
  }
  for (const history of [messages, toolMessages]) {
    if (!history.length) continue;
    const byId = new Map(history.map((message) => [message.id, message]));
    const transcript = buildLlmTranscript({
      threadId: history[0].threadId,
      history,
      participantId,
    });
    for (const entry of transcript) {
      const message = byId.get(entry.sourceId);
      const result = entry.message;
      if (
        !message || result.role !== "tool" || !result.toolPlanId ||
        (entry.peerToolStatus && !entry.peerToolStatus.showsOutput)
      ) continue;
      // Core may replace a completed Ask receipt with its authorized answer.
      if (
        message.metadata.toolStatus !== "completed" &&
        agentAskMetadata(message.metadata)?.phase !== "answer"
      ) continue;
      const source = addMessage(message);
      const handle = toolSourceHandle(result.toolPlanId, result.toolCallId);
      const previous = sources.get(handle);
      if (previous && previous.id !== source.id) ambiguous.add(handle);
      sources.set(handle, source);
    }
  }
  for (const handle of ambiguous) sources.delete(handle);
  for (const item of snapshot) {
    if (item.role === "evidence" && item.source) {
      sources.set(memorySourceHandle(item.source), item.source);
    }
  }
  return sources;
}

/** Current maintenance results use the same Core history visibility as preparation. */
export async function ownedTurnToolSources(
  context: MemoryActionContext,
): Promise<readonly ConversationMessage[]> {
  const provenance = coreToolActionMetadata(context.action.metadata)!;
  if (!provenance.agentTurn) return []; // Ordinary results already belong to the reserved history.
  const trigger = await context.collections.message.get({
    id: provenance.triggerMessageId,
  });
  if (!trigger) return [];
  const snapshot = await context.readSnapshot(({ collections }) =>
    loadCoreThreadMessageSnapshot(
      { collections } as typeof context,
      provenance.threadId,
      trigger,
      {
        historyScopeId: provenance.agentTurn!.id,
        viewerIds: [provenance.agentParticipantId],
      },
    )
  );
  if (!snapshot.active) return [];
  // Do not cite results that arrived after the model's continuation trigger.
  return snapshot.messages.filter((message) =>
    compareThreadMessageRecords(message, trigger) <= 0
  );
}
