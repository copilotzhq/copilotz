/**
 * ENTITY_EXTRACT Event Processor
 * 
 * Handles entity extraction pipeline:
 * 1. Extract entities from content using LLM
 * 2. Search for similar existing entities (deduplication)
 * 3. LLM-confirm merge if similarity is ambiguous
 * 4. Create entity nodes and MENTIONS edges
 */

import type {
  Event,
  EventProcessor,
  NewEvent,
  ProcessorDeps,
  EmbeddingConfig,
} from "@/interfaces/index.ts";
import type { EntityExtractPayload } from "@/database/schemas/index.ts";
import { embed } from "@/connectors/embeddings/index.ts";
import { chat } from "@/connectors/llm/index.ts";
import type { ProviderConfig } from "@/connectors/llm/types.ts";

export type { EntityExtractPayload };

// Extracted entity structure from LLM
interface ExtractedEntity {
  name: string;
  type: string;  // "concept", "decision", "person", "tool", etc.
  description?: string;
}

// LLM extraction response
interface ExtractionResult {
  entities: ExtractedEntity[];
}

// Type guard for payload
function isEntityExtractPayload(payload: unknown): payload is EntityExtractPayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return typeof p.sourceNodeId === "string" && typeof p.content === "string";
}

// Default thresholds
const DEFAULT_SIMILARITY_THRESHOLD = 0.95;
const DEFAULT_AUTO_MERGE_THRESHOLD = 0.99;

/**
 * Build the extraction prompt for the LLM
 */
function buildExtractionPrompt(content: string, entityTypes?: string[]): string {
  const typeHint = entityTypes?.length
    ? `Focus on these entity types: ${entityTypes.join(", ")}.`
    : `Common entity types include: concept, decision, person, tool, task, fact.`;

  return `You are an entity extraction system. Extract meaningful entities from the following content.

${typeHint}

For each entity, provide:
- name: The canonical name of the entity (normalized, consistent casing)
- type: The entity type (one of the types mentioned above)
- description: A brief description (optional, 1 sentence max)

Rules:
- Extract only significant entities that would be worth remembering
- Normalize names to their canonical form (e.g., "OpenAI" not "open ai")
- Skip generic terms, pronouns, and trivial mentions
- Return an empty array if no significant entities are found

Content to analyze:
"""
${content}
"""

Respond with valid JSON only, in this exact format:
{
  "entities": [
    { "name": "EntityName", "type": "concept", "description": "Brief description" }
  ]
}`;
}

/**
 * Build the merge confirmation prompt
 */
function buildMergeConfirmPrompt(newEntity: ExtractedEntity, existingName: string, existingType: string): string {
  return `Are these two entities the same thing?

Entity 1 (existing): "${existingName}" (type: ${existingType})
Entity 2 (new): "${newEntity.name}" (type: ${newEntity.type})

Consider:
- Are they referring to the same concept/person/thing?
- Are they just different spellings or phrasings?

Respond with valid JSON only:
{ "same": true } or { "same": false, "reason": "brief explanation" }`;
}

/**
 * Parse LLM JSON response safely
 */
function parseJsonResponse<T>(response: string): T | null {
  try {
    // Try to extract JSON from the response
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]) as T;
  } catch {
    return null;
  }
}

export const entityExtractProcessor: EventProcessor<EntityExtractPayload, ProcessorDeps> = {
  shouldProcess: (event: Event) => {
    const eventType = (event as unknown as { type: string }).type;
    const eventPayload = (event as unknown as { payload: unknown }).payload;
    return eventType === "ENTITY_EXTRACT" && isEntityExtractPayload(eventPayload);
  },

  process: async (event: Event, deps: ProcessorDeps) => {
    const { db, context } = deps;
    const ops = db.ops;
    const payload = (event as unknown as { payload: EntityExtractPayload }).payload;

    const {
      sourceNodeId,
      content,
      namespace,
      sourceType,
      sourceContext,
    } = payload;

    // Get embedding config
    const embeddingConfig = context.embeddingConfig ?? context.ragConfig?.embedding;
    if (!embeddingConfig) {
      console.warn("[ENTITY_EXTRACT] No embedding config available, skipping extraction");
      return { producedEvents: [] };
    }

    // Get LLM config from first agent or fallback to RAG config
    const agent = context.agents?.[0];
    const agentLlmConfig = (typeof agent?.llmOptions === "object" ? agent.llmOptions : null) as ProviderConfig | null;
    const ragLlmConfig = context.ragConfig?.llmConfig as ProviderConfig | undefined;
    const llmConfig = agentLlmConfig?.provider ? agentLlmConfig : ragLlmConfig;
    
    if (!llmConfig?.provider) {
      console.warn("[ENTITY_EXTRACT] No LLM config available (agent uses dynamic llmOptions and no rag.llmConfig set), skipping extraction");
      return { producedEvents: [] };
    }

    // Get entity extraction config from agent
    const entityConfig = agent?.ragOptions?.entityExtraction;
    const similarityThreshold = entityConfig?.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const autoMergeThreshold = entityConfig?.autoMergeThreshold ?? DEFAULT_AUTO_MERGE_THRESHOLD;
    const entityTypes = entityConfig?.entityTypes;

    try {
      // Step 1: Extract entities using LLM
      const extractionPrompt = buildExtractionPrompt(content, entityTypes);
      
      const extractionResult = await chat(
        { messages: [{ role: "user", content: extractionPrompt }] },
        { ...llmConfig, stream: false }
      );

      const extractionText = extractionResult.answer;

      const parsed = parseJsonResponse<ExtractionResult>(extractionText);
      
      if (!parsed?.entities?.length) {
        // No entities found
        return { producedEvents: [] };
      }

      // Step 2: Process each extracted entity
      for (const entity of parsed.entities) {
        await processEntity(entity, {
          ops,
          embeddingConfig,
          llmConfig,
          namespace,
          sourceNodeId,
          sourceType,
          sourceContext,
          similarityThreshold,
          autoMergeThreshold,
        });
      }

      return { producedEvents: [] };

    } catch (error) {
      console.error("[ENTITY_EXTRACT] Error:", error);
      return { producedEvents: [] };
    }
  },
};

