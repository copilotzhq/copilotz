/** Inspects a bounded set of notes; missing and inaccessible IDs are indistinguishable. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import type { MemoryActionContext } from "../../shared/contracts.ts";
import {
  memoryActionProvenance,
  threadMemorySpaces,
} from "../../shared/access.ts";
import { memoryFilter, memoryNote } from "../../shared/retrieval.ts";
import { record } from "../../shared/input.ts";
import {
  inspectMemoryOutputSchema,
  PUBLIC_MEMORY_RESULT_LIMIT,
  publicMemoryNote,
} from "../../shared/public-projection.ts";

export const inspectMemoryAction: ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema,
  typeof inspectMemoryOutputSchema
> = defineAction({
  id: "copilotz.memory.inspect",
  inputSchema: {
    type: "object",
    required: ["ids"],
    additionalProperties: false,
    properties: {
      ids: {
        type: "array",
        minItems: 1,
        maxItems: PUBLIC_MEMORY_RESULT_LIMIT,
        uniqueItems: true,
        items: { type: "string", minLength: 1 },
      },
    },
  },
  outputSchema: inspectMemoryOutputSchema,
  async execute(raw, context) {
    const ids = record(raw).ids as string[];
    const provenance = memoryActionProvenance(context);
    const spaces = await threadMemorySpaces(context, provenance.threadId);
    const values = spaces.length
      ? await context.collections.memoryNote.list({
        filter: { and: [memoryFilter(spaces, true), { field: "id", in: ids }] },
        limit: ids.length,
      })
      : [];
    const notes = new Map(
      values.map((
        value,
      ) => [
        value.id,
        publicMemoryNote(
          memoryNote(value),
          true,
          value.originThreadId === provenance.threadId &&
            value.createdByAgentId === provenance.agentId,
        ),
      ]),
    );
    return {
      notes: ids.flatMap((id) => notes.has(id) ? [notes.get(id)!] : []),
      unavailableIds: ids.filter((id) => !notes.has(id)),
    };
  },
});
export default inspectMemoryAction;
