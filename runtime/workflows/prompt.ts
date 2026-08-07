import type { Agent, Skill } from "../resources/index.ts";
import type {
  ConversationMessage,
  ConversationThread,
  LlmAttempt,
  Participant,
} from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import type { CopilotzEvent } from "../events/index.ts";
import type { ChatMessage } from "../llm/types.ts";
import { getPublicThreadMetadata } from "../thread-metadata.ts";
import { formatToolsForPrompt } from "../tools/format-tools-for-prompt.ts";
import { buildTextTranscript } from "./transcript.ts";
import type {
  AgentTextPrompt,
  CreateTextWorkflowPluginOptions,
  WorkflowPromptMemoryContribution,
  WorkflowPromptMemoryResource,
  WorkflowTool,
} from "./types.ts";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function visibleMetadata(value: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record(value)).filter(([key]) =>
      key !== "_private" && key !== "updatedAt"
    ),
  );
}

function threadName(thread: ConversationThread): string {
  const metadata = getPublicThreadMetadata(thread.metadata);
  return typeof metadata.name === "string" && metadata.name.trim()
    ? metadata.name.trim()
    : thread.externalId ?? thread.id;
}

async function resolveInstructions(
  options: CreateTextWorkflowPluginOptions,
  agent: Agent,
  thread: ConversationThread,
  userMetadata: Readonly<Record<string, unknown>> | undefined,
  sourceEvent: CopilotzEvent,
  context: CopilotzProcessorContext,
): Promise<string | null> {
  const baseInstructions = agent.instructions ?? null;
  const resolved = await options.resolveAgentInstructions?.({
    agent,
    baseInstructions,
    thread,
    userMetadata,
    sourceEvent,
    context,
  });
  if (resolved === undefined) return baseInstructions;
  if (resolved === null || typeof resolved === "string") return resolved;
  throw new TypeError(
    `instructions resolver for agent '${agent.id}' must return a string, null, or undefined.`,
  );
}

function agentForParticipant(
  agents: readonly Agent[],
  participant: Participant,
): Agent | undefined {
  return agents.find((agent) =>
    agent.id === participant.agentId || agent.id === participant.externalId ||
    agent.name === participant.externalId
  );
}

function allowedSkills(
  context: CopilotzProcessorContext,
  agent: Agent,
): readonly Skill[] {
  const skills = context.resources.list<Skill>("skills");
  if (agent.allowedSkills === undefined) return skills;
  if (!Array.isArray(agent.allowedSkills) || !agent.allowedSkills.length) {
    return Object.freeze([]);
  }
  const allowed = new Set(agent.allowedSkills);
  return Object.freeze(skills.filter((skill) => allowed.has(skill.name)));
}

