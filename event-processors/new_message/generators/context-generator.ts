import type { Agent, Thread } from "@/interfaces/index.ts";
import type { KnowledgeNode } from "@/database/schemas/index.ts";
import type { SkillIndexEntry } from "@/utils/loaders/skill-types.ts";
import type { AgentsFileInstructions } from "@/utils/loaders/agents-file.ts";

export interface LLMContextData {
  threadContext: string;
  taskContext: string;
  agentContext: string;
  systemPrompt: string;
}

function isDirectConversationThread(
  thread: Thread,
  availableAgents: Agent[],
  currentAgent: Agent,
): boolean {
  const participants = Array.isArray(thread.participants)
    ? thread.participants.filter((p): p is string => typeof p === "string")
    : [];

  const agentParticipantIds = new Set<string>();
  const userParticipants: string[] = [];

  for (const participant of participants) {
    const participantLower = participant.toLowerCase();
    const matchedAgent = availableAgents.find((a) =>
      (typeof a.name === "string" &&
        a.name.toLowerCase() === participantLower) ||
      (typeof a.id === "string" && a.id.toLowerCase() === participantLower)
    );

    if (matchedAgent) {
      agentParticipantIds.add((matchedAgent.id ?? matchedAgent.name) as string);
    } else {
      userParticipants.push(participant);
    }
  }

  return agentParticipantIds.size === 1 &&
    agentParticipantIds.has((currentAgent.id ?? currentAgent.name) as string) &&
    userParticipants.length === 1;
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
  agentNode?: KnowledgeNode, // Agent's participant node for persistent memory
  availableSkills?: SkillIndexEntry[],
  agentsFileInstructions?: AgentsFileInstructions | null,
): LLMContextData {
  const directConversation = isDirectConversationThread(
    thread,
    availableAgents,
    agent,
  );

  // Enhanced participant info with clear role indicators
  const participantInfo = thread.participants?.map((p: string) => {
    const agentInfo = availableAgents.find((a: Agent) => a.name === p);
    const isUser = !agentInfo;
    const isSelf = p === agent.name;
    return [
      `- **${p}**${isSelf ? " (you)" : ""}`,
      agentInfo?.role
        ? `  Role: ${agentInfo.role}`
        : (isUser ? "  Role: User" : "  Role: N/A"),
      agentInfo?.description ? `  Description: ${agentInfo.description}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n") || "N/A";

  const otherAvailableAgents = allSystemAgents.filter((a) =>
    a.name !== agent.name &&
    !(thread.participants?.includes(a.name))
  );

  const availableAgentsInfo = otherAvailableAgents.length > 0
    ? otherAvailableAgents.map((a) =>
      `name: ${a.name} | role: ${a.role} | description: ${
        a.description || "N/A"
      }`
    ).join("\n- ")
    : "None";

  const threadContext = directConversation
    ? [
      "## CONVERSATION CONTEXT",
      "",
      `You are in a direct conversation with the user in thread: "${thread.name}"`,
      "",
      "Respond directly to the user. There are no other active agent participants in this thread.",
    ].join("\n")
    : [
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
      "- Use @mention only when you intentionally want that participant to take the next turn",
      "- Do not use @mentions for casual reference, examples, summaries, or quotes",
      "- If you only want to refer to someone, write their name without @",
      "- To respond to the person who addressed you, just reply normally without @mention unless you want to hand off",
      "- Prefer a single @mention per response",
      "- Use multiple @mentions only if you intentionally want a queued sequence of turns",
      "- To return control to the human and stop agent-to-agent back-and-forth, @mention the user first and do not @mention any agent in the same reply",
      "- Never @mention yourself",
      "",
      "### Current Turn",
      "You were just addressed. Respond normally. Only use @mention if you want to explicitly hand off the next turn.",
      ...(otherAvailableAgents.length > 0
        ? [
          "",
          "Other available agents (not in current thread):",
          `- ${availableAgentsInfo}`,
          "",
          "NOTE: You can communicate with these agents using tools like 'ask_question' for quick queries or 'create_thread' for longer discussions.",
        ]
        : []),
    ].filter(Boolean).join("\n");

  let taskContext = "";
  if (activeTask && typeof activeTask === "object") {
    const at = activeTask as { name?: string; goal?: string; status?: string };
    if (at.name || at.goal || at.status) {
      taskContext = [
        "## TASK CONTEXT",
        `Current task: ${at.name ?? "N/A"}`,
        `Goal: ${at.goal ?? "N/A"}`,
        `Status: ${at.status ?? "N/A"}`,
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

  const userMetadataSection =
    userMetadata && Object.keys(userMetadata).length > 0
      ? ["## USER METADATA", JSON.stringify(userMetadata, null, 2)].join("\n")
      : "";

  // Agent's persistent memory (from participant node)
  const agentData = agentNode?.data as Record<string, unknown> | undefined;
  const agentMemory = agentData?.metadata as AgentMemory | undefined;

  const agentMemorySection = agentMemory
    ? [
      "## YOUR PERSISTENT MEMORY",
      "",
      ...(agentMemory.workingMemory
        ? [`Recent learnings: ${agentMemory.workingMemory}`]
        : []),
      ...((agentMemory.expertise as string[])?.length
        ? [
          `Your expertise areas: ${
            (agentMemory.expertise as string[]).join(", ")
          }`,
        ]
        : []),
      ...(agentMemory.learnedPreferences
        ? [
          `Learned preferences: ${
            JSON.stringify(agentMemory.learnedPreferences)
          }`,
        ]
        : []),
    ].filter(Boolean).join("\n")
    : "";

  const skillsSection = availableSkills && availableSkills.length > 0
    ? [
      "## AVAILABLE SKILLS",
      "Use the `load_skill` tool to read full instructions for any skill before executing it.",
      "",
      ...availableSkills.map((s) => `- **${s.name}**: ${s.description}`),
    ].join("\n")
    : "";

  const agentsFileSection = agentsFileInstructions?.content
    ? [
      "## LOCAL AGENTS INSTRUCTIONS",
      `Loaded from ${agentsFileInstructions.fileName} in ${agentsFileInstructions.cwd}.`,
      "",
      agentsFileInstructions.content,
    ].join("\n")
    : "";

  const systemPrompt = [
    threadContext,
    taskContext,
    agentContext,
    agentMemorySection,
    agentsFileSection,
    skillsSection,
    metadataSection,
    userMetadataSection,
    dateContext,
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
