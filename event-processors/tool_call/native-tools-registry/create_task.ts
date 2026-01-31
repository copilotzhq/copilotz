import type { ToolExecutionContext } from "../index.ts";

interface CreateTaskParams {
    name: string;
    goal: string;
}

export default {
    key: "create_task",
    name: "Create Task",
    description: "Creates a new task.",
    inputSchema: {
        type: "object",
        properties: {
            name: { type: "string", description: "The name of the task." },
            goal: { type: "string", description: "The goal of the task." },
        },
        required: ["name", "goal"],
    },
    execute: async ({ name, goal }: CreateTaskParams, context?: ToolExecutionContext) => {
        // Get database instance from context or fallback to global

        const ops = context?.db?.ops;
        const task = await ops?.createTask({ name, goal });
        return { task };
    },
}