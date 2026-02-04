import type { Agent, Thread } from "@/interfaces/index.ts";
import type { KnowledgeNode } from "@/database/schemas/index.ts";

export interface LLMContextData {
    threadContext: string;
    taskContext: string;
    agentContext: string;
    systemPrompt: string;
}

/**
 * Agent memory extracted from the agent's participant node.
 */
interface AgentMemory {
    workingMemory?: string;
    expertise?: string[];
    learnedPreferences?: Record<string, unknown>;
    [key: string]: unknown;
}

export function contextGenerator(
    agent: Agent,
    thread: Thread,
    activeTask: unknown,
    availableAgents: Agent[],
    allSystemAgents: Agent[],
    userMetadata?: Record<string, unknown>,
    agentNode?: KnowledgeNode  // NEW: Agent's participant node for persistent memory
): LLMContextData {
    // Enhanced participant info with clear role indicators
    const participantInfo = thread.participants?.map((p: string) => {
        const agentInfo = availableAgents.find((a: Agent) => a.name === p);
        const isUser = !agentInfo;
        const isSelf = p === agent.name;
        return [
            `- **${p}**${isSelf ? " (you)" : ""}`,
            agentInfo?.role ? `  Role: ${agentInfo.role}` : (isUser ? "  Role: User" : "  Role: N/A"),
            agentInfo?.description ? `  Description: ${agentInfo.description}` : "",
        ].filter(Boolean).join("\n");
    }).join("\n") || "N/A";

    const otherAvailableAgents = allSystemAgents.filter(a =>
        a.name !== agent.name &&
        !(thread.participants?.includes(a.name))
    );

    const availableAgentsInfo = otherAvailableAgents.length > 0 ?
        otherAvailableAgents.map(a =>
            `name: ${a.name} | role: ${a.role} | description: ${a.description || "N/A"}`
        ).join("\n- ") : "None";

    const threadContext = [
        "## CONVERSATION CONTEXT",
        "",
        `You are in thread: "${thread.name}"`,
        "",
        "### Participants",
        participantInfo,
        "",
        "### Conversation Rules",
        "- Messages from others are prefixed with [SpeakerName]: so you know who said what",
        "- Your own messages appear without prefix",
        "- To address someone, use @mention (e.g., @Researcher)",
        "- To respond to the person who addressed you, just reply normally",
        "- To hand off to someone else, @mention them in your response",
        "",
        "### Current Turn",
        "You were just addressed. Respond naturally, and @mention another participant if you want them to continue the conversation.",
        ...(otherAvailableAgents.length > 0 ? [
            "",
            "Other available agents (not in current thread):",
            `- ${availableAgentsInfo}`,
            "",
            "NOTE: You can communicate with these agents using tools like 'ask_question' for quick queries or 'create_thread' for longer discussions."
        ] : [])
    ].filter(Boolean).join("\n");

    let taskContext = "";
    if (activeTask && typeof activeTask === 'object') {
        const at = activeTask as { name?: string; goal?: string; status?: string };
        if (at.name || at.goal || at.status) {
            taskContext = [
                "## TASK CONTEXT",
                `Current task: ${at.name ?? "N/A"}`,
                `Goal: ${at.goal ?? "N/A"}`,
                `Status: ${at.status ?? "N/A"}`
            ].join("\n");
        }
    }

    const agentContext = [
        "## IDENTITY",
        `You are ${agent.name}`,
        agent.role && `Your role is: ${agent.role}`,
        agent.personality && `Personality: ${agent.personality}`,
        agent.instructions && `Your instructions are: ${agent.instructions}`,
    ].filter(Boolean).join("\n");

    const currentDate = new Date().toLocaleString();
    const dateContext = `Current date and time: ${currentDate}`;

    const threadMetadata = thread.metadata && typeof thread.metadata === "object"
        ? JSON.stringify(thread.metadata, null, 2)
        : null;

    const metadataSection = threadMetadata
        ? ["## THREAD METADATA", threadMetadata].join("\n")
        : "";

    const userMetadataSection = userMetadata && Object.keys(userMetadata).length > 0
        ? ["## USER METADATA", JSON.stringify(userMetadata, null, 2)].join("\n")
        : "";

    // Agent's persistent memory (from participant node)
    const agentData = agentNode?.data as Record<string, unknown> | undefined;
    const agentMemory = agentData?.metadata as AgentMemory | undefined;
    
    const agentMemorySection = agentMemory ? [
        "## YOUR PERSISTENT MEMORY",
        "",
        ...(agentMemory.workingMemory 
            ? [`Recent learnings: ${agentMemory.workingMemory}`] 
            : []),
        ...((agentMemory.expertise as string[])?.length 
            ? [`Your expertise areas: ${(agentMemory.expertise as string[]).join(", ")}`] 
            : []),
        ...(agentMemory.learnedPreferences 
            ? [`Learned preferences: ${JSON.stringify(agentMemory.learnedPreferences)}`] 
            : []),
    ].filter(Boolean).join("\n") : "";

    const systemPrompt = [
        threadContext, 
        taskContext, 
        agentContext, 
        agentMemorySection,  // Include agent memory before metadata
        metadataSection, 
        userMetadataSection, 
        dateContext
    ]
        .filter(Boolean)
        .join("\n\n");

    return {
        threadContext,
        taskContext,
        agentContext,
        systemPrompt,
    };
}