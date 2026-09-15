/** Memory-space access checks and trusted caller provenance. @module */
import type {
  CollectionRecord,
  SnapshotCollections,
} from "@copilotz/copilotz/collections";
import { type Participant, spaceAttachmentId } from "@copilotz/copilotz/core";
import type { MemorySpaceDescriptor } from "../authoring/consolidation/index.ts";
import type {
  MemoryActionContext,
  MemoryProcessorContext,
} from "./contracts.ts";
import { optionalText, requiredText } from "./input.ts";

export function participantAgentId(participant: Participant): string {
  return participant.agentId ?? participant.externalId;
}

/** Resolves explicit grants and current Space peers using the same read capabilities. */
export async function threadMemorySpaces(
  context: { collections: SnapshotCollections },
  threadId: string,
): Promise<readonly MemorySpaceDescriptor[]> {
  const { collections } = context;
  const spaces = new Map<string, MemorySpaceDescriptor>();
  let after: string | undefined;
  do {
    const grants = await collections.memorySpaceAccess.list({
      where: { threadId },
      order: { field: "id" },
      after,
      limit: 200,
    });
    for (const grant of grants) {
      const id = optionalText(grant.memorySpaceId);
      if (!id) continue;
      const space = await collections.memorySpace.get({ id });
      if (!space) continue;
      const access = grant.access === "read_write" ? "read_write" : "read";
      const previous = spaces.get(id);
      if (previous?.access === "read_write") continue;
      spaces.set(id, {
        id,
        name: optionalText(space.name) ?? `memory:${id}`,
        description: optionalText(space.description) ?? null,
        scopeType: optionalText(space.scopeType) ?? "custom",
        access,
        defaultWrite: access === "read_write" && grant.defaultWrite === true,
      });
    }
    after = grants.length === 200 ? grants[grants.length - 1].id : undefined;
  } while (after);

  const attachment = await collections.spaceAttachment?.get({
    id: spaceAttachmentId("thread", threadId),
  });
  const space = attachment &&
    await collections.space?.get({ id: String(attachment.spaceId) });
  if (space?.status === "active") {
    do {
      const peers = await collections.spaceAttachment.list({
        where: { spaceId: space.id, collection: "thread" },
        order: { field: "id" },
        after,
        limit: 200,
      });
      for (const peer of peers) {
        if (
          peer.recordId === threadId ||
          !await collections.thread.get({ id: String(peer.recordId) })
        ) continue;
        // Only the peer's producer scope is shared, never its consumer grants.
        const id = `memory-space:thread:${peer.recordId}`;
        const producer = await collections.memorySpace.get({ id });
        if (
          !producer || producer.scopeType !== "thread" ||
          producer.scopeId !== peer.recordId || spaces.has(id)
        ) continue;
        spaces.set(id, {
          id,
          name: optionalText(producer.name) ?? `memory:${id}`,
          description: optionalText(producer.description) ?? null,
          scopeType: "thread",
          access: "read",
          defaultWrite: false,
        });
      }
      after = peers.length === 200 ? peers[peers.length - 1].id : undefined;
    } while (after);
  }
  const ordered = [...spaces.values()].sort((a, b) =>
    Number(b.defaultWrite) - Number(a.defaultWrite) || a.id.localeCompare(b.id)
  );
  const defaultSpace = ordered.find((s) => s.defaultWrite) ??
    ordered.find((s) => s.access === "read_write");
  return ordered.map((s) => ({ ...s, defaultWrite: s === defaultSpace }));
}

export async function ensureWritableMemorySpace(
  context: MemoryProcessorContext,
  threadId: string,
) {
  const current = await threadMemorySpaces(context, threadId);
  if (current.some((space) => space.access === "read_write")) return current;
  const memorySpaceId = `memory-space:thread:${threadId}`;
  await context.collections.memorySpace.create({
    id: memorySpaceId,
    name: `Thread ${threadId}`,
    scopeType: "thread",
    scopeId: threadId,
    kind: "thread",
    ownerNodeId: threadId,
    threadId,
    access: "read_write",
    defaultWrite: true,
    description: "Default thread memory space",
    metadata: {},
  }, { operationKey: `space:create:${memorySpaceId}` });
  const grantId = `memory-space-access:${threadId}:${memorySpaceId}`;
  await context.collections.memorySpaceAccess.create({
    id: grantId,
    threadId,
    memorySpaceId,
    access: "read_write",
    defaultWrite: true,
    metadata: {},
  }, { operationKey: `space:grant:${grantId}` });
  return await threadMemorySpaces(context, threadId);
}

export function checkpointAccessible(
  checkpoint: CollectionRecord,
  spaces: readonly Pick<MemorySpaceDescriptor, "id">[],
): boolean {
  const readable = new Set(spaces.map((space) => space.id));
  const ids = Array.isArray(checkpoint.readMemorySpaceIds)
    ? checkpoint.readMemorySpaceIds.filter((id): id is string =>
      typeof id === "string"
    )
    : [];
  return ids.length > 0 && ids.every((id) => readable.has(id));
}

export function memoryActionProvenance(context: MemoryActionContext): Readonly<{
  threadId: string;
  agentId: string;
}> {
  return {
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
