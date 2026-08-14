import { resolveAgentGrants } from "../capabilities/index.ts";
import type { Agent } from "../resources/index.ts";
import type {
  LlmAttempt,
  Participant,
  SafeWorkflowError,
  ToolExecution,
} from "../domain/index.ts";
import type { CopilotzProcessorContext } from "../engine/index.ts";
import {
  type CopilotzPlugin,
  definePlugin,
  defineProcessor,
  type Processor,
} from "../plugins/index.ts";
import {
  agentAskMetadata,
  withAgentAskMetadata,
  workflowMetadata,
} from "./resources.ts";
import { deferWorkflowTool } from "./tool-executor.ts";
import { deriveWorkflowId } from "./identity.ts";
import type {
  AgentAskMetadata,
  CreateAgentAskPluginOptions,
  WorkflowTool,
  WorkflowToolExecutionContext,
} from "./types.ts";

const DEFAULT_PLUGIN_ID = "@copilotz/agent-ask";
const DEFAULT_PLUGIN_VERSION = "3.0.0";
const DEFAULT_TOOL_ID = "ask";
const DEFAULT_MAX_DEPTH = 8;

function requiredText(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
  return value.trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

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

function resolveTargetAgent(
  target: string,
  agents: readonly Agent[],
): Agent {
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
  participants: readonly Participant[],
  agent: Agent,
): Participant | undefined {
  const identities = new Set(agentIdentities(agent));
  return participants.find((participant) =>
    participant.participantType === "agent" &&
    ((participant.agentId &&
      identities.has(participant.agentId.toLowerCase())) ||
      identities.has(participant.externalId.toLowerCase()))
  );
}

function participantInput(participant: Participant) {
  return {
    id: participant.id,
    externalId: participant.externalId,
    participantType: participant.participantType,
    ...(participant.name ? { name: participant.name } : {}),
    ...(participant.email ? { email: participant.email } : {}),
    ...(participant.agentId ? { agentId: participant.agentId } : {}),
    metadata: structuredClone(participant.metadata),
  } as const;
}

function positiveDepth(value: number | undefined): number {
  const depth = value ?? DEFAULT_MAX_DEPTH;
  if (!Number.isSafeInteger(depth) || depth < 1) {
    throw new TypeError("Agent ask maxDepth must be a positive safe integer.");
  }
  return depth;
}

function defineAskTool(
  toolId: string,
  maxDepth: number,
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
      const input = record(raw);
      const target = requiredText(input.target, "Ask target");
      const message = requiredText(input.message, "Ask message");
      const execution = context.execution;
      const askingParticipantId = requiredText(
        execution.participantId,
        "Asking participant ID",
      );
      const askingParticipant = await context.processor.conversation
        .getParticipant(askingParticipantId);
      if (
        !askingParticipant || askingParticipant.participantType !== "agent"
      ) {
        throw new Error(
          `Asking participant '${askingParticipantId}' is not an agent.`,
        );
      }
      const agents = context.processor.resources.list<Agent>("agents");
      const askingAgent = context.agent ??
        (execution.agentId
          ? context.processor.resources.get<Agent>("agents", execution.agentId)
          : undefined);
      if (!askingAgent) {
        throw new Error(
          `Asking agent '${execution.agentId ?? "unknown"}' was not found.`,
        );
      }
      const askedAgent = resolveTargetAgent(target, agents);
      assertAgentAllowed(askingAgent, askedAgent, agents);

      const thread = await context.processor.conversation.getThread(
        execution.threadId,
      );
      if (!thread) {
        throw new Error(`Thread '${execution.threadId}' was not found.`);
      }
      if (
        !thread.participants.some((item) => item.id === askingParticipant.id)
      ) {
        throw new Error(
          `Asking agent '${askingAgent.id}' is not a participant in thread '${thread.id}'.`,
        );
      }
      const askedParticipant = participantForAgent(
        thread.participants,
        askedAgent,
      );
      if (!askedParticipant) {
        throw new Error(
          `Target agent '${askedAgent.id}' is not a participant in thread '${thread.id}'.`,
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
      const ask: AgentAskMetadata = Object.freeze({
        schema: "copilotz.ask.v1",
        askId,
        phase: "question",
        toolExecutionId: execution.id,
        questionMessageId,
        askingParticipantId: askingParticipant.id,
        askingAgentId: askingAgent.id,
        askedParticipantId: askedParticipant.id,
        askedAgentId: askedAgent.id,
        ...(workflow?.llmAttemptId
          ? { callingAttemptId: workflow.llmAttemptId }
          : {}),
        ...(parentAsk ? { parentAskId: parentAsk.askId } : {}),
        depth,
      });
      const metadata = withAgentAskMetadata(undefined, ask);
      const content = await context.processor.content.prepare(message, {
        operationKey: `ask:${askId}:question-content`,
      });
      await context.processor.conversation.createMessage({
        id: questionMessageId,
        threadId: thread.id,
        sender: participantInput(askingParticipant),
        recipientIds: [askedParticipant.id],
        content,
        visibility: { kind: "public" },
        metadata,
      }, {
        operationKey: `ask:${askId}:question`,
        metadata,
      });
      return deferWorkflowTool({
        metadata: { askId, questionMessageId, askedAgentId: askedAgent.id },
      });
    },
  } as WorkflowTool);
}

