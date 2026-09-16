import type { ActionContext } from "@copilotz/copilotz/actions";
import type { ActionDefinition } from "@copilotz/copilotz/actions";
/** Built-in Action that updates the current human memory.
 *
 * @module
 */

import { defineAction } from "@copilotz/copilotz/actions";
import { record, requiredText } from "../internal/input.ts";
import { metadataText } from "../internal/participants.ts";

type UserMemoryItem = Readonly<{
  id: string;
  content: string;
  category: string;
  source: "agent";
  createdAt: string;
}>;

function userMemoryItems(metadata: Record<string, unknown>): UserMemoryItem[] {
  const items = record(metadata.memories).items;
  return Array.isArray(items)
    ? items.filter((item): item is UserMemoryItem =>
      Boolean(
        item && typeof item === "object" &&
          typeof (item as UserMemoryItem).id === "string" &&
          typeof (item as UserMemoryItem).content === "string",
      )
    )
    : [];
}

export const updateUserMemoryAction: ActionDefinition<
  unknown,
  {
    memoryCount: number;
    memory?:
      | Readonly<
        {
          id: string;
          content: string;
          category: string;
          source: "agent";
          createdAt: string;
        }
      >
      | undefined;
    success: boolean;
    operation: string;
  },
  ActionContext
> = defineAction({
  id: "copilotz.tools.builtin.update_user_memory",
  inputSchema: {
    type: "object",
    properties: {
      content: { type: "string" },
      category: {
        type: "string",
        enum: ["preference", "fact", "goal", "context", "other"],
        default: "other",
      },
      operation: { type: "string", enum: ["add", "remove"], default: "add" },
      memoryId: { type: "string" },
    },
  },
  async execute(raw, context) {
    const clock = context.adapters.clock?.default as
      | { now?: () => Date }
      | undefined;
    const now = clock?.now ?? context.now;
    const input = record(raw);
    const operation = input.operation ?? "add";
    if (operation !== "add" && operation !== "remove") {
      throw new TypeError("operation must be add or remove.");
    }
    const initiatorParticipantId = requiredText(
      metadataText(context, "initiatorParticipantId"),
      "Initiator participant ID",
    );
    const participant = await context.collections.participant.get({
      id: initiatorParticipantId,
    });
    if (!participant || participant.participantType !== "human") {
      throw new Error("The current human participant was not found.");
    }
    const metadata = structuredClone(record(participant.metadata));
    const previous = userMemoryItems(metadata);
    let item: UserMemoryItem | undefined;
    let items: UserMemoryItem[];
    if (operation === "add") {
      const content = requiredText(input.content, "content");
      const category = typeof input.category === "string"
        ? input.category
        : "other";
      item = {
        id: `memory:${context.action.runId}`,
        content,
        category,
        source: "agent",
        createdAt: now().toISOString(),
      } as const;
      items = previous.some((candidate) => candidate.id === item!.id)
        ? previous
        : [...previous, item];
    } else {
      const memoryId = requiredText(input.memoryId, "memoryId");
      items = previous.filter((candidate) => candidate.id !== memoryId);
      if (items.length === previous.length) {
        throw new Error(`Memory item '${memoryId}' was not found.`);
      }
    }
    metadata.memories = { ...record(metadata.memories), items };
    metadata.updatedAt = now().toISOString();
    await context.collections.participant.update({
      id: participant.id,
      set: { metadata },
    }, {
      operationKey: `update_user_memory:${context.action.runId}:${
        String(operation)
      }`,
    });
    return {
      success: true,
      operation,
      ...(item ? { memory: item } : {}),
      memoryCount: items.length,
    };
  },
});
