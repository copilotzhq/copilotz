import { createCopilotz } from "@/index.ts";
import type { Agent } from "@/interfaces/index.ts";
import type { ToolExecutionContext } from "../index.ts";

interface DelegateParams {
    task: string;
    targetAgent: string;
    timeout?: number;
}

function extractTextContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter((p: { type?: string }) => p.type === "text")
            .map((p: { text?: string }) => p.text ?? "")
            .join("");
    }
    return String(content ?? "");
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

        const ops = context?.db?.ops;

        if (!context?.senderId) {
            throw new Error("Sender ID is required to delegate work");
        }

        const availableAgents = context.agents || [];
        const targetAgentConfig = availableAgents.find((agent: Agent) => agent.name === normalizedTargetAgent);

        if (!targetAgentConfig) {
            throw new Error(`Target agent "${normalizedTargetAgent}" not found in available agents: ${availableAgents.map((a: Agent) => a.name).join(', ')}`);
        }

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
            const handle = await copilotz.run({
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

            let answer: string | null = null;

            const collectEvents = (async () => {
                for await (const event of handle.events) {
                    if (
                        event.type === "NEW_MESSAGE" &&
                        (event.payload as { sender?: { type?: string } })?.sender?.type === "agent" &&
                        (event.payload as { content?: unknown })?.content
                    ) {
                        const text = extractTextContent((event.payload as { content?: unknown }).content);
                        if (text.trim()) {
                            answer = text;
                        }
                    }
                }
            })();

            const timeoutPromise = new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error("timeout")), timeout * 1000),
            );

            try {
                await Promise.race([collectEvents, timeoutPromise]);
            } catch {
                handle.cancel();
            }

            const summary = answer
                ? `Delegated task: "${normalizedTask}" - Answer: "${answer.substring(0, 100)}${answer.length > 100 ? '...' : ''}"`
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
