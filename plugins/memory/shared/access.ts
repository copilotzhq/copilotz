import { ensureMemoryScope } from "./personal.ts";
/** Memory-space access checks and trusted caller provenance. @module */
import type { ReadCollections } from "@copilotz/copilotz/collections";
import type { Participant } from "@copilotz/copilotz/core";
import type { MemorySpaceDescriptor } from "../authoring/consolidation/index.ts";
import type {
  MemoryActionContext,
  MemoryProcessorContext,
} from "./contracts.ts";
import { optionalText, requiredText } from "./input.ts";

export function participantAgentId(participant: Participant): string {
  return participant.agentId ?? participant.externalId;
}

/** Canonical scopes follow current Core membership, never another thread's grants. */
export async function threadMemorySpaces(
  context: { collections: ReadCollections },
  threadId: string,
  initiatorParticipantId?: string,
): Promise<readonly MemorySpaceDescriptor[]> {
  const { collections } = context;
  const thread = await collections.thread.get({ id: threadId });
  if (!thread) return [];
  const scopes: { scope: MemoryScope; owner: string }[] = [
    { scope: "thread", owner: threadId },
  ];
  const spaceId = optionalText(thread.spaceId);
  if (
    spaceId &&
    (await collections.space.get({ id: spaceId }))?.status === "active"
  ) {
    scopes.push({ scope: "space", owner: spaceId });
  }
  if (
    initiatorParticipantId &&
    (await collections.participant.get({ id: initiatorParticipantId }))
        ?.participantType === "human"
  ) {
    scopes.push({ scope: "personal", owner: initiatorParticipantId });
  }
  const result: MemorySpaceDescriptor[] = [];
  for (const { scope, owner } of scopes) {
    const id = memorySpaceId(scope, owner);
    const stored = await collections.memorySpace.get({ id });
    if (!stored || stored.scopeType !== scope || stored.scopeId !== owner) {
      continue;
    }
    result.push({
      id,
      name: `${scope}: ${owner}`,
      scopeType: scope,
      access: "read_write",
      defaultWrite: scope === "thread",
      ...(scope === "thread"
        ? { writeGrantId: `memory-space-access:${threadId}:${id}` }
        : {}),
    });
  }
  return result;
}

export type MemoryScope = "personal" | "space" | "thread";
export function memorySpaceId(scope: MemoryScope, owner: string): string {
  return `memory-space:${scope}:${owner}`;
}

export async function ensureWritableMemorySpace(
  context: MemoryProcessorContext,
  threadId: string,
) {
  const id = memorySpaceId("thread", threadId);
  await ensureMemoryScope(context.collections, "thread", threadId);
  const grantId = `memory-space-access:${threadId}:${id}`;
  if (!await context.collections.memorySpaceAccess.get({ id: grantId })) {
    try {
      await context.collections.memorySpaceAccess.create({
        id: grantId,
        threadId,
        memorySpaceId: id,
        access: "read_write",
        defaultWrite: true,
        metadata: {},
      }, { operationKey: `space:grant:${grantId}` });
    } catch (error) {
      const grant = await context.collections.memorySpaceAccess.get({
        id: grantId,
      });
      if (grant?.threadId !== threadId || grant.memorySpaceId !== id) {
        throw error;
      }
    }
  }
  return await threadMemorySpaces(context, threadId);
}

export function memoryActionProvenance(context: MemoryActionContext): Readonly<{
  threadId: string;
  agentId: string;
  initiatorParticipantId?: string;
}> {
  return {
    initiatorParticipantId: optionalText(
      context.action.metadata.initiatorParticipantId,
    ),
    threadId: requiredText(
      context.action.metadata.threadId,
      "Memory Action thread id",
    ),
    agentId: requiredText(
      context.action.metadata.agentId,
      "Memory Action agent id",
    ),
  };
}
