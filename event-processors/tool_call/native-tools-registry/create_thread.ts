import { createCopilotz } from "@/index.ts";
import type { ToolExecutionContext } from "../index.ts";

interface CreateThreadParams {
    name: string;
    participants: string[];
    initialMessage?: string;
    mode?: "background" | "immediate";
    description?: string;
    summary?: string;
}

export default {
    key: "create_thread",
    name: "Create Thread",
    description: "Creates a new conversation thread.",
    inputSchema: {
        type: "object",
        properties: {
            name: { type: "string", description: "The name of the thread." },
            participants: { 
                type: "array", 
                items: { type: "string" },
                description: "Array of participant names (agent names or user IDs)." 
            },
            initialMessage: { type: "string", description: "Optional initial message to start the thread." },
            mode: { 
                type: "string", 
                enum: ["background", "immediate"],
                description: "Thread execution mode (default: immediate).",
                default: "immediate"
            },
            description: { type: "string", description: "Optional thread description." },
            summary: { type: "string", description: "Optional thread summary." },
        },
        required: ["name", "participants"],
    },
    execute: async ({ name, participants, initialMessage, mode = "immediate", description, summary }: CreateThreadParams, context?: ToolExecutionContext) => {
        // Create thread with specified participants
        const threadId = crypto.randomUUID();
        
        const initMessage = {
            content: initialMessage || `Started thread: ${name}`,
            sender: {
                type: (context?.senderType ?? "system") as "agent" | "user" | "tool" | "system",
                id: context?.senderId ?? "system",
                name: context?.senderId ?? "system",
            },
            thread: {
                id: threadId,
                name,
                participants,
            },
        };

        // Create ChatContext with inherited settings from parent
        const baseConfig = {
            agents: context?.agents || [],
            tools: context?.tools || [],
            apis: context?.apis,
            mcpServers: context?.mcpServers,
            callbacks: context?.callbacks,
            stream: context?.stream,
            activeTaskId: context?.activeTaskId,
            dbInstance: context?.db,
        };

        const copilotz = await createCopilotz(baseConfig);

        try {
            const result = await copilotz.run(initMessage);

            return {
                threadId,
                name,
                participants,
                mode,
                description,
                summary,
                queueId: result.queueId,
                status: result.status,
            };
        } finally {
            await copilotz.shutdown().catch(() => undefined);
        }
    },
}