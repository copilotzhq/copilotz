/** Idempotent legacy import into the ordinary immutable note collection. @module */
import type {
  CollectionRecord,
  ScopedCollections,
} from "@copilotz/copilotz/collections";
import { canonicalJson } from "@copilotz/copilotz/content/codec";
import { type MemoryScope, memorySpaceId } from "./access.ts";
import { record } from "./input.ts";

/** Concurrent callers may create the same container; only an identical winner is accepted. */
export async function ensureMemoryScope(
  collections: ScopedCollections,
  scope: MemoryScope,
  owner: string,
) {
  const id = memorySpaceId(scope, owner);
  const existing = await collections.memorySpace.get({ id });
  if (existing) {
    if (existing.scopeType !== scope || existing.scopeId !== owner) {
      throw new Error("Memory scope identity mismatch.");
    }
    return id;
  }
  try {
    await collections.memorySpace.create({
      id,
      scopeType: scope,
      scopeId: owner,
      kind: `${scope}:${owner}`,
      ...(scope === "thread" ? { threadId: owner } : {}),
    }, { operationKey: `memory-scope:${id}` });
  } catch (error) {
    const winner = await collections.memorySpace.get({ id });
    if (winner?.scopeType !== scope || winner.scopeId !== owner) throw error;
  }
  return id;
}

export async function importPersonalMemory(
  collections: ScopedCollections,
  participant: CollectionRecord,
): Promise<void> {
  if (participant.participantType !== "human") return;
  const items = record(record(participant.metadata).memories).items;
  if (!Array.isArray(items) || !items.length) return;
  const scope = await ensureMemoryScope(
    collections,
    "personal",
    participant.id,
  );
  for (const value of items) {
    const item = record(value);
    if (typeof item.content !== "string" || !item.content.trim()) continue;
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        canonicalJson({ participantId: participant.id, item }),
      ),
    );
    const hash = Array.from(
      new Uint8Array(digest),
      (n) => n.toString(16).padStart(2, "0"),
    ).join("");
    const id = `memory:legacy:${hash}`;
    if (await collections.memoryNote.get({ id })) continue;
    try {
      await collections.memoryNote.create({
        id,
        memorySpaceId: scope,
        text: item.content,
        consolidationId: null,
        createdByAgentId: null,
        originThreadId: null,
        sources: [{
          type: "collection_record",
          collection: "participant",
          id: participant.id,
          fragment: "metadata.memories.items",
        }],
        retirement: null,
      }, { operationKey: `memory-import:${id}` });
    } catch (error) {
      const winner = await collections.memoryNote.get({ id });
      if (winner?.memorySpaceId !== scope || winner.text !== item.content) {
        throw error;
      }
    }
  }
}
