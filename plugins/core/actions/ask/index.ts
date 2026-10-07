/** Defines the durable Agent-to-Agent Ask Action. @module */

import {
  type ActionDeferral,
  type ActionDefinition,
  type ActionResolution,
  deferAction,
  defineAction,
} from "@copilotz/copilotz/actions";
import {
  type ContentSequence,
  contentSequenceSchema,
} from "@copilotz/copilotz/content";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import type { AgentResource } from "../../authoring/define-agent/index.ts";
import {
  type CoreActionContext,
  coreAgent,
} from "../../shared/runtime-context.ts";
import {
  type AgentAskMetadata,
  agentAskMetadata,
  type AgentAskResultMetadata,
  coreToolActionMetadata,
  coreToolActionOriginFrom,
  withAgentAskMetadata,
  withCoreAgentTurnMetadata,
} from "../../shared/workflow-metadata.ts";
import { resolveAgentGrants } from "../../shared/capabilities/grants.ts";
import {
  asRecord,
  optionalText,
  requireCollection,
  requiredText,
} from "../../shared/helpers.ts";

export const ASK_ACTION_ID = "copilotz.core.ask";
const MAX_ASK_DEPTH = 8;

export type AskInput = Readonly<{
  target: string;
  message: string;
  /** Public is a group-visible ask; private limits delivery to both agents. */
  mode?: "public" | "private";
}>;

export type AskResult = Readonly<
  { content: ContentSequence; askResult: AgentAskResultMetadata }
>;
export type AskOutput = AskResult | ActionDeferral;
export type AskWork = Readonly<{
  ask: AgentAskMetadata;
  question: Readonly<Record<string, unknown> & { id: string }>;
}>;

const askInputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    target: {
      type: "string",
      minLength: 1,
      description: "Stable ID or name of another agent in this thread.",
    },
    message: {
      type: "string",
      minLength: 1,
      description: "The complete question for that agent.",
    },
    mode: {
      type: "string",
      enum: ["public", "private"],
      default: "public",
      description:
        "Controls Ask visibility. 'public' (default) adds the question, discussion, and answer to shared conversation history. 'private' limits that Ask history to the asking and asked agents.",
    },
  },
  required: ["target", "message"],
} as const;

const askOutputSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    content: contentSequenceSchema,
    askResult: {
      type: "object",
      additionalProperties: false,
      properties: {
        schema: { const: "copilotz.ask-result.v1" },
        askId: { type: "string" },
        status: { const: "completed" },
        askedParticipantId: { type: "string" },
        askedAgentId: { type: "string" },
        answerMessageId: { type: "string" },
      },
      required: [
        "schema",
        "askId",
        "status",
        "askedParticipantId",
        "askedAgentId",
        "answerMessageId",
      ],
    },
  },
  required: ["content", "askResult"],
} as const;

