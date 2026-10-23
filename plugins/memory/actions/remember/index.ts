/** Immediate, append-only memory with optional atomic replacement. @module */
import {
  type ActionDefinition,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { MemoryActionContext } from "../../shared/contracts.ts";
import {
  memoryActionProvenance,
  type MemoryScope,
  memorySpaceId,
} from "../../shared/access.ts";
import {
  ensureMemoryScope,
  importPersonalMemory,
} from "../../shared/personal.ts";
import { record, requiredText } from "../../shared/input.ts";

export const rememberAction: ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext
> = defineAction({
  id: "copilotz.memory.remember",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", minLength: 1, maxLength: 16000 },
      scope: {
        enum: ["personal", "space", "thread"],
        default: "thread",
        description:
          "personal: facts about the initiating human, across their threads; space: shared by threads currently in this Core space; thread (default): continuity for this conversation.",
      },
      replaces: {
        type: "string",
        minLength: 1,
        description:
          "Active item in the same scope to correct. Replacement and retirement commit together.",
      },
    },
  },
  async execute(raw, context) {
    const input = record(raw);
    const provenance = memoryActionProvenance(context);
    const scope = (input.scope ?? "thread") as MemoryScope;
    const thread = await context.collections.thread.get({
      id: provenance.threadId,
    });
    if (!thread) throw new Error("Memory thread is unavailable.");
    let owner = provenance.threadId;
    if (scope === "personal") {
      const participant = provenance.initiatorParticipantId
        ? await context.collections.participant.get({
          id: provenance.initiatorParticipantId,
        })
        : null;
      if (participant?.participantType !== "human") {
        throw new Error("Personal memory requires a human initiator.");
      }
      owner = participant.id;
      await importPersonalMemory(context.collections, participant);
    } else if (scope === "space") {
      owner = requiredText(thread.spaceId, "Current Core space");
      if (
        (await context.collections.space.get({ id: owner }))?.status !==
          "active"
      ) {
        throw new Error("Current Core space is unavailable.");
      }
    } else if (scope !== "thread") throw new TypeError("Invalid memory scope.");
    const spaceId = await ensureMemoryScope(context.collections, scope, owner);
    const id = `memory:remember:${context.action.runId}`;
    const replaces = input.replaces === undefined
      ? undefined
      : requiredText(input.replaces, "replaces");
    const text = requiredText(input.text, "text");
    await context.transaction(async (tx) => {
      await tx.collections.memoryNote.create({
        id,
        memorySpaceId: spaceId,
        text,
        consolidationId: null,
        createdByAgentId: provenance.agentId,
        originThreadId: provenance.threadId,
        sources: [],
        retirement: null,
      }, { operationKey: "remember:create" });
      if (replaces) {
        await tx.collections.memoryNote.commands.retire({
          id: replaces,
          memorySpaceId: memorySpaceId(scope, owner),
          retirement: {
            checkpointId: `remember:${context.action.runId}`,
            retiredAt: context.now().toISOString(),
            retiredBy: provenance.agentId,
            reason: "Corrected by a replacement item.",
            replacedBy: id,
          },
        }, { operationKey: "remember:replace" });
      }
    }, { operationKey: "remember:commit" });
    return { id, scope, text, ...(replaces ? { replaces } : {}) };
  },
});
export default rememberAction;
