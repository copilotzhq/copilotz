import { createCopilotz } from "@/index.ts";
import type { Agent, Message } from "@/interfaces/index.ts";
import type { ToolExecutionContext } from "../index.ts";

interface DelegateParams {
    task: string;
    targetAgent: string;
    timeout?: number;
}

export default {
    key: "delegate",
    name: "Delegate",
    description: "Delegate a focused subtask to another agent in a separate thread and wait for that agent's final answer.",
    inputSchema: {
        type: "object",
        properties: {
            task: { type: "string", minLength: 1, description: "The focused task or request to delegate." },
            targetAgent: { type: "string", minLength: 1, description: "The name or id of the agent to delegate the task to." },
            timeout: { type: "number", description: "Maximum time to wait for the delegated answer in seconds (default: 30)." },
        },
        required: ["task", "targetAgent"],
    },
    execute: async ({ task, targetAgent, timeout = 30 }: DelegateParams, context?: ToolExecutionContext) => {
        const normalizedTask = typeof task === "string" ? task.trim() : "";
        const normalizedTargetAgent = typeof targetAgent === "string" ? targetAgent.trim() : "";

        if (!normalizedTask) {
            throw new Error("Task is required and cannot be empty");
        }

        if (!normalizedTargetAgent) {
            throw new Error("Target agent is required and cannot be empty");
        }

        // Get database instance from context or fallback to global
        const ops = context?.db?.ops;

        if (!context?.senderId) {
            throw new Error("Sender ID is required to delegate work");
        }

        // Check if target agent exists in available agents
        const availableAgents = context.agents || [];
        const targetAgentConfig = availableAgents.find((agent: Agent) => agent.name === normalizedTargetAgent);

        if (!targetAgentConfig) {
            throw new Error(`Target agent "${normalizedTargetAgent}" not found in available agents: ${availableAgents.map((a: Agent) => a.name).join(', ')}`);
        }

        // Create a temporary thread for the delegated task
        const delegatedThreadId = crypto.randomUUID();

        const copilotz = await createCopilotz({
            agents: [targetAgentConfig],
            tools: context.tools || [],
            apis: context.apis,
            mcpServers: context.mcpServers,
            callbacks: context.callbacks,
            dbInstance: context?.db,
            stream: true,
        });

        try {
            await copilotz.run({
                content: normalizedTask,
                sender: {
                    type: (context.senderType ?? "user") as "agent" | "user" | "tool" | "system",
                    id: context.senderId,
                    name: context.senderId ?? null,
                },
                thread: {
                    id: delegatedThreadId,
                    name: `Delegated task from ${context.senderId}`,
                    participants: [normalizedTargetAgent],
                },
            });

            // Poll for the answer with timeout
            const startTime = Date.now();
            const timeoutMs = timeout * 1000;
            let answer = null;

            while (Date.now() - startTime < timeoutMs) {
                // Get message history for the question thread
                const messages = await ops?.getMessageHistory(delegatedThreadId, normalizedTargetAgent, 10);

                // Look for a response from the target agent (excluding the initial question)
                const targetAgentResponse = messages?.find((msg: Message) =>
                    msg.senderId === normalizedTargetAgent &&
                    msg.senderType === "agent" &&
                    msg.content &&
                    msg.content.trim() !== ""
                );

                if (targetAgentResponse) {
                    answer = targetAgentResponse.content;
                    break;
                }

                // Wait a bit before checking again
                await new Promise(resolve => setTimeout(resolve, 500));
            }

            // Archive the delegated sub-thread
            const summary = answer
                ? `Delegated task: "${normalizedTask}" - Answer: "${answer?.substring(0, 100)}${answer?.length > 100 ? '...' : ''}"`
                : `Delegated task: "${normalizedTask}" - No answer received (timeout)`;

            await ops?.archiveThread(delegatedThreadId, summary);

            if (!answer) {
                throw new Error(`No answer received from ${normalizedTargetAgent} within ${timeout} seconds`);
            }

            return {
                success: true,
                task: normalizedTask,
                answer,
                targetAgent: normalizedTargetAgent,
                threadId: delegatedThreadId,
            };

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                task: normalizedTask,
                targetAgent: normalizedTargetAgent,
            };
        } finally {
            await copilotz.shutdown().catch(() => undefined);
        }
    },
};
