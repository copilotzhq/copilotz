/**
 * Native tool for agents to update their own persistent memory.
 * Allows agents to store important learnings or preferences that persist across conversations.
 */

import { createParticipantService } from "@/runtime/collections/native.ts";
import type {
  CollectionsManager,
  CopilotzDb,
  ScopedCollectionsManager,
} from "@/types/index.ts";

interface UpdateMyMemoryParams {
    key: string;
    value: string;
    operation?: "set" | "append" | "remove";
}

interface ToolContext {
    senderId?: string;
    namespace?: string;
    collections?: CollectionsManager | ScopedCollectionsManager;
    db?: {
        ops: {
            getParticipantNode: (externalId: string, namespace?: string | null) => Promise<unknown | undefined>;
            updateNode: (id: string, updates: { data?: Record<string, unknown> }) => Promise<unknown>;
        };
    };
}

export default {
    key: "update_my_memory",
    name: "Update My Memory",
    description: "Store important learnings or preferences that you want to remember across conversations. Use this to persist insights about users, topics you've learned, or any information that would be useful to recall in future conversations.",
    inputSchema: {
        type: "object",
        properties: {
            key: {
                type: "string",
                description: "What to remember (e.g., 'user_preference', 'learned_fact', 'expertise', 'working_memory')"
            },
            value: {
                type: "string",
                description: "The information to store"
            },
            operation: {
                type: "string",
                enum: ["set", "append", "remove"],
                description: "How to update the memory. 'set' replaces the value, 'append' adds to an array, 'remove' deletes the key.",
                default: "set"
            }
        },
        required: ["key", "value"]
    },
    execute: async (args: UpdateMyMemoryParams, context?: ToolContext) => {
        const { key, value, operation = "set" } = args;
        
        if (!key || typeof key !== "string") {
            return { success: false, error: "key is required and must be a string" };
        }
        if (!value && operation !== "remove") {
            return { success: false, error: "value is required for set/append operations" };
        }
        
        const agentId = context?.senderId;
        if (!agentId) {
            return { success: false, error: "Agent context not available" };
        }
        
        const ops = context?.db?.ops;
        if (!ops) {
            return { success: false, error: "Database not available" };
        }
        
        try {
            const participantService = createParticipantService({
                collections: context?.collections,
                ops: ops as CopilotzDb["ops"],
            });
            const agentParticipant = await participantService.get(agentId, context?.namespace ?? null);

            if (!agentParticipant) {
                return { 
                    success: false, 
                    error: `Agent node not found for "${agentId}". Memory update skipped.` 
                };
            }

            const metadata = { ...((agentParticipant.metadata ?? {}) as Record<string, unknown>) };
            
            if (operation === "set") {
                metadata[key] = value;
            } else if (operation === "append") {
                const existing = metadata[key];
                if (Array.isArray(existing)) {
                    existing.push(value);
                } else if (existing) {
                    metadata[key] = [existing, value];
                } else {
                    metadata[key] = [value];
                }
            } else if (operation === "remove") {
                delete metadata[key];
            }

            await participantService.upsert(
                agentId,
                (agentParticipant.participantType ?? "agent") as "human" | "agent",
                context?.namespace ?? null,
                {
                    name: (agentParticipant.name ?? null) as string | null,
                    email: (agentParticipant.email ?? null) as string | null,
                    agentId: (agentParticipant.agentId ?? agentId) as string | null,
                    metadata,
                },
            );
            
            return { 
                success: true, 
                message: `Memory ${operation === "remove" ? "removed" : "updated"}: ${key}`,
                stored: operation !== "remove" ? { [key]: metadata[key] } : undefined
            };
        } catch (error) {
            return { 
                success: false, 
                error: `Failed to update memory: ${error instanceof Error ? error.message : String(error)}` 
            };
        }
    },
};
