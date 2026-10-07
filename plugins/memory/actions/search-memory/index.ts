/** Searches notes through bounded, authorized database queries. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import { loadThreadRecord } from "@copilotz/copilotz/core";
import {
  memoryFilter,
  memoryNote,
  vectorSimilarity,
} from "../../shared/retrieval.ts";
import type { MemoryActionContext } from "../../shared/contracts.ts";
import {
  memoryActionProvenance,
  threadMemorySpaces,
} from "../../shared/access.ts";
import { optionalText, positiveInteger, record } from "../../shared/input.ts";
import {
  PUBLIC_MEMORY_RESULT_LIMIT,
  publicMemoryNote,
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
      includeRetired: { type: "boolean" },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: PUBLIC_MEMORY_RESULT_LIMIT,
      },
    },
  },
  outputSchema: searchMemoryOutputSchema,
  async execute(raw, context) {
    const input = record(raw);
    const provenance = memoryActionProvenance(context);
    const spaces = await threadMemorySpaces(context, provenance.threadId);
    if (!spaces.length) return { notes: [], returned: 0, truncated: false };
    const filter = memoryFilter(spaces, input.includeRetired === true);
    const query = optionalText(input.query);
    const limit = Math.min(
      positiveInteger(input.limit, 20),
      PUBLIC_MEMORY_RESULT_LIMIT,
    );
    const embed = context.adapters.memoryEmbedding?.default;
    if (query && embed) {
      const profile = context.resources.memory?.embeddingProfile;
      const agent = context.resources.agents[provenance.agentId];
      const thread = await loadThreadRecord(context, provenance.threadId);
      if (!profile || !agent || !thread) {
        throw new Error(
          "Memory search requires an embedding profile, agent and current thread.",
        );
      }
      const values = await embed([query], {
        agent,
        thread,
        context,
        checkpointId: `search:${context.operationKey}`,
      });
      const matches = await context.vectors.search({
        ownerType: "memory_note",
        field: "text",
        profile,
        values: values[0],
        filter,
        limit: limit + 1,
      });
      const notes = matches.slice(0, limit).map(({ record, distance }) => ({
        ...publicMemoryNote(memoryNote(record)),
        similarity: vectorSimilarity(profile.metric, distance),
      }));
      return {
        notes,
        returned: notes.length,
        truncated: matches.length > limit,
      };
    }
    const values = await context.collections.memoryNote.list({
      filter,
      ...(query ? { text: query } : {}),
      order: { field: "createdAt", direction: "asc" },
      limit: limit + 1,
    });
    const notes = values.slice(0, limit).map((value) =>
      publicMemoryNote(memoryNote(value))
    );
    return { notes, returned: notes.length, truncated: values.length > limit };
  },
});
export default searchMemoryAction;
