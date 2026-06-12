/**
 * Native tool for agents to update the current user's persistent memories.
 * Appends to or removes from `metadata.memories.items`, shared with the Profile UI.
 */

import type {
  CollectionsManager,
  ScopedCollectionsManager,
} from "@/types/index.ts";

type MemoryCategory = "preference" | "fact" | "goal" | "context" | "other";

interface MemoryItem {
  id: string;
  content: string;
  category?: MemoryCategory;
  source: "agent" | "user";
  createdAt: string;
  updatedAt?: string;
}

interface UpdateUserMemoryParams {
  content?: string;
  category?: MemoryCategory;
  operation?: "add" | "remove";
  memoryId?: string;
}

interface ToolContext {
  userExternalId?: string;
  namespace?: string;
  collections?: CollectionsManager | ScopedCollectionsManager;
}

function generateMemoryId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function isMemoryItem(value: unknown): value is MemoryItem {
  return typeof value === "object" && value !== null &&
    typeof (value as MemoryItem).id === "string" &&
    typeof (value as MemoryItem).content === "string";
}

export function getMemoryItems(
  metadata: Record<string, unknown>,
): MemoryItem[] {
  const memories = metadata.memories;
  if (!memories || typeof memories !== "object") return [];
  const items = (memories as Record<string, unknown>).items;
  if (!Array.isArray(items)) return [];
  return items.filter(isMemoryItem);
}

export function applyUserMemoryOperation(
  metadata: Record<string, unknown>,
  args: UpdateUserMemoryParams,
): { metadata: Record<string, unknown>; item?: MemoryItem } {
  const operation = args.operation ?? "add";

  if (operation === "add") {
    const content = args.content?.trim();
    if (!content) {
      throw new Error("content is required for add");
    }

    const item: MemoryItem = {
      id: generateMemoryId(),
      content,
      category: args.category ?? "other",
      source: "agent",
      createdAt: new Date().toISOString(),
    };

    const existingMemories = metadata.memories &&
        typeof metadata.memories === "object"
      ? metadata.memories as Record<string, unknown>
      : {};

    return {
      metadata: {
        ...metadata,
        memories: {
          ...existingMemories,
          items: [...getMemoryItems(metadata), item],
        },
        updatedAt: new Date().toISOString(),
      },
      item,
    };
  }

  if (operation === "remove") {
    const memoryId = args.memoryId?.trim();
    if (!memoryId) {
      throw new Error("memoryId is required for remove");
    }

    const existingMemories = metadata.memories &&
        typeof metadata.memories === "object"
      ? metadata.memories as Record<string, unknown>
      : {};

    const remaining = getMemoryItems(metadata).filter((item) =>
      item.id !== memoryId
    );

    if (remaining.length === getMemoryItems(metadata).length) {
      throw new Error(`Memory item not found: ${memoryId}`);
    }

    return {
      metadata: {
        ...metadata,
        memories: {
          ...existingMemories,
          items: remaining,
        },
        updatedAt: new Date().toISOString(),
      },
    };
  }

  throw new Error(`Unsupported operation: ${operation}`);
}

export default {
  key: "update_user_memory",
  name: "Update User Memory",
  description:
    "Add or remove persistent memories about the current user in their shared profile memory list (memories.items). The same list appears in the user's Profile UI and is injected as USER METADATA on future turns. Use for user-specific facts, preferences, goals, and context — not team-wide agent learnings.",
  inputSchema: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description:
          "The memory to store. One short, standalone sentence the model can reuse without surrounding context. Required for add.",
      },
      category: {
        type: "string",
        enum: ["preference", "fact", "goal", "context", "other"],
        description:
          "What kind of memory this is. Defaults to other.",
        default: "other",
      },
      operation: {
        type: "string",
        enum: ["add", "remove"],
        description:
          "add creates a new memory item; remove deletes one by memoryId.",
        default: "add",
      },
      memoryId: {
        type: "string",
        description:
          "ID of the memory to remove (from USER METADATA memories.items). Required for remove.",
      },
    },
    required: [],
  },
  execute: async (args: UpdateUserMemoryParams, context?: ToolContext) => {
    const operation = args.operation ?? "add";

    if (operation === "add" && !args.content?.trim()) {
      return { success: false, error: "content is required for add" };
    }
    if (operation === "remove" && !args.memoryId?.trim()) {
      return { success: false, error: "memoryId is required for remove" };
    }

    const userExternalId = context?.userExternalId;
    if (!userExternalId) {
      return {
        success: false,
        error: "User context not available (userExternalId missing from thread)",
      };
    }

    if (!context?.namespace) {
      return { success: false, error: "Tenant namespace not available" };
    }

    const participantCollection =
      (context?.collections as any)?.withNamespace?.(context.namespace)
        ?.participant ??
        (context?.collections as any)?.participant;
    if (
      !participantCollection ||
      typeof participantCollection.resolveByExternalId !== "function" ||
      typeof participantCollection.upsertIdentity !== "function"
    ) {
      return { success: false, error: "Participant collection not available" };
    }

    try {
      const userParticipant = await participantCollection.resolveByExternalId(
        userExternalId,
      );

      const existingMetadata = userParticipant?.metadata &&
          typeof userParticipant.metadata === "object"
        ? userParticipant.metadata as Record<string, unknown>
        : {};

      const { metadata, item } = applyUserMemoryOperation(
        existingMetadata,
        args,
      );

      await participantCollection.upsertIdentity({
        externalId: userExternalId,
        participantType: "human",
        name: (userParticipant?.name ?? null) as string | null,
        email: (userParticipant?.email ?? null) as string | null,
        agentId: null,
        metadata,
      });

      return {
        success: true,
        message: operation === "remove"
          ? `Memory removed: ${args.memoryId}`
          : "Memory added",
        ...(item ? { memory: item } : {}),
        memoryCount: getMemoryItems(metadata).length,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to update user memory: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  },
};
