import { runThread } from "@/runtime/index.ts";
import type { ToolExecutionContext } from "@/resources/processors/tool_call/index.ts";

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
        const db = context?.db ?? context?.dbInstance;
        if (!db) {
            throw new Error("Database instance is required to create a thread");
        }

        const threadId = crypto.randomUUID();

        const result = await runThread(
            db,
            {
                ...context,
                agents: context?.agents || [],
                tools: context?.tools || [],
            },
            {
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
            },
            { stream: context?.stream ?? false },
        );

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
    },
}
