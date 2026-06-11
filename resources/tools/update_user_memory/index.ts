/**
 * Native tool for agents to update the current user's persistent metadata.
 * Stored on the human participant node and injected as USER METADATA on future turns.
 */

import type {
  CollectionsManager,
  ScopedCollectionsManager,
} from "@/types/index.ts";

interface UpdateUserMemoryParams {
  key: string;
  value: string;
  operation?: "set" | "append" | "remove";
}

interface ToolContext {
  userExternalId?: string;
  namespace?: string;
  collections?: CollectionsManager | ScopedCollectionsManager;
}

function applyMetadataOperation(
  metadata: Record<string, unknown>,
  key: string,
  value: string,
  operation: "set" | "append" | "remove",
): Record<string, unknown> {
  const next = { ...metadata };

  if (operation === "set") {
    next[key] = value;
  } else if (operation === "append") {
    const existing = next[key];
    if (Array.isArray(existing)) {
      next[key] = [...existing, value];
    } else if (existing) {
      next[key] = [existing, value];
    } else {
      next[key] = [value];
    }
  } else if (operation === "remove") {
    delete next[key];
  }

  return next;
}

export default {
  key: "update_user_memory",
  name: "Update User Memory",
  description:
    "Store important facts about the current user that should persist across conversations. Use this for user-specific preferences, profile details, or context that should not be shared with other users. Updates the user's participant profile, which is automatically injected into future prompts as USER METADATA.",
  inputSchema: {
    type: "object",
    properties: {
      key: {
        type: "string",
        description:
          "What to remember about the user (e.g., 'preferences', 'timezone', 'role', 'learnedPreferences')",
      },
      value: {
        type: "string",
        description: "The information to store about the user",
      },
      operation: {
        type: "string",
        enum: ["set", "append", "remove"],
        description:
          "How to update the memory. 'set' replaces the value, 'append' adds to an array, 'remove' deletes the key.",
        default: "set",
      },
    },
    required: ["key", "value"],
  },
  execute: async (args: UpdateUserMemoryParams, context?: ToolContext) => {
    const { key, value, operation = "set" } = args;

    if (!key || typeof key !== "string") {
      return { success: false, error: "key is required and must be a string" };
    }
    if (!value && operation !== "remove") {
      return {
        success: false,
        error: "value is required for set/append operations",
      };
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

      const metadata = applyMetadataOperation(
        existingMetadata,
        key,
        value,
        operation,
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
        message: `User memory ${
          operation === "remove" ? "removed" : "updated"
        }: ${key}`,
        stored: operation !== "remove" ? { [key]: metadata[key] } : undefined,
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
