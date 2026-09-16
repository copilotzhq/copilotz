/** Lists the caller's accessible memory spaces. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";

import type { MemoryActionContext } from "../../internal/contracts.ts";
import { positiveInteger, record } from "../../internal/input.ts";
import {
  memoryActionProvenance,
  threadMemorySpaces,
} from "../../internal/access.ts";

export const listKnowledgeSpacesAction: ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema
> = defineAction({
  id: "copilotz.memory.spaces.list",
  inputSchema: {
    type: "object",
    properties: { limit: { type: "integer", minimum: 1, maximum: 1_000 } },
  },
  async execute(
    raw: unknown,
    context: MemoryActionContext,
  ) {
    const limit = positiveInteger(record(raw).limit, 100);
    const values = (await threadMemorySpaces(
      context,
      memoryActionProvenance(context).threadId,
    )).slice(0, Math.min(limit, 1_000));
    return { knowledgeSpaces: values, totalKnowledgeSpaces: values.length };
  },
});

export default listKnowledgeSpacesAction;
