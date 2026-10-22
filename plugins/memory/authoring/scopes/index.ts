/** Scope constraints for application owner policies. @module */
import type { AuthorizationRead } from "@copilotz/copilotz/engine";
import type { ServerConstraints } from "@copilotz/copilotz/server";
import type { CollectionPredicate } from "@copilotz/copilotz/collections";
import { type MemoryScope, memorySpaceId } from "../../shared/access.ts";

export { type MemoryScope, memorySpaceId };

/**
 * Call inside the owner's policy with authenticated, server-derived provenance.
 * The app must authorize the thread/initiator first. Never pass request input or
 * unverified Action metadata here. Policy reads recheck membership at commit.
 * Omit threadId for the authenticated person's profile.
 */
export async function memoryScopeConstraints(
  read: AuthorizationRead,
  turn: Readonly<{ threadId?: string; initiatorParticipantId?: string }>,
): Promise<ServerConstraints> {
  const scopes: { scope: MemoryScope; owner: string }[] = [];
  if (turn.threadId) {
    const thread = await read.get("thread", turn.threadId);
    if (thread) {
      scopes.push({ scope: "thread", owner: thread.id });
      if (
        typeof thread.spaceId === "string" &&
        (await read.get("space", thread.spaceId))?.status === "active"
      ) {
        scopes.push({ scope: "space", owner: thread.spaceId });
      }
    }
  }
  if (
    turn.initiatorParticipantId &&
    (await read.get("participant", turn.initiatorParticipantId))
        ?.participantType === "human"
  ) {
    scopes.push({ scope: "personal", owner: turn.initiatorParticipantId });
  }
  const ids = scopes.map(({ scope, owner }) => memorySpaceId(scope, owner));
  const notes = {
    filter: { field: "memorySpaceId", in: ids } as CollectionPredicate,
  };
  const spaces = {
    filter: {
      or: scopes.map(({ scope, owner }) => ({
        and: [
          { field: "id", eq: memorySpaceId(scope, owner) },
          { field: "scopeType", eq: scope },
          { field: "scopeId", eq: owner },
        ],
      })),
    } as CollectionPredicate,
  };
  const threads = scopes.filter((s) => s.scope === "thread").map((s) =>
    s.owner
  );
  const checkpoints = {
    filter: { field: "threadId", in: threads } as CollectionPredicate,
  };
  const grants = {
    filter: {
      and: [
        { field: "threadId", in: threads },
        {
          field: "memorySpaceId",
          in: threads.map((id) => memorySpaceId("thread", id)),
        },
      ],
    } as CollectionPredicate,
  };
  return {
    collections: {
      memoryNote: notes,
      memorySpace: spaces,
      memorySpaceAccess: grants,
      longTermMemory: checkpoints,
    },
    collectionMutations: {
      memoryNote: {
        create: {
          filter: notes,
          fields: [
            "id",
            "text",
            "memorySpaceId",
            "consolidationId",
            "createdByAgentId",
            "originThreadId",
            "sources",
            "retirement",
          ],
        },
        commands: {
          retire: { filter: notes, fields: ["memorySpaceId", "retirement"] },
          addSources: {
            filter: notes,
            fields: [
              "memorySpaceId",
              "sources",
              "originThreadId",
              "createdByAgentId",
            ],
          },
        },
      },
      memorySpace: {
        create: {
          filter: spaces,
          fields: ["id", "scopeType", "scopeId", "kind", "threadId"],
        },
      },
      memorySpaceAccess: {
        create: { filter: grants },
        commands: { authorizeWrite: { filter: grants } },
      },
      longTermMemory: {
        create: { filter: checkpoints },
        update: { filter: checkpoints },
        commands: { completeConsolidation: { filter: checkpoints } },
      },
    },
  };
}