interface ProcessEntityContext {
  ops: ProcessorDeps["db"]["ops"];
  embeddingConfig: EmbeddingConfig;
  llmConfig: ProviderConfig;
  namespace: string;
  sourceNodeId: string;
  sourceType: "message" | "chunk";
  sourceContext?: EntityExtractPayload["sourceContext"];
  similarityThreshold: number;
  autoMergeThreshold: number;
}

/**
 * Process a single extracted entity:
 * 1. Generate embedding
 * 2. Search for similar existing entities
 * 3. Decide: merge, create new, or create with RELATED_TO
 */
async function processEntity(
  entity: ExtractedEntity,
  ctx: ProcessEntityContext
): Promise<void> {
  const {
    ops,
    embeddingConfig,
    llmConfig,
    namespace,
    sourceNodeId,
    sourceType,
    sourceContext,
    similarityThreshold,
    autoMergeThreshold,
  } = ctx;

  // Generate embedding for the entity name + description
  const textToEmbed = entity.description
    ? `${entity.name}: ${entity.description}`
    : entity.name;
  
  const embeddingResult = await embed([textToEmbed], embeddingConfig);
  const embedding = embeddingResult.embeddings[0];

  if (!embedding) {
    console.warn(`[ENTITY_EXTRACT] Failed to generate embedding for entity "${entity.name}"`);
    return;
  }

  // Search for similar existing entities in the same namespace
  const similarEntities = await ops.searchNodes({
    embedding,
    namespaces: [namespace],
    nodeTypes: [entity.type],  // Only match same type
    limit: 5,
    minSimilarity: similarityThreshold,
  });

  let targetEntityId: string;

  if (similarEntities.length === 0) {
    // No similar entity found - create new
    const newNode = await ops.createNode({
      namespace,
      type: entity.type,
      name: entity.name,
      content: entity.description ?? null,
      embedding,
      data: {
        aliases: [entity.name],
        mentionCount: 1,
      },
      sourceType: "extraction",
      sourceId: sourceNodeId,
    });
    targetEntityId = newNode.id as string;
    
  } else {
    // Found similar entity - check if we should merge
    const topMatch = similarEntities[0];
    const matchedNode = topMatch.node;
    const similarity = topMatch.similarity ?? 0;

    if (similarity >= autoMergeThreshold) {
      // Auto-merge: very high confidence
      targetEntityId = matchedNode.id as string;
      await mergeIntoExisting(ops, targetEntityId, entity);
      
    } else {
      // Similarity between threshold and auto-merge: ask LLM to confirm
      const shouldMerge = await confirmMerge(
        entity,
        matchedNode.name ?? "Unknown",
        matchedNode.type,
        llmConfig
      );

      if (shouldMerge) {
        targetEntityId = matchedNode.id as string;
        await mergeIntoExisting(ops, targetEntityId, entity);
      } else {
        // Different entity - create new and link with RELATED_TO
        const newNode = await ops.createNode({
          namespace,
          type: entity.type,
          name: entity.name,
          content: entity.description ?? null,
          embedding,
          data: {
            aliases: [entity.name],
            mentionCount: 1,
          },
          sourceType: "extraction",
          sourceId: sourceNodeId,
        });
        targetEntityId = newNode.id as string;

        // Create RELATED_TO edge to the similar entity
        await ops.createEdge({
          sourceNodeId: targetEntityId,
          targetNodeId: matchedNode.id as string,
          type: "RELATED_TO",
          data: { similarity },
        });
      }
    }
  }

  // Create MENTIONS edge from source to entity
  await ops.createEdge({
    sourceNodeId,
    targetNodeId: targetEntityId,
    type: "MENTIONS",
    data: {
      sourceType,
      extractedName: entity.name,
      ...sourceContext,
    },
  });
}

/**
 * Merge a new entity mention into an existing entity node
 */
async function mergeIntoExisting(
  ops: ProcessorDeps["db"]["ops"],
  existingId: string,
  newEntity: ExtractedEntity
): Promise<void> {
  const existing = await ops.getNodeById(existingId);
  if (!existing) return;

  const data = (existing.data ?? {}) as Record<string, unknown>;
  const aliases = (data.aliases as string[]) ?? [];
  const mentionCount = (data.mentionCount as number) ?? 0;

  // Add alias if not already present
  if (!aliases.includes(newEntity.name)) {
    aliases.push(newEntity.name);
  }

  await ops.updateNode(existingId, {
    data: {
      ...data,
      aliases,
      mentionCount: mentionCount + 1,
    },
  });
}

/**
 * Ask LLM to confirm if two entities are the same
 */
async function confirmMerge(
  newEntity: ExtractedEntity,
  existingName: string,
  existingType: string,
  llmConfig: ProviderConfig
): Promise<boolean> {
  try {
    const prompt = buildMergeConfirmPrompt(newEntity, existingName, existingType);
    
    const result = await chat(
      { messages: [{ role: "user", content: prompt }] },
      { ...llmConfig, stream: false }
    );

    const parsed = parseJsonResponse<{ same: boolean }>(result.answer);
    return parsed?.same === true;
    
  } catch (error) {
    console.warn("[ENTITY_EXTRACT] Merge confirmation failed, defaulting to no merge:", error);
    return false;
  }
}

export default entityExtractProcessor;

