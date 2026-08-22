import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type { Agent } from "@copilotz/copilotz/resources";
import { resolveAgentGrants } from "@copilotz/copilotz/capabilities";
import {
  type AgentAskMetadata,
  agentAskMetadata,
  deriveWorkflowId,
  withAgentAskMetadata,
  workflowMetadata,
} from "@copilotz/copilotz/events";
import {
  deferWorkflowTool,
  type WorkflowTool,
  type WorkflowToolExecutionContext,
} from "@copilotz/copilotz/tools";
import { threadMessageFeature } from "../features/thread-message.ts";
import {
  asRecord,
  optionalText,
  requireCollection,
  requiredText,
} from "../processors/helpers.ts";

const DEFAULT_TOOL_ID = "ask";
const DEFAULT_MAX_DEPTH = 8;

function executionContext(
  value: WorkflowToolExecutionContext | undefined,
): WorkflowToolExecutionContext {
  if (!value?.processor) {
    throw new Error("The ask capability requires an event-native context.");
  }
  return value;
}

function normalizedIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function agentIdentities(agent: Agent): readonly string[] {
  return Object.freeze(
    [agent.id, agent.externalId, agent.name]
      .map(normalizedIdentity)
      .filter((value): value is string => value !== null),
  );
}

function matchesAgent(value: string, agent: Agent): boolean {
  return agentIdentities(agent).includes(value.trim().toLowerCase());
}

