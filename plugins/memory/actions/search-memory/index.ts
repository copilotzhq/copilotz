import { loadThreadRecord } from "@copilotz/copilotz/core";
import { memoryFilter, vectorSimilarity } from "../../shared/retrieval.ts";
/** Searches accessible semantic-memory records. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import { isEditoriallyVisible } from "../../authoring/consolidation/index.ts";
import { MEMORY_FORMS } from "../../authoring/ontology/index.ts";
import {
  lexicalScore,
  memoryRecord,
  terminalStatus,
} from "../../shared/retrieval.ts";
import type { MemoryActionContext } from "../../shared/contracts.ts";
import {
  memoryActionProvenance,
  threadMemorySpaces,
} from "../../shared/access.ts";
import { optionalText, positiveInteger, record } from "../../shared/input.ts";
import {
  PUBLIC_MEMORY_RESULT_LIMIT,
  PUBLIC_MEMORY_SCAN_LIMIT,
  publicMemorySummary,
  searchMemoryOutputSchema,
} from "../../shared/public-projection.ts";

export const searchMemoryAction: ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema,
  typeof searchMemoryOutputSchema
> = defineAction({
  id: "copilotz.memory.search",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      query: { type: "string" },
      form: { enum: MEMORY_FORMS },
      kind: { type: "string" },
      status: { type: "string" },
      includeHistory: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
  },
  outputSchema: searchMemoryOutputSchema,
  async execute(raw, context) {
    const input = record(raw);
    const spaces = await threadMemorySpaces(
      context,
      memoryActionProvenance(context).threadId,
    );
    const readable = new Set(spaces.map((space) => space.id));
    const query = optionalText(input.query) ?? "";
    const embed = context.adapters.memoryEmbedding?.default;
    if (query && embed) {
      const profile = context.resources.memory?.embeddingProfile;
      if (!profile) {
        throw new Error(
          "Memory embedding requires resources.memory.embeddingProfile.",
        );
      }
      const provenance = memoryActionProvenance(context);
      const agent = context.resources.agents[provenance.agentId];
      const thread = await loadThreadRecord(context, provenance.threadId);
      if (!agent || !thread) {
        throw new Error("Memory search requires a current agent and thread.");
      }
      const values = await embed([query], {
        agent,
        thread,
        context,
        checkpointId: `search:${context.operationKey}`,
      });
      const limit = Math.min(
        positiveInteger(input.limit, 20),
        PUBLIC_MEMORY_RESULT_LIMIT,
      );
      const matches = await context.vectors.search({
        ownerType: "memory_record",
        field: "summary",
        profile,
        values: values[0],
        filter: memoryFilter(spaces, input),
        limit: limit + 1,
      });
      const memories = matches.slice(0, limit).flatMap(
        ({ record: raw, distance }) => {
          const mapped = memoryRecord(raw);
          return mapped
            ? [
              publicMemorySummary(
                raw,
                mapped,
                vectorSimilarity(profile.metric, distance),
              ),
            ]
            : [];
        },
      );
      return {
        memories,
        scanned: matches.length,
        matched: matches.length,
        returned: memories.length,
        truncated: matches.length > limit,
      };
    }
    const values = await context.collections.memoryRecord.list({
      filter: { field: "memorySpaceId", in: [...readable] },
      limit: PUBLIC_MEMORY_SCAN_LIMIT,
    });

    let scanned = 0;
    const matched = values.flatMap((item) => {
      const mapped = memoryRecord(item);
      if (!mapped || !readable.has(mapped.memorySpaceId)) return [];
      scanned++;
      if (
        input.form && mapped.form !== input.form ||
        input.kind && mapped.kind !== input.kind ||
        input.status && mapped.status !== input.status
      ) return [];
      if (
        input.includeHistory !== true &&
        (!isEditoriallyVisible(mapped) || terminalStatus(mapped.status))
      ) return [];
      const similarity = query ? lexicalScore(query, mapped.summary) : 1;
      return [publicMemorySummary(item, mapped, similarity)];
    }).sort((left, right) => right.similarity - left.similarity);
    const limit = Math.min(
      positiveInteger(input.limit, 20),
      PUBLIC_MEMORY_RESULT_LIMIT,
    );
    const memories = matched.slice(0, limit);
    return {
      memories: memories,
      scanned,
      matched: matched.length,
      returned: memories.length,
      truncated: values.length >= PUBLIC_MEMORY_SCAN_LIMIT ||
        memories.length < matched.length,
    };
  },
});

export default searchMemoryAction;
