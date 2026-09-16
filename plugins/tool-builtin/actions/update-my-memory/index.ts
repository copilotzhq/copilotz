import type { ActionContext } from "@copilotz/copilotz/actions";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
/** Built-in Action that updates the calling Agent memory.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { record, requiredText } from "../../shared/input.ts";
import { loadCallerParticipant } from "../../shared/participants.ts";

export const updateMyMemoryAction: ActionDefinition<
  unknown,
  { stored?: unknown; success: boolean; key: string; operation: string },
  ActionContext
> = defineAction({
  id: "copilotz.tools.builtin.update_my_memory",
  inputSchema: {
    type: "object",
    properties: {
      key: { type: "string", minLength: 1 },
      value: { type: "string" },
      operation: {
        type: "string",
        enum: ["set", "append", "remove"],
        default: "set",
      },
    },
    required: ["key"],
  },
  async execute(raw, context) {
    const input = record(raw);
    const key = requiredText(input.key, "key");
    const operation = input.operation ?? "set";
    if (
      operation !== "set" && operation !== "append" && operation !== "remove"
    ) {
      throw new TypeError("operation must be set, append, or remove.");
    }
    const participant = await loadCallerParticipant(context);
    if (!participant || participant.participantType !== "agent") {
      throw new Error("The calling agent participant was not found.");
    }
    const metadata = structuredClone(record(participant.metadata));
    if (operation === "remove") delete metadata[key];
    else {
      const item = requiredText(input.value, "value");
      if (operation === "append") {
        const previous = metadata[key];
        metadata[key] = Array.isArray(previous)
          ? [...previous, item]
          : previous === undefined
          ? [item]
          : [previous, item];
      } else metadata[key] = item;
    }
    await context.collections.participant.update({
      id: participant.id,
      set: { metadata },
    }, { operationKey: `update_my_memory:${context.action.runId}:${key}` });
    return {
      success: true,
      key,
      operation,
      ...(operation === "remove" ? {} : { stored: metadata[key] }),
    };
  },
});
