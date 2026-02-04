/**
 * Native tool for agents to update their own persistent memory.
 * Allows agents to store important learnings or preferences that persist across conversations.
 */

interface UpdateMyMemoryParams {
    key: string;
    value: string;
    operation?: "set" | "append" | "remove";
}

interface ToolContext {
    senderId?: string;
    namespace?: string;
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
        
        // Validate inputs
        if (!key || typeof key !== "string") {
            return { success: false, error: "key is required and must be a string" };
        }
        if (!value && operation !== "remove") {
            return { success: false, error: "value is required for set/append operations" };
        }
        
        // Get the agent's ID (senderId in tool context is the agent)
        const agentId = context?.senderId;
        if (!agentId) {
            return { success: false, error: "Agent context not available" };
        }
        
        // Get database operations
        const ops = context?.db?.ops;
        if (!ops) {
            return { success: false, error: "Database not available" };
        }
        
        try {
            // Get agent's participant node
            const agentNode = await ops.getParticipantNode(agentId, context?.namespace);
            
            if (!agentNode) {
                return { 
                    success: false, 
                    error: `Agent node not found for "${agentId}". Memory update skipped.` 
                };
            }
            
            const nodeWithId = agentNode as { id: string; data: Record<string, unknown> };
            const data = nodeWithId.data ?? {};
            const metadata = (data.metadata ?? {}) as Record<string, unknown>;
            
            // Apply operation
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
            
            // Persist
            await ops.updateNode(nodeWithId.id, { 
                data: { ...data, metadata } 
            });
            
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
