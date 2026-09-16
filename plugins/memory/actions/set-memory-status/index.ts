/** Applies a validated lifecycle transition to an accessible memory record. @module */
import {
  type ActionDefinition,
  type ActionSchema,
  defineAction,
} from "@copilotz/copilotz/actions";
import { memoryLifecycleAllows } from "../../authoring/ontology/index.ts";

import type { MemoryActionContext } from "../../internal/contracts.ts";
import { record, requiredText } from "../../internal/input.ts";
import {
  memoryActionProvenance,
  threadMemorySpaces,
} from "../../internal/access.ts";
import { memoryRecord, terminalStatus } from "../../internal/retrieval.ts";

export const setMemoryStatusAction: ActionDefinition<
  unknown,
  unknown,
  MemoryActionContext,
  ActionSchema
> = defineAction({
  id: "copilotz.memory.status.set",
  inputSchema: {
    type: "object",
    required: ["id", "status"],
    properties: { id: { type: "string" }, status: { type: "string" } },
    additionalProperties: false,
  },
  async execute(
    raw: unknown,
    context: MemoryActionContext,
  ) {
    const input = record(raw);
    const id = requiredText(input.id, "Memory id");
    const status = requiredText(input.status, "Memory status");
    const item = await context.collections.memoryRecord
      .get({ id });
    const mapped = item ? memoryRecord(item) : null;
    if (!mapped) throw new Error(`Memory '${id}' was not found.`);
    const spaces = new Set(
      (await threadMemorySpaces(
        context,
        memoryActionProvenance(context).threadId,
      )).filter((
        space,
      ) => space.access === "read_write").map((space) => space.id),
    );
    if (!spaces.has(mapped.memorySpaceId)) {
      throw new Error(`Memory '${id}' is not writable from this thread.`);
    }
    if (!memoryLifecycleAllows(mapped.form, status)) {
      throw new TypeError(
        `Status '${status}' is invalid for '${mapped.form}'.`,
      );
    }
    await context.collections.memoryRecord.update({
      id,
      set: {
        status,
        temporal: {
          ...record(item!.temporal),
          invalidatedAt: terminalStatus(status)
            ? context.now().toISOString()
            : undefined,
        },
      },
    }, { operationKey: `memory-status:${id}:${status}` });
    return { id, status };
  },
});

export default setMemoryStatusAction;