function systemPrompt(
  input: Readonly<{
    agent: Agent;
    instructions: string | null;
    thread: ConversationThread;
    participant: Participant;
    agents: readonly Agent[];
    skills: readonly Skill[];
    userMetadata?: Readonly<Record<string, unknown>>;
    agentsFileInstructions?:
      CreateTextWorkflowPluginOptions["agentsFileInstructions"];
    memory?: readonly WorkflowPromptMemoryContribution[];
  }>,
): string {
  const activeAgents = input.thread.participants.filter((participant) =>
    participant.participantType === "agent"
  );
  const humans = input.thread.participants.filter((participant) =>
    participant.participantType === "human"
  );
  const direct = activeAgents.length === 1 && humans.length === 1 &&
    activeAgents[0]?.id === input.participant.id;
  const participantInfo = input.thread.participants.map((participant) => {
    const configured = agentForParticipant(input.agents, participant);
    return [
      `- **${participant.name ?? participant.externalId}**${
        participant.id === input.participant.id ? " (you)" : ""
      }`,
      `  Role: ${
        configured?.role ??
          (participant.participantType === "human"
            ? "User"
            : participant.participantType)
      }`,
      configured?.description ? `  Description: ${configured.description}` : "",
    ].filter(Boolean).join("\n");
  }).join("\n");
  const activeAgentIds = new Set(activeAgents.flatMap((participant) =>
    [
      participant.agentId,
      participant.externalId,
    ].filter((value): value is string => typeof value === "string")
  ));
  const otherAgents = input.agents.filter((agent) =>
    agent.id !== input.agent.id && !activeAgentIds.has(agent.id) &&
    !activeAgentIds.has(agent.name)
  );
  const conversation = direct
    ? [
      "## CONVERSATION CONTEXT",
      `You are in a direct conversation with the user in thread: \"${
        threadName(input.thread)
      }\".`,
    ]
    : [
      "## CONVERSATION CONTEXT",
      `You are in thread: \"${threadName(input.thread)}\".`,
      "",
      "### Participants",
      participantInfo || "N/A",
      "",
      "### Conversation Rules",
      "- Messages from other participants are labelled with their speaker.",
      "- Reply normally to the participant who addressed you.",
    ];
  if (otherAgents.length) {
    conversation.push(
      "",
      "Other available agents:",
      ...otherAgents.map((agent) =>
        `- ${agent.name} | role: ${agent.role} | description: ${
          agent.description ?? "N/A"
        }`
      ),
    );
  }

  const participantMemory = record(input.participant.metadata);
  const memory = [
    typeof participantMemory.workingMemory === "string"
      ? `Recent learnings: ${participantMemory.workingMemory}`
      : "",
    Array.isArray(participantMemory.expertise) &&
      participantMemory.expertise.length
      ? `Your expertise areas: ${participantMemory.expertise.join(", ")}`
      : "",
    record(participantMemory.learnedPreferences) &&
      Object.keys(record(participantMemory.learnedPreferences)).length
      ? `Learned preferences: ${
        JSON.stringify(participantMemory.learnedPreferences)
      }`
      : "",
  ].filter(Boolean);
  const publicMetadata = getPublicThreadMetadata(input.thread.metadata);
  const sections = [
    input.agentsFileInstructions?.content
      ? [
        "## LOCAL AGENTS INSTRUCTIONS",
        `Loaded from ${input.agentsFileInstructions.fileName}.`,
        "",
        input.agentsFileInstructions.content,
      ].join("\n")
      : "",
    input.skills.length
      ? [
        "## AVAILABLE SKILLS",
        "Use the `load_skill` tool to read full instructions before using a skill.",
        "",
        ...input.skills.map((skill) =>
          `- **${skill.name}**: ${skill.description}`
        ),
      ].join("\n")
      : "",
    [
      "## IDENTITY",
      `You are ${input.agent.name}`,
      input.agent.role ? `Your role is: ${input.agent.role}` : "",
      input.agent.personality ? `Personality: ${input.agent.personality}` : "",
      input.instructions ? `Your instructions are: ${input.instructions}` : "",
    ].filter(Boolean).join("\n"),
    memory.length
      ? ["## YOUR PERSISTENT MEMORY", "", ...memory].join("\n")
      : "",
    ...(input.memory ?? []).flatMap((contribution) =>
      contribution.section ? [contribution.section] : []
    ),
    conversation.filter(Boolean).join("\n"),
    Object.keys(publicMetadata).length
      ? [
        "## THREAD METADATA",
        JSON.stringify(publicMetadata, null, 2),
      ].join("\n")
      : "",
    input.userMetadata && Object.keys(input.userMetadata).length
      ? [
        "## USER METADATA",
        JSON.stringify(input.userMetadata, null, 2),
      ].join("\n")
      : "",
  ];
  return sections.filter(Boolean).join("\n\n");
}

function isPromptMemoryResource(
  value: unknown,
): value is WorkflowPromptMemoryResource {
  const candidate = record(value);
  return typeof candidate.name === "string" &&
    typeof candidate.kind === "string" &&
    candidate.enabled !== false && typeof candidate.contribute === "function";
}

async function promptMemory(
  context: CopilotzProcessorContext,
  input: Readonly<{
    agent: Agent;
    participant: Participant;
    thread: ConversationThread;
    history: readonly ConversationMessage[];
    sourceEvent: CopilotzEvent;
  }>,
): Promise<readonly WorkflowPromptMemoryContribution[]> {
  const contributions: WorkflowPromptMemoryContribution[] = [];
  for (
    const resource of context.resources.list<WorkflowPromptMemoryResource>(
      "memory",
    ).filter(isPromptMemoryResource)
  ) {
    const contribution = await resource.contribute({ ...input, context });
    if (!contribution) continue;
    contributions.push(Object.freeze(structuredClone(contribution)));
  }
  return Object.freeze(contributions);
}

