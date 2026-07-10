import type { Agent, Thread } from "@/types/index.ts";
import type { KnowledgeNode } from "@/database/schemas/index.ts";
import type { SkillIndexEntry } from "@/runtime/loaders/skill-types.ts";
import type { AgentsFileInstructions } from "@/runtime/loaders/agents-file.ts";
import { getPublicThreadMetadata } from "@/runtime/thread-metadata.ts";

export interface LLMContextData {
  threadContext: string;
  agentContext: string;
  systemPrompt: string;
}

export function isDirectConversationThread(
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

function participantMatchesAgent(
  participant: string,
  agent: Agent,
): boolean {
  const participantLower = participant.toLowerCase();
  return (
    (typeof agent.name === "string" &&
      agent.name.toLowerCase() === participantLower) ||
    (typeof agent.id === "string" &&
      agent.id.toLowerCase() === participantLower)
  );
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
  availableAgents: Agent[],
  allSystemAgents: Agent[],
  userMetadata?: Record<string, unknown>,
  agentNode?: KnowledgeNode,
  availableSkills?: SkillIndexEntry[],
  agentsFileInstructions?: AgentsFileInstructions | null,
  routingControlsEnabled = false,
): LLMContextData {
  const directConversation = isDirectConversationThread(
    thread,
    availableAgents,
    agent,
  );

  // Enhanced participant info with clear role indicators
  const participantInfo = thread.participants?.map((p: string) => {
    const agentInfo = availableAgents.find((a: Agent) =>
      participantMatchesAgent(p, a)
    );
    const isUser = !agentInfo;
    const isSelf = participantMatchesAgent(p, agent);
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
    !(thread.participants?.some((participant) =>
      participantMatchesAgent(participant, a)
    ))
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
      "There are no other active agent participants in this thread.",
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
      ...(routingControlsEnabled
        ? [
          "- Use ask_in_thread to send an atomic message to another agent and resume after its reply",
          "- Use handoff_in_thread to send an atomic message and transfer the next turn without automatically returning control",
          "- Both routing controls require exactly target and message; the message argument is what the target receives",
          "- Use at most one in-thread routing control per response and never target yourself",
          "- Reply normally without a routing control when the response should return to the person who addressed you",
        ]
        : [
          "- Reply normally to the person who addressed you",
        ]),
      ...(otherAvailableAgents.length > 0
        ? [
          "",
          "Other available agents (not in current thread):",
          `- ${availableAgentsInfo}`,
          "",
          "NOTE: You can communicate with these agents using tools like 'delegate' for focused offloaded work or 'create_thread' for longer discussions.",
        ]
        : []),
    ].filter(Boolean).join("\n");

  const agentContext = [
    "## IDENTITY",
    `You are ${agent.name}`,
    agent.role && `Your role is: ${agent.role}`,
    agent.personality && `Personality: ${agent.personality}`,
    agent.instructions && `Your instructions are: ${agent.instructions}`,
  ].filter(Boolean).join("\n");

  const currentDate = new Date().toISOString().slice(0, 10);
  const dateContext = `Current date: ${currentDate}`;

  const publicThreadMetadata = getPublicThreadMetadata(thread.metadata);
  const threadMetadata = Object.keys(publicThreadMetadata).length > 0
    ? JSON.stringify(publicThreadMetadata, null, 2)
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
      `Loaded from ${agentsFileInstructions.fileName}.`,
      "",
      agentsFileInstructions.content,
    ].join("\n")
    : "";

  const systemPrompt = [
    // Keep stable, shared instructions first for provider prompt caching.
    agentsFileSection,
    skillsSection,
    agentContext,
    agentMemorySection,
    threadContext,
    metadataSection,
    userMetadataSection,
    dateContext,
  ]
    .filter(Boolean)
    .join("\n\n");

  return {
    threadContext,
    agentContext,
    systemPrompt,
  };
}
