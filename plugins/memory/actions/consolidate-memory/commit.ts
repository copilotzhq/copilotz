/** Commits note changes and the certified checkpoint as one mutation batch. @module */
import type { VectorWrite } from "@copilotz/copilotz/actions";
import type { PreparedContent } from "@copilotz/copilotz/content";
import type { prepareMemoryProposal } from "../../authoring/notes/index.ts";
import type { MemoryActionContext } from "../../shared/contracts.ts";

export async function commitMemoryConsolidation(
  context: MemoryActionContext,
  input: Readonly<{
    checkpointId: string;
    writeScopeId: string;
    writeGrantId: string;
    agentId: string;
    threadId: string;
    recordedAt: string;
    proposal: ReturnType<typeof prepareMemoryProposal>;
    vectors: readonly VectorWrite[];
    checkpointPatch: Readonly<Record<string, unknown>>;
    checkpointContent: PreparedContent;
  }>,
) {
  await context.transaction(async (tx) => {
    await tx.collections.memorySpaceAccess.commands.authorizeWrite({
      id: input.writeGrantId,
      threadId: input.threadId,
      memorySpaceId: input.writeScopeId,
    }, { operationKey: "memory:authorize-write" });
    // Conditional commands are folded against current rows inside the same
    // transaction as the checkpoint. A concurrent retirement rejects all writes.
    for (const note of input.proposal.notes) {
      if (note.reused) {
        // Even an empty append checks the reused note is still active atomically.
        await tx.collections.memoryNote.commands.addSources({
          id: note.id,
          memorySpaceId: input.writeScopeId,
          originThreadId: input.threadId,
          createdByAgentId: input.agentId,
          sources: note.sources,
        }, { operationKey: `note:sources:${note.id}` });
      } else {
        await tx.collections.memoryNote.create({
          id: note.id,
          memorySpaceId: input.writeScopeId,
          text: note.text,
          consolidationId: input.checkpointId,
          createdByAgentId: input.agentId,
          originThreadId: input.threadId,
          sources: note.sources,
          retirement: null,
        }, { operationKey: `note:create:${note.id}` });
      }
    }
    const retirements = [
      ...input.proposal.retire,
      ...input.proposal.notes.flatMap((note) =>
        note.replaces.map((id) => ({
          id,
          reason: "Replaced by a corrected note.",
          replacedBy: note.id,
        }))
      ),
    ];
    for (const retirement of retirements) {
      const { id, ...details } = retirement;
      await tx.collections.memoryNote.commands.retire({
        id,
        memorySpaceId: input.writeScopeId,
        retirement: {
          ...details,
          checkpointId: input.checkpointId,
          retiredAt: input.recordedAt,
          retiredBy: input.agentId,
        },
      }, { operationKey: `note:retire:${id}` });
    }
    for (const vector of input.vectors) await tx.vectors.upsert(vector);
    await tx.collections.longTermMemory.commands.completeConsolidation({
      id: input.checkpointId,
      ...input.checkpointPatch,
      content: input.checkpointContent,
    }, { operationKey: `memory-checkpoint:ready:${input.checkpointId}` });
  }, { operationKey: `memory:${input.checkpointId}:commit` });
}
