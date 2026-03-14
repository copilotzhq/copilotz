import { createCopilotz } from "@/index.ts";
import type { Agent, Message } from "@/interfaces/index.ts";
import type { ToolExecutionContext } from "../index.ts";

interface AskQuestionParams {
    question: string;
    targetAgent: string;
    timeout?: number;
}

export default {
    key: "ask_question",
    name: "Ask Question",
    description: "Ask a specific question to another agent and get a single answer. Creates a temporary thread that closes after receiving the response.",
    inputSchema: {
        type: "object",
        properties: {
            question: { type: "string", minLength: 1, description: "The question to ask." },
            targetAgent: { type: "string", minLength: 1, description: "The name of the agent to ask the question to." },
            timeout: { type: "number", description: "Maximum time to wait for answer in seconds (default: 30)." },
        },
        required: ["question", "targetAgent"],
    },
    execute: async ({ question, targetAgent, timeout = 30 }: AskQuestionParams, context?: ToolExecutionContext) => {
        const normalizedQuestion = typeof question === "string" ? question.trim() : "";
        const normalizedTargetAgent = typeof targetAgent === "string" ? targetAgent.trim() : "";

        if (!normalizedQuestion) {
            throw new Error("Question is required and cannot be empty");
        }

        if (!normalizedTargetAgent) {
            throw new Error("Target agent is required and cannot be empty");
        }

        // Get database instance from context or fallback to global
        const ops = context?.db?.ops;

        if (!context?.senderId) {
            throw new Error("Sender ID is required to ask questions");
        }

        // Check if target agent exists in available agents
        const availableAgents = context.agents || [];
        const targetAgentConfig = availableAgents.find((agent: Agent) => agent.name === normalizedTargetAgent);

        if (!targetAgentConfig) {
            throw new Error(`Target agent "${normalizedTargetAgent}" not found in available agents: ${availableAgents.map((a: Agent) => a.name).join(', ')}`);
        }

        // Create a temporary thread for the question
        const questionThreadId = crypto.randomUUID();

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
                content: normalizedQuestion,
                sender: {
                    type: (context.senderType ?? "user") as "agent" | "user" | "tool" | "system",
                    id: context.senderId,
                    name: context.senderId ?? null,
                },
                thread: {
                    id: questionThreadId,
                    name: `Question from ${context.senderId}`,
                    participants: [normalizedTargetAgent],
                },
            });

            // Poll for the answer with timeout
            const startTime = Date.now();
            const timeoutMs = timeout * 1000;
            let answer = null;

            while (Date.now() - startTime < timeoutMs) {
                // Get message history for the question thread
                const messages = await ops?.getMessageHistory(questionThreadId, normalizedTargetAgent, 10);

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

            // Archive the question thread
            const summary = answer
                ? `Question: "${normalizedQuestion}" - Answer: "${answer?.substring(0, 100)}${answer?.length > 100 ? '...' : ''}"`
                : `Question: "${normalizedQuestion}" - No answer received (timeout)`;

            await ops?.archiveThread(questionThreadId, summary);

            if (!answer) {
                throw new Error(`No answer received from ${normalizedTargetAgent} within ${timeout} seconds`);
            }

            return {
                success: true,
                question: normalizedQuestion,
                answer,
                targetAgent: normalizedTargetAgent,
                threadId: questionThreadId,
            };

        } catch (error) {
            return {
                success: false,
                error: error instanceof Error ? error.message : String(error),
                question: normalizedQuestion,
                targetAgent: normalizedTargetAgent,
            };
        } finally {
            await copilotz.shutdown().catch(() => undefined);
        }
    },
};