function normalizedIdentity(value: string | null | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function agentIdentities(agent: AgentResource): readonly string[] {
  return ([agent.id, agent.name]
    .map(normalizedIdentity)
    .filter((value): value is string => value !== null));
}

function resolveTargetAgent(
  target: string,
  agents: readonly AgentResource[],
): AgentResource {
  const normalized = target.trim().toLowerCase();
  const preferred = agents.filter((agent) =>
    normalizedIdentity(agent.id) === normalized
  );
  const matches = preferred.length
    ? preferred
    : agents.filter((agent) => normalizedIdentity(agent.name) === normalized);
  if (!matches.length) {
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
  asking: AgentResource,
  asked: AgentResource,
  agents: readonly AgentResource[],
): void {
  if (asking.id === asked.id) throw new Error("An agent cannot ask itself.");
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
  agent: AgentResource,
): CollectionRecord | undefined {
  const identities = new Set(agentIdentities(agent));
  return participants.find((participant) =>
    participant.participantType === "agent" &&
    ((optionalText(participant.agentId) &&
      identities.has(optionalText(participant.agentId)!.toLowerCase())) ||
      identities.has(String(participant.externalId ?? "").toLowerCase()))
  );
}

async function executeAsk(
  raw: AskInput,
  context: CoreActionContext,
): Promise<AskOutput> {
  const input = asRecord(raw);
  const target = requiredText(
    typeof input.target === "string" ? input.target : undefined,
    "Ask target",
  );
  const message = requiredText(
    typeof input.message === "string" ? input.message : undefined,
    "Ask message",
  );
  const requestedMode: "public" | "private" =
    input.mode === undefined || input.mode === "public"
      ? "public"
      : input.mode === "private"
      ? "private"
      : (() => {
        throw new TypeError("Ask mode must be public or private.");
      })();
  const metadata = coreToolActionMetadata(context.action.metadata);
  if (!metadata || metadata.action !== "ask") {
    throw new Error("The ask Action requires Core Tool plan metadata.");
  }
  const askingParticipant = await requireCollection(
    context,
    "participant",
  ).get({ id: metadata.agentParticipantId });
  if (!askingParticipant || askingParticipant.participantType !== "agent") {
    throw new Error(
      `Asking participant '${metadata.agentParticipantId}' is not an agent.`,
    );
  }
  const agents = Object.values(context.resources.agents ?? {}).filter(
    (value): value is AgentResource => Boolean(value),
  );
  const askingAgent = coreAgent(context.resources, metadata.agentId);
  if (!askingAgent) {
    throw new Error(`Asking agent '${metadata.agentId}' was not found.`);
  }
  const askedAgent = resolveTargetAgent(target, agents);
  assertAgentAllowed(askingAgent, askedAgent, agents);

  const thread = await requireCollection(context, "thread").get({
    id: metadata.threadId,
  });
  if (!thread) throw new Error(`Thread '${metadata.threadId}' was not found.`);
  const participantIds = Array.isArray(thread.participantIds)
    ? thread.participantIds.filter((id): id is string => typeof id === "string")
    : [];
  const participants = (await Promise.all(
    participantIds.map((id) =>
      requireCollection(context, "participant").get({ id })
    ),
  )).filter((value): value is CollectionRecord => value !== null);
  if (!participants.some((value) => value.id === askingParticipant.id)) {
    throw new Error(
      `Asking agent '${askingAgent.id}' is not a participant in thread '${metadata.threadId}'.`,
    );
  }
  const askedParticipant = participantForAgent(participants, askedAgent);
  if (!askedParticipant) {
    throw new Error(
      `Target agent '${askedAgent.id}' is not a participant in thread '${metadata.threadId}'.`,
    );
  }

  const parentAsk = metadata.ask;
  const mode: "public" | "private" = parentAsk?.mode === "private"
    ? "private"
    : requestedMode;
  const depth = (parentAsk?.depth ?? 0) + 1;
  if (depth > MAX_ASK_DEPTH) {
    throw new Error(
      `Agent ask depth ${depth} exceeds the configured maximum of ${MAX_ASK_DEPTH}.`,
    );
  }
  const askId = await deriveWorkflowId("ask", context.action.runId);
  const questionMessageId = await deriveWorkflowId(
    "message",
    context.action.runId,
    "ask",
  );
  const toolInvocation = {
    id: metadata.toolCallId,
    tool: { id: "ask", name: "Ask Agent" } as const,
    args: JSON.stringify(input),
  } as const;
  const ask: AgentAskMetadata = {
    schema: "copilotz.ask.v1",
    askId,
    phase: "question",
    mode,
    toolActionRunId: context.action.runId,
    toolCallId: metadata.toolCallId,
    toolInvocation,
    questionMessageId,
    askingParticipantId: String(askingParticipant.id),
    askingAgentId: askingAgent.id,
    askingAgentName: askingAgent.name,
    askedParticipantId: String(askedParticipant.id),
    askedAgentId: askedAgent.id,
    askedAgentName: askedAgent.name,
    callingAttemptId: metadata.parentLlmActionRunId,
    ...(parentAsk
      ? {
        parentAskId: parentAsk.askId,
        parentQuestionMessageId: parentAsk.questionMessageId,
      }
      : {}),
    origin: coreToolActionOriginFrom(metadata),
    depth,
  } as const;
  const questionMetadata = metadata.agentTurn
    ? withCoreAgentTurnMetadata(
      withAgentAskMetadata(undefined, ask),
      metadata.agentTurn,
    )
    : withAgentAskMetadata(undefined, ask);
  const question: AskWork["question"] = {
    id: questionMessageId,
    threadId: metadata.threadId,
    sender: askingParticipant,
    recipientIds: [String(askedParticipant.id)],
    content: message,
    visibility: metadata.agentTurn
      ? { kind: "internal" }
      : mode === "public"
      ? { kind: "public" }
      : {
        kind: "participants",
        participantIds: [
          String(askingParticipant.id),
          String(askedParticipant.id),
        ],
      },
    metadata: questionMetadata,
    ...(metadata.agentTurn ? { historyScopeId: metadata.agentTurn.id } : {}),
  };
  return deferAction({ ask, question } satisfies AskWork);
}

async function resolveAsk(
  _input: AskInput,
  context: CoreActionContext,
  resolution: ActionResolution,
): Promise<AskResult> {
  const work = resolution.work as AskWork;
  const ask = work.ask;
  if (
    !ask || ask.toolActionRunId !== context.action.runId ||
    ask.questionMessageId !== work.question.id
  ) {
    throw new Error("Ask resolver received an inconsistent handoff.");
  }
  const answers = await requireCollection(context, "message").list({
    filter: {
      and: [
        { field: "threadId", eq: ask.origin.threadId },
        { field: "senderId", eq: ask.askedParticipantId },
        {
          field: "metadata.copilotzAsk.toolActionRunId",
          eq: context.action.runId,
        },
        {
          field: "metadata.copilotzAsk.questionMessageId",
          eq: ask.questionMessageId,
        },
        { field: "metadata.copilotzAsk.phase", eq: "answer" },
      ],
    },
    limit: 2,
  });
  const answer = answers[0];
  const cursor = answer ? agentAskMetadata(asRecord(answer.metadata)) : null;
  const outcome = asRecord(asRecord(answer?.metadata).copilotzAskOutcome);
  if (
    answers.length === 1 && cursor?.askId === ask.askId &&
    (outcome.status === "failed" || outcome.status === "cancelled")
  ) {
    const cause = asRecord(outcome.error);
    const error = new Error(
      typeof cause.message === "string" ? cause.message : "Asked agent failed.",
    );
    error.name = outcome.status === "cancelled"
      ? "AbortError"
      : "AgentAskFailed";
    throw error;
  }
  if (
    answers.length !== 1 || !cursor || cursor.askId !== ask.askId ||
    cursor.askedParticipantId !== ask.askedParticipantId ||
    !Array.isArray(answer.content) || answer.content.length === 0
  ) {
    if (resolution.outcome !== "completed") {
      const error = new Error(
        `Asked turn for '${ask.askedAgentId}' ${resolution.outcome}.${
          resolution.error ? " " + resolution.error.message : ""
        }`,
      );
      error.name = resolution.outcome === "cancelled"
        ? "AbortError"
        : "AgentAskFailed";
      throw error;
    }
    const error = new Error(
      `Asked turn for '${ask.askedAgentId}' finished without one final answer.`,
    );
    error.name = "AgentAskUnanswered";
    throw error;
  }
  return {
    content: structuredClone(answer.content) as ContentSequence,
    askResult: {
      schema: "copilotz.ask-result.v1",
      askId: ask.askId,
      status: "completed",
      askedParticipantId: ask.askedParticipantId,
      askedAgentId: ask.askedAgentId,
      answerMessageId: String(answer.id),
    },
  };
}

export const askAction: ActionDefinition<
  AskInput,
  AskOutput,
  CoreActionContext,
  typeof askInputSchema,
  typeof askOutputSchema
> = defineAction({
  id: ASK_ACTION_ID,
  inputSchema: askInputSchema,
  outputSchema: askOutputSchema,
  execute: executeAsk,
  resolve: resolveAsk,
});

export default askAction;