function historyIdsAfterMemory(
  ids: readonly string[],
  history: readonly ConversationMessage[],
  contributions: readonly WorkflowPromptMemoryContribution[],
): readonly string[] {
  const positions = new Map(
    history.map((message, index) => [message.id, index]),
  );
  let boundary = -1;
  for (const contribution of contributions) {
    if (!contribution.historyAfterMessageId) continue;
    const position = positions.get(contribution.historyAfterMessageId);
    if (position !== undefined) boundary = Math.max(boundary, position);
  }
  if (boundary < 0) return ids;
  const selected = ids.filter((id) => (positions.get(id) ?? -1) > boundary);
  return Object.freeze(selected);
}

function selectedRawMessages(
  history: readonly ConversationMessage[],
  ids: readonly string[],
  threadId: string,
): readonly ConversationMessage[] {
  const byId = new Map(history.map((message) => [message.id, message]));
  return Object.freeze(ids.map((id) => {
    const message = byId.get(id);
    if (!message) {
      throw new Error(
        `LLM input message '${id}' was not found in '${threadId}'.`,
      );
    }
    return message;
  }));
}

/** Builds one immutable, participant-relative text prompt snapshot. */
export async function buildAgentTextPrompt(
  context: CopilotzProcessorContext,
  input: Readonly<{
    options: CreateTextWorkflowPluginOptions;
    agent: Agent;
    participant: Participant;
    attempt: LlmAttempt;
    sourceEvent: CopilotzEvent;
    tools: readonly WorkflowTool[];
  }>,
): Promise<AgentTextPrompt> {
  const thread = await context.conversation.getThread(input.attempt.threadId);
  if (!thread) {
    throw new Error(`Thread '${input.attempt.threadId}' was not found.`);
  }
  const human = input.attempt.initiatorParticipantId
    ? thread.participants.find((participant) =>
      participant.id === input.attempt.initiatorParticipantId &&
      participant.participantType === "human"
    )
    : thread.participants.find((participant) =>
      participant.participantType === "human"
    );
  const userMetadata = input.options.userMetadata ??
    (human ? visibleMetadata(human.metadata) : undefined);
  const instructions = await resolveInstructions(
    input.options,
    input.agent,
    thread,
    userMetadata,
    input.sourceEvent,
    context,
  );
  const rawHistory = await context.conversation.listMessages(
    input.attempt.threadId,
    { limit: 1_000 },
  );
  const memoryContributions = await promptMemory(context, {
    agent: input.agent,
    participant: input.participant,
    thread,
    history: rawHistory,
    sourceEvent: input.sourceEvent,
  });
  const selectedMessageIds = historyIdsAfterMemory(
    input.attempt.inputMessageIds,
    rawHistory,
    memoryContributions,
  );
  const rawMessages = selectedRawMessages(
    rawHistory,
    selectedMessageIds,
    input.attempt.threadId,
  );
  const generated = await buildTextTranscript(context, {
    threadId: input.attempt.threadId,
    messageIds: selectedMessageIds,
    participantId: input.participant.id,
    reasoningHistory: input.options.reasoningHistory,
    maxToolResultEstimatedTokens:
      input.options.toolResultHistoryMaxEstimatedTokens,
  });
  const history = input.options.historyTransform
    ? await input.options.historyTransform({
      messages: generated,
      rawMessages,
      thread,
      agent: input.agent,
      sourceEvent: input.sourceEvent,
      context,
    })
    : generated;
  if (!Array.isArray(history)) {
    throw new TypeError(
      "historyTransform must return an array of chat messages.",
    );
  }
  const prompt = systemPrompt({
    agent: input.agent,
    instructions,
    thread,
    participant: input.participant,
    agents: context.resources.list<Agent>("agents"),
    skills: allowedSkills(context, input.agent),
    userMetadata,
    agentsFileInstructions: input.options.agentsFileInstructions,
    memory: memoryContributions,
  });
  const tools = Object.freeze(formatToolsForPrompt([...input.tools]));
  const messages: readonly ChatMessage[] = Object.freeze([
    ...(prompt ? [{ role: "system" as const, content: prompt }] : []),
    ...history.map((message) => structuredClone(message)),
  ]);
  return Object.freeze({
    thread,
    participant: input.participant,
    rawMessages,
    messages,
    tools,
    memory: memoryContributions,
    ...(userMetadata ? { userMetadata } : {}),
  });
}
