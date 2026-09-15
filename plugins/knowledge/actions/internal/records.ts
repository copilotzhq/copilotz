/** Shared Knowledge records contracts and operations. @module */
import type { ActionContext } from "@copilotz/copilotz/actions";
import { record } from "./input.ts";
import type {
  KnowledgeChunk,
  KnowledgeDocument,
  KnowledgeSearchInput,
} from "../../internal/types.ts";
export function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    typeof item === "string" && item.trim() ? [item.trim()] : []
  );
}

export function documentMatchesScope(
  document: KnowledgeDocument,
  scope: Omit<KnowledgeSearchInput, "namespace" | "embedding">["scope"],
): boolean {
  if (scope?.documentIds && !scope.documentIds.includes(document.id)) {
    return false;
  }
  if (document.threadId && document.threadId !== scope?.threadId) {
    return false;
  }
  const metadata = record(document.metadata, "Document metadata");
  const storedScope = metadata.scope === undefined
    ? {}
    : record(metadata.scope, "Document metadata scope");
  const agentIds = [
    ...stringList(storedScope.agentIds ?? metadata.agentIds),
    ...(
      typeof (storedScope.agentId ?? metadata.agentId) === "string"
        ? [String(storedScope.agentId ?? metadata.agentId).trim()]
        : []
    ),
  ].filter(Boolean);
  if (agentIds.length && !scope?.agentId?.trim()) return false;
  if (agentIds.length && !agentIds.includes(scope!.agentId!.trim())) {
    return false;
  }
  const documentSpaces = [
    ...stringList(
      storedScope.knowledgeSpaceIds ?? metadata.knowledgeSpaceIds,
    ),
    ...(
      typeof (storedScope.knowledgeSpaceId ?? metadata.knowledgeSpaceId) ===
          "string"
        ? [
          String(
            storedScope.knowledgeSpaceId ?? metadata.knowledgeSpaceId,
          ).trim(),
        ]
        : []
    ),
  ].filter(Boolean);
  if (documentSpaces.length) {
    const requested = new Set(scope?.knowledgeSpaceIds ?? []);
    if (!documentSpaces.some((id) => requested.has(id))) return false;
  }
  return true;
}

export async function listDocumentChunks(
  collections: ActionContext["collections"],
  documentId: string,
): Promise<readonly KnowledgeChunk[]> {
  const chunks = collections.chunk;
  const collected: KnowledgeChunk[] = [];
  let after: string | undefined;
  while (true) {
    const page = await chunks.list({
      where: { documentId },
      ...(after ? { after } : {}),
      limit: 1_000,
    }) as readonly KnowledgeChunk[];
    collected.push(...page);
    if (page.length < 1_000) break;
    after = page.at(-1)?.id;
    if (!after) break;
  }
  return collected;
}