function assertAnswerMatches(
  ask: AgentAskMetadata,
  message: { threadId: string; sender: Participant },
  execution: ToolExecution,
): void {
  if (
    message.threadId !== execution.threadId ||
    ask.toolExecutionId !== execution.id ||
    message.sender.id !== ask.askedParticipantId ||
    execution.participantId !== ask.askingParticipantId
  ) {
    throw new Error(`Ask '${ask.askId}' answer ownership does not match.`);
  }
}

function completeAskProcessor(): Processor<CopilotzProcessorContext> {
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.complete-agent-ask",
    on: ["message.created"],
    delivery: "durable",
    filter: (event) => agentAskMetadata(event.metadata)?.phase === "answer",
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const message = await context.conversation.getMessage(event.subject.id);
      if (!message) {
        throw new Error(`Ask answer '${event.subject.id}' was not found.`);
      }
      const ask = agentAskMetadata(message.metadata);
      if (!ask || ask.phase !== "answer") return;
      const execution = await context.toolExecutions.get(ask.toolExecutionId);
      if (!execution) {
        throw new Error(
          `Ask tool execution '${ask.toolExecutionId}' was not found.`,
        );
      }
      assertAnswerMatches(ask, message, execution);
      if (execution.status !== "running" && execution.status !== "pending") {
        return;
      }
      const output = await context.content.prepare({
        type: "json",
        value: {
          status: "answered",
          askId: ask.askId,
          questionMessageId: ask.questionMessageId,
          answerMessageId: message.id,
          askedAgentId: ask.askedAgentId,
          askedParticipantId: ask.askedParticipantId,
        },
        role: "tool.output",
      }, { operationKey: `ask:${ask.askId}:answer-output` });
      await context.toolExecutions.complete({
        id: execution.id,
        output,
        projectedOutput: output,
        historyVisibility: execution.historyVisibility ?? "public_status",
      }, { operationKey: `ask:${ask.askId}:complete` });
    },
  });
}

function askFailure(
  attempt: LlmAttempt,
  ask: AgentAskMetadata,
  cancelled: boolean,
): SafeWorkflowError {
  const cause = attempt.safeError?.message ??
    (cancelled ? "The asked agent was cancelled." : "The asked agent failed.");
  return Object.freeze({
    name: cancelled ? "AgentAskCancelled" : "AgentAskFailed",
    code: cancelled ? "ask_cancelled" : "ask_failed",
    message: cancelled
      ? `Ask to agent '${ask.askedAgentId}' was cancelled: ${cause}`
      : `Asked agent '${ask.askedAgentId}' failed: ${cause}`,
    retryable: false,
  });
}

function failAskProcessor(): Processor<CopilotzProcessorContext> {
  return defineProcessor<CopilotzProcessorContext>({
    id: "copilotz.core.fail-agent-ask",
    on: ["llm_attempt.failed", "llm_attempt.cancelled"],
    delivery: "durable",
    async handle(event, context) {
      if (!event.durable || !event.subject) return;
      const attempt = await context.llmAttempts.get(event.subject.id);
      if (!attempt) {
        throw new Error(`LLM attempt '${event.subject.id}' was not found.`);
      }
      const ask = agentAskMetadata(attempt.metadata);
      if (!ask || ask.phase === "answer") return;
      if (attempt.participantId !== ask.askedParticipantId) {
        throw new Error(`Ask '${ask.askId}' failure ownership does not match.`);
      }
      const execution = await context.toolExecutions.get(ask.toolExecutionId);
      if (!execution) {
        throw new Error(
          `Ask tool execution '${ask.toolExecutionId}' was not found.`,
        );
      }
      if (execution.status !== "running" && execution.status !== "pending") {
        return;
      }
      const cancelled = event.type === "llm_attempt.cancelled";
      const failure = askFailure(attempt, ask, cancelled);
      const detail = await context.content.prepare({
        type: "text",
        text: failure.message,
        role: "tool.error_detail",
      }, { operationKey: `ask:${ask.askId}:failure-detail` });
      const projected = await context.content.prepare({
        type: "json",
        value: {
          status: cancelled ? "cancelled" : "failed",
          askId: ask.askId,
          askedAgentId: ask.askedAgentId,
          error: failure.message,
        },
        role: "tool.projected_output",
      }, { operationKey: `ask:${ask.askId}:failure-output` });
      if (cancelled) {
        await context.toolExecutions.cancel({
          id: execution.id,
          reason: failure.message,
          errorDetail: detail,
          projectedOutput: projected,
          historyVisibility: execution.historyVisibility ?? "public_status",
        }, { operationKey: `ask:${ask.askId}:cancel` });
        return;
      }
      await context.toolExecutions.fail({
        id: execution.id,
        safeError: failure,
        errorDetail: detail,
        projectedOutput: projected,
        historyVisibility: execution.historyVisibility ?? "public_status",
      }, { operationKey: `ask:${ask.askId}:fail` });
    },
  });
}

/** Creates the public, non-blocking, same-thread multi-agent ask capability. */
export function createAgentAskPlugin(
  options: CreateAgentAskPluginOptions = {},
): CopilotzPlugin {
  const toolId = requiredText(options.toolId ?? DEFAULT_TOOL_ID, "Ask tool ID");
  const tool = defineAskTool(toolId, positiveDepth(options.maxDepth));
  const processors = Object.freeze([
    completeAskProcessor(),
    failAskProcessor(),
  ]);
  return definePlugin({
    manifest: {
      id: options.id ?? DEFAULT_PLUGIN_ID,
      version: options.version ?? DEFAULT_PLUGIN_VERSION,
      provides: {
        tools: [tool.key],
        processors: processors.map((processor) => processor.id),
      },
    },
    resources: { tools: [tool], processors },
  });
}