function resolveTargetAgent(target: string, agents: readonly Agent[]): Agent {
  const normalized = target.toLowerCase();
  const preferred = agents.filter((agent) =>
    [agent.id, agent.externalId]
      .map(normalizedIdentity)
      .includes(normalized)
  );
  const matches = preferred.length > 0
    ? preferred
    : agents.filter((agent) => normalizedIdentity(agent.name) === normalized);
  if (matches.length === 0) {
    throw new Error(
      `Target agent '${target}' was not found. Available agents: ${
        agents.map((agent) => agent.id).sort().join(", ") || "none"
      }.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `Target agent '${target}' is ambiguous; use its stable ID.`,
    );
  }
  return matches[0];
}

function assertAgentAllowed(
  asking: Agent,
  asked: Agent,
  agents: readonly Agent[],
): void {
  if (matchesAgent(asking.id, asked) || matchesAgent(asking.name, asked)) {
    throw new Error("An agent cannot ask itself.");
  }
  if (
    !resolveAgentGrants(asking, agents).some((agent) => agent.id === asked.id)
  ) {
    throw new Error(
      `Agent '${asking.id}' is not allowed to ask agent '${asked.id}'.`,
    );
  }
}

function participantForAgent(
  participants: readonly CollectionRecord[],
  agent: Agent,
): CollectionRecord | undefined {
  const identities = new Set(agentIdentities(agent));
  return participants.find((participant) =>
    participant.participantType === "agent" &&
    ((optionalText(participant.agentId) &&
      identities.has(optionalText(participant.agentId)!.toLowerCase())) ||
      identities.has(String(participant.externalId ?? "").toLowerCase()))
  );
}

export function defineAskTool(
  toolId = DEFAULT_TOOL_ID,
  maxDepth = DEFAULT_MAX_DEPTH,
): WorkflowTool {
  return Object.freeze({
    id: toolId,
    key: toolId,
    name: "Ask Agent",
    description:
      "Ask another agent in this thread a public question and resume after its public answer.",
    inputSchema: {
      type: "object",
      properties: {
        target: {
          type: "string",
          minLength: 1,
          description: "Stable ID or name of another agent in this thread.",
        },
        message: {
          type: "string",
          minLength: 1,
          description: "The complete public question for that agent.",
        },
      },
      required: ["target", "message"],
      additionalProperties: false,
    },
    historyPolicy: { visibility: "public_status" },
    async execute(raw, value) {
      const context = executionContext(value);
      const input = asRecord(raw);
      const target = requiredText(
        typeof input.target === "string" ? input.target : undefined,
        "Ask target",
      );
      const message = requiredText(
        typeof input.message === "string" ? input.message : undefined,
        "Ask message",
      );
      const execution = context.execution;
      const askingParticipantId = requiredText(
        execution.participantId,
        "Asking participant ID",
      );
      const askingRecord = await requireCollection(
        context.processor,
        "participant",
      )
        .get({ id: askingParticipantId });
      const askingParticipant = askingRecord;
      if (
        !askingParticipant || askingParticipant.participantType !== "agent"
      ) {
        throw new Error(
          `Asking participant '${askingParticipantId}' is not an agent.`,
        );
      }
      const agents = Object.values(context.processor.agents).filter(
        (value): value is Agent => !!value,
      );
      const askingAgent = context.agent ??
        (execution.agentId
          ? context.processor.agents[execution.agentId]
          : undefined);
      if (!askingAgent) {
        throw new Error(
          `Asking agent '${execution.agentId ?? "unknown"}' was not found.`,
        );
      }
      const askedAgent = resolveTargetAgent(target, agents);
      assertAgentAllowed(askingAgent, askedAgent, agents);

      const threadRecord = await requireCollection(context.processor, "thread")
        .get({ id: execution.threadId });
      if (!threadRecord) {
        throw new Error(`Thread '${execution.threadId}' was not found.`);
      }
      const participantIds = Array.isArray(threadRecord.participantIds)
        ? threadRecord.participantIds.filter((id): id is string =>
          typeof id === "string"
        )
        : [];
      const participants = (await Promise.all(
        participantIds.map((id) =>
          requireCollection(context.processor, "participant").get(
            { id },
          )
        ),
      )).filter((item): item is NonNullable<typeof item> => item !== null);
      if (!participants.some((item) => item.id === askingParticipant.id)) {
        throw new Error(
          `Asking agent '${askingAgent.id}' is not a participant in thread '${execution.threadId}'.`,
        );
      }
      const askedParticipant = participantForAgent(participants, askedAgent);
      if (!askedParticipant) {
        throw new Error(
          `Target agent '${askedAgent.id}' is not a participant in thread '${execution.threadId}'.`,
        );
      }

      const parentAsk = agentAskMetadata(execution.metadata);
      const depth = (parentAsk?.depth ?? 0) + 1;
      if (depth > maxDepth) {
        throw new Error(
          `Agent ask depth ${depth} exceeds the configured maximum of ${maxDepth}.`,
        );
      }
      const workflow = workflowMetadata(execution.metadata);
      const askId = await deriveWorkflowId("ask", execution.id);
      const questionMessageId = await deriveWorkflowId(
        "message",
        execution.id,
        "ask",
      );
      const toolInvocation = Object.freeze({
        id: execution.toolCallId,
        tool: structuredClone(execution.tool),
        args: JSON.stringify(input),
      });
      const ask: AgentAskMetadata = Object.freeze({
        schema: "copilotz.ask.v1",
        askId,
        phase: "question",
        toolExecutionId: execution.id,
        toolCallId: execution.toolCallId,
        toolInvocation,
        questionMessageId,
        askingParticipantId: askingParticipant.id,
        askingAgentId: askingAgent.id,
        askedParticipantId: askedParticipant.id,
        askedAgentId: askedAgent.id,
        ...(workflow?.llmAttemptId
          ? { callingAttemptId: workflow.llmAttemptId }
          : {}),
        ...(parentAsk
          ? {
            parentAskId: parentAsk.askId,
            parentAsk: structuredClone(parentAsk),
          }
          : {}),
        depth,
      });
      const metadata = withAgentAskMetadata(undefined, ask);
      const content = await context.processor.content.prepare(message, {
        operationKey: `ask:${askId}:question-content`,
      });
      await context.processor.feature(threadMessageFeature).create({
        id: questionMessageId,
        threadId: execution.threadId,
        sender: askingParticipant,
        recipientIds: [askedParticipant.id],
        content,
        visibility: { kind: "public" },
        metadata,
      }, {
        operationKey: `ask:${askId}:question`,
      });
      return deferWorkflowTool({
        metadata: { askId, questionMessageId, askedAgentId: askedAgent.id },
      });
    },
  } as WorkflowTool);
}

export const askTool: WorkflowTool = defineAskTool();
