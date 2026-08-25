/** Builds the generated Knowledge tool Action/Resource contribution. @module */
import type { AnyActionDefinition } from "@copilotz/copilotz/actions";
import { defineTool, type ToolResource } from "@copilotz/copilotz/tools";
import {
  createSearchKnowledgeAction,
  deleteKnowledgeDocumentAction,
  ingestKnowledgeDocumentAction,
} from "../../actions/index.ts";
import type { KnowledgeEmbeddingConfig } from "../../internal/types.ts";

export type KnowledgeToolAliases = Readonly<{
  ingestId?: string;
  searchId?: string;
  deleteId?: string;
}>;

export type KnowledgeActionResourcesContribution = Readonly<{
  actions: Readonly<Record<string, AnyActionDefinition>>;
  tools: Readonly<Record<string, ToolResource>>;
}>;

function alias(value: string | undefined, fallback: string, name: string) {
  const normalized = (value ?? fallback).trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

/** Builds Knowledge's model-facing Actions and matching Tool Resources. */
export function createKnowledgeActionResources(
  embedding: KnowledgeEmbeddingConfig,
  input: KnowledgeToolAliases = {},
): KnowledgeActionResourcesContribution {
  const ingestId = alias(
    input.ingestId,
    "ingest_document",
    "Ingest Action alias",
  );
  const searchId = alias(
    input.searchId,
    "search_knowledge",
    "Search Action alias",
  );
  const deleteId = alias(
    input.deleteId,
    "delete_document",
    "Delete Action alias",
  );
  const aliases = [ingestId, searchId, deleteId];
  if (new Set(aliases).size !== aliases.length) {
    throw new TypeError("Knowledge Tool Action aliases must be distinct.");
  }

  const searchAction = createSearchKnowledgeAction(embedding);
  const actions: Record<string, AnyActionDefinition> = {
    [ingestId]: ingestKnowledgeDocumentAction,
    [searchId]: searchAction,
    [deleteId]: deleteKnowledgeDocumentAction,
  };
  const tools: Record<string, ToolResource> = {
    [ingestId]: defineTool(ingestId, ingestKnowledgeDocumentAction, {
      name: "Ingest Document",
      description:
        "Add text, a URL, a runtime-adapted file path, or an existing asset to the knowledge base. Indexing continues as durable background work.",
    }),
    [searchId]: defineTool(searchId, searchAction, {
      name: "Search Knowledge Base",
      description:
        "Search indexed document chunks by semantic similarity within the current tenant and graph scope.",
    }),
    [deleteId]: defineTool(deleteId, deleteKnowledgeDocumentAction, {
      name: "Delete Document",
      description:
        "Remove one document and its derived chunks by document ID or source URI.",
    }),
  };
  return Object.freeze({
    actions: Object.freeze(actions),
    tools: Object.freeze(tools),
  });
}
