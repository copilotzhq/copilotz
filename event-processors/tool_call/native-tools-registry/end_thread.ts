import type { ToolExecutionContext } from "../index.ts";

interface EndThreadParams {
    summary: string;
}

export default {
    key: "end_thread",
    name: "End Thread",
    description: "Ends a thread.",
    inputSchema: {
        type: "object",
        properties: {
            summary: { type: "string", description: "The summary of the thread." },
        },
        required: ["summary"],
    },
    outputSchema: null,
    execute: async ({ summary }: EndThreadParams, context?: ToolExecutionContext) => {
        // Get database instance from context or fallback to global
        const ops = context?.db?.ops;
        
        if (!context?.threadId) {
            throw new Error("Thread ID is required to end a thread");
        }

        await ops?.archiveThread(context.threadId, summary);
        
        return { 
            threadId: context.threadId,
            summary,
            status: "archived" 
        };
    },
}
