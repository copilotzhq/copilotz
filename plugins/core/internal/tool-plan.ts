import { isSettledActionError } from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type {
  ContentInput,
  ContentRef,
  ContentSequence,
} from "@copilotz/copilotz/content";
import { deriveWorkflowId } from "@copilotz/copilotz/events";
import type { LlmJsonObject, LlmToolCall } from "@copilotz/copilotz/llm";
import type { Processor } from "@copilotz/copilotz/plugins";
import { coreAgent, type CoreToolProcessorContext } from "../context.ts";
import {
  type AgentAskMetadata,
  agentAskMetadata,
  CORE_TOOL_ACTION_METADATA_SCHEMA,
  type CoreToolActionMetadata,
  coreToolActionMetadata,
  type CoreToolActionOrigin,
  coreToolPlanMetadata,
  defineCoreToolActionMetadata,
  withAgentAskMetadata,
  withCoreToolActionMessageMetadata,
  withWorkflowMetadata,
} from "./workflow-metadata.ts";
import { toolsForAgent } from "../resources/processors/helpers.ts";

export type CoreToolPlanBase = Readonly<{
  planId: string;
  planMessageId: string;
  planSize: number;
  threadId: string;
  triggerMessageId: string;
  agentId: string;
  agentParticipantId: string;
  initiatorParticipantId: string;
  availableToolIds: readonly string[];
  parentLlmActionRunId: string;
  ask?: AgentAskMetadata;
}>;

type ToolPlan = Readonly<{
  message: CollectionRecord;
  calls: readonly LlmToolCall[];
}>;

type ToolTerminalStatus = "completed" | "failed" | "cancelled";

type ToolTerminal = Readonly<{
  actionRunId: string;
  status: ToolTerminalStatus;
  input?: unknown;
  output?: unknown;
  error?: Readonly<Record<string, unknown>>;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} must be non-empty.`);
  return normalized;
}

function stringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  const values = value.map((entry) => requiredText(entry, "Tool alias"));
  if (new Set(values).size !== values.length) {
    throw new TypeError("Tool aliases must be unique.");
  }
  return Object.freeze(values);
}

function toolCalls(value: unknown): readonly LlmToolCall[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError("Core Tool plan must contain at least one call.");
  }
  const calls = value.map((candidate, index) => {
    const call = record(candidate);
    const id = requiredText(call.id, `Tool plan call ${index} id`);
    const action = requiredText(
      call.action,
      `Tool plan call '${id}' Action alias`,
    );
    if (
      !call.input || typeof call.input !== "object" ||
      Array.isArray(call.input)
    ) {
      throw new TypeError(`Tool plan call '${id}' input must be an object.`);
    }
    return Object.freeze({
      id,
      action,
      input: structuredClone(call.input) as LlmJsonObject,
    });
  });
  if (new Set(calls.map((call) => call.id)).size !== calls.length) {
    throw new TypeError("Core Tool plan call IDs must be unique.");
  }
  return Object.freeze(calls);
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJson(value, right[index]));
  }
  if (
    !left || typeof left !== "object" || !right || typeof right !== "object"
  ) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return sameStrings(leftKeys, rightKeys) &&
    leftKeys.every((key) => sameJson(leftRecord[key], rightRecord[key]));
}

function validateAvailableTools(
  context: CoreToolProcessorContext,
  input: Readonly<{
    agentId: string;
    availableToolIds: readonly string[];
    calls: readonly LlmToolCall[];
  }>,
): void {
  const agent = coreAgent(context.resources, input.agentId);
  if (!agent) throw new Error(`Unknown agent resource '${input.agentId}'.`);
  const available = toolsForAgent(context, agent);
  const availableIds = available.map((tool) => tool.alias);
  if (!sameStrings(availableIds, input.availableToolIds)) {
    throw new Error(
      `Agent '${agent.id}' Tool grants changed while its plan was running.`,
    );
  }
  const byAlias = new Map(available.map((entry) => [entry.alias, entry]));
  for (const call of input.calls) {
    if (!byAlias.has(call.action)) {
      throw new Error(
        `Tool plan requested unavailable Action '${call.action}'.`,
      );
    }
    if (typeof context.actions[call.action] !== "function") {
      throw new Error(`Tool Action '${call.action}' is not composed.`);
    }
  }
}

/** Validates every provider-order call before the plan is persisted. */
export function validateCoreToolPlan(
  context: CoreToolProcessorContext,
  input: Readonly<{
    agentId: string;
    availableToolIds: readonly string[];
    calls: readonly LlmToolCall[];
  }>,
): readonly LlmToolCall[] {
  const calls = toolCalls(input.calls);
  validateAvailableTools(context, {
    agentId: input.agentId,
    availableToolIds: stringArray(input.availableToolIds),
    calls,
  });
  return calls;
}

export function toolActionMetadataAt(
  plan: CoreToolPlanBase,
  call: LlmToolCall,
  planIndex: number,
): CoreToolActionMetadata {
  return defineCoreToolActionMetadata({
    schema: CORE_TOOL_ACTION_METADATA_SCHEMA,
    planId: plan.planId,
    planMessageId: plan.planMessageId,
    planIndex,
    planSize: plan.planSize,
    toolCallId: call.id,
    action: call.action,
    threadId: plan.threadId,
    triggerMessageId: plan.triggerMessageId,
    agentId: plan.agentId,
    agentParticipantId: plan.agentParticipantId,
    initiatorParticipantId: plan.initiatorParticipantId,
    availableToolIds: plan.availableToolIds,
    parentLlmActionRunId: plan.parentLlmActionRunId,
    ...(plan.ask ? { ask: plan.ask } : {}),
  });
}

async function loadPlan(
  context: CoreToolProcessorContext,
  metadata: CoreToolActionOrigin,
): Promise<ToolPlan> {
  const messages = context.collections.message;
  if (!messages) throw new Error("Collection 'message' is not bound.");
  const message = await messages.get({ id: metadata.planMessageId });
  if (!message) {
    throw new Error(
      `Tool plan Message '${metadata.planMessageId}' was not found.`,
    );
  }
  if (String(message.threadId) !== metadata.threadId) {
    throw new Error(`Tool plan '${metadata.planId}' changed threads.`);
  }
  const plan = coreToolPlanMetadata(message.metadata);
  if (
    !plan || plan.planId !== metadata.planId ||
    plan.planSize !== metadata.planSize
  ) {
    throw new Error(
      `Tool plan Message '${metadata.planMessageId}' is invalid.`,
    );
  }
  const calls = toolCalls(record(message.metadata).llmToolCalls);
  if (calls.length !== metadata.planSize) {
    throw new Error(`Tool plan '${metadata.planId}' size does not match.`);
  }
  validateAvailableTools(context, {
    agentId: metadata.agentId,
    availableToolIds: metadata.availableToolIds,
    calls,
  });
  const call = calls[metadata.planIndex];
  if (
    !call || call.id !== metadata.toolCallId ||
    call.action !== metadata.action
  ) {
    throw new Error(`Tool plan '${metadata.planId}' cursor does not match.`);
  }
  return Object.freeze({ message, calls });
}

/** Invokes exactly one plan position through the composed Action caller map. */
export async function invokeToolPlanAction(
  context: CoreToolProcessorContext,
  metadata: CoreToolActionMetadata,
): Promise<void> {
  const plan = await loadPlan(context, metadata);
  const call = plan.calls[metadata.planIndex];
  const invoke = context.actions[call.action];
  if (typeof invoke !== "function") {
    throw new Error(`Tool Action '${call.action}' is not composed.`);
  }
  try {
    await invoke(structuredClone(call.input), {
      operationKey:
        `tool-plan:${metadata.planId}:${metadata.planIndex}:${call.id}`,
      metadata,
      identity: context.identity,
      signal: context.signal,
    });
  } catch (error) {
    if (!isSettledActionError(error)) throw error;
  }
}

function visibility(
  value: unknown,
  requesterId: string,
) {
  const policy = value === "requester_only" || value === "public"
    ? value
    : "public_status";
  return Object.freeze({
    kind: "tool" as const,
    policy,
    requesterId,
  });
}

function isContentRef(value: unknown): value is ContentRef {
  const candidate = record(value);
  return typeof candidate.assetId === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.mediaType === "string";
}

function resultContent(
  terminal: ToolTerminal,
): ContentInput | ContentSequence {
  if (terminal.status === "completed") {
    if (isContentRef(terminal.output)) {
      return structuredClone(terminal.output);
    }
    if (
      Array.isArray(terminal.output) && terminal.output.length > 0 &&
      terminal.output.every(isContentRef)
    ) {
      return Object.freeze(structuredClone(terminal.output)) as ContentSequence;
    }
    if (typeof terminal.output === "string") {
      return { type: "text", text: terminal.output, role: "tool.output" };
    }
    return {
      type: "json",
      value: terminal.output ?? null,
      role: "tool.output",
    };
  }
  const error = terminal.error ?? {};
  return {
    type: "json",
    value: {
      status: terminal.status,
      name: requiredText(error.name ?? "Error", "Tool error name"),
      message: requiredText(
        error.message ?? "Tool execution failed.",
        "Tool error message",
      ),
    },
    role: "tool.projected_output",
  };
}

function planBase(
  metadata: CoreToolActionMetadata,
): CoreToolPlanBase {
  return Object.freeze({
    planId: metadata.planId,
    planMessageId: metadata.planMessageId,
    planSize: metadata.planSize,
    threadId: metadata.threadId,
    triggerMessageId: metadata.triggerMessageId,
    agentId: metadata.agentId,
    agentParticipantId: metadata.agentParticipantId,
    initiatorParticipantId: metadata.initiatorParticipantId,
    availableToolIds: metadata.availableToolIds,
    parentLlmActionRunId: metadata.parentLlmActionRunId,
    ...(metadata.ask ? { ask: metadata.ask } : {}),
  });
}

function assertAskOriginOwnership(ask: AgentAskMetadata): void {
  if (
    ask.origin.action !== "ask" ||
    ask.origin.agentId !== ask.askingAgentId ||
    ask.origin.agentParticipantId !== ask.askingParticipantId ||
    (ask.toolCallId !== undefined &&
      ask.origin.toolCallId !== ask.toolCallId)
  ) {
    throw new Error(`Ask '${ask.askId}' does not own its Tool plan origin.`);
  }
}

async function loadParentAsk(
  context: CoreToolProcessorContext,
  ask: AgentAskMetadata,
): Promise<AgentAskMetadata | undefined> {
  assertAskOriginOwnership(ask);
  const parentAskId = ask.parentAskId;
  const parentQuestionMessageId = ask.parentQuestionMessageId;
  if (!parentAskId && !parentQuestionMessageId) {
    if (ask.depth !== 1) {
      throw new Error(`Ask '${ask.askId}' has no durable parent cursor.`);
    }
    return undefined;
  }
  if (!parentAskId || !parentQuestionMessageId || ask.depth <= 1) {
    throw new Error(`Ask '${ask.askId}' has an invalid parent cursor.`);
  }
  const messages = context.collections.message;
  if (!messages) throw new Error("Collection 'message' is not bound.");
  const parentQuestion = await messages.get({ id: parentQuestionMessageId });
  if (!parentQuestion) {
    throw new Error(
      `Parent ask question Message '${parentQuestionMessageId}' was not found.`,
    );
  }
  const parent = agentAskMetadata(parentQuestion.metadata);
  const recipientIds = Array.isArray(parentQuestion.recipientIds)
    ? parentQuestion.recipientIds
    : [];
  if (
    !parent || parent.phase !== "question" ||
    parent.askId !== parentAskId ||
    parent.questionMessageId !== parentQuestionMessageId ||
    String(parentQuestion.id) !== parentQuestionMessageId ||
    String(parentQuestion.threadId) !== ask.origin.threadId ||
    String(parentQuestion.senderId) !== parent.askingParticipantId ||
    !recipientIds.includes(parent.askedParticipantId) ||
    parent.askedParticipantId !== ask.askingParticipantId ||
    parent.askedAgentId !== ask.askingAgentId ||
    parent.depth + 1 !== ask.depth ||
    parent.origin.threadId !== ask.origin.threadId
  ) {
    throw new Error(`Ask '${ask.askId}' has a forged parent cursor.`);
  }
  assertAskOriginOwnership(parent);
  return parent;
}

/** Projects one terminal Tool lifecycle and advances exactly one plan cursor. */
export async function projectAndAdvanceToolPlan(
  context: CoreToolProcessorContext,
  metadata: CoreToolActionMetadata,
  terminal: ToolTerminal,
): Promise<void> {
  const plan = await loadPlan(context, metadata);
  const call = plan.calls[metadata.planIndex];
  if (
    terminal.input !== undefined && !sameJson(terminal.input, call.input)
  ) {
    throw new Error(
      `Tool Action '${terminal.actionRunId}' input does not match its durable plan.`,
    );
  }
  const tool = context.resources.tools[call.action];
  if (!tool) throw new Error(`Tool Resource '${call.action}' is not composed.`);
  const hasNext = metadata.planIndex + 1 < plan.calls.length;
  const invocation = Object.freeze({
    id: call.id,
    tool: Object.freeze({ id: call.action, name: tool.name }),
    args: JSON.stringify(call.input),
  });
  const baseMessageMetadata = metadata.ask
    ? withAgentAskMetadata({
      historyVisibility: tool.history?.visibility ?? "public_status",
      requesterId: metadata.agentParticipantId,
      toolStatus: terminal.status,
      toolId: call.action,
      toolInvocation: invocation,
    }, metadata.ask)
    : {
      historyVisibility: tool.history?.visibility ?? "public_status",
      requesterId: metadata.agentParticipantId,
      toolStatus: terminal.status,
      toolId: call.action,
      toolInvocation: invocation,
    };
  const messageMetadata = withCoreToolActionMessageMetadata(
    withWorkflowMetadata(baseMessageMetadata, {
      kind: "tool_result",
      ...(hasNext ? { continuation: "none" as const } : {}),
      llmAttemptId: metadata.parentLlmActionRunId,
      parentLlmAttemptId: metadata.parentLlmActionRunId,
      sourceMessageId: metadata.planMessageId,
      agentParticipantId: metadata.agentParticipantId,
    }),
    metadata,
    terminal.actionRunId,
  );
  const createMessage = context.actions.createThreadMessage;
  if (typeof createMessage !== "function") {
    throw new Error("Core requires the createThreadMessage Action.");
  }
  await createMessage({
    id: await deriveWorkflowId("message", terminal.actionRunId, "result"),
    threadId: metadata.threadId,
    sender: {
      externalId: `tool:${call.action}`,
      participantType: "tool",
      name: tool.name,
    },
    recipientIds: [metadata.agentParticipantId],
    content: resultContent(terminal),
    visibility: visibility(
      tool.history?.visibility,
      metadata.agentParticipantId,
    ),
    metadata: messageMetadata,
  }, {
    operationKey: `tool-plan:${metadata.planId}:${metadata.planIndex}:project`,
    signal: context.signal,
  });

  if (hasNext) {
    await invokeToolPlanAction(
      context,
      toolActionMetadataAt(
        planBase(metadata),
        plan.calls[metadata.planIndex + 1],
        metadata.planIndex + 1,
      ),
    );
  }
}

/** Resumes the original plan after an ask answer or asked-Agent failure. */
export async function resumeDeferredToolPlan(
  context: CoreToolProcessorContext,
  ask: AgentAskMetadata,
  terminal: Omit<ToolTerminal, "actionRunId">,
): Promise<void> {
  const parentAsk = await loadParentAsk(context, ask);
  const metadata: CoreToolActionMetadata = defineCoreToolActionMetadata({
    ...ask.origin,
    ...(parentAsk ? { ask: parentAsk } : {}),
  });
  await projectAndAdvanceToolPlan(context, metadata, {
    ...terminal,
    actionRunId: ask.toolActionRunId,
  });
}

/** Narrows a processor Event to a terminal Core Tool Action lifecycle. */
export function coreToolTerminal(
  event: Parameters<Processor<CoreToolProcessorContext>["handle"]>[0],
):
  | Readonly<{
    metadata: CoreToolActionMetadata;
    terminal: ToolTerminal;
  }>
  | null {
  const lifecycle = record(event.data);
  const metadata = coreToolActionMetadata(lifecycle.metadata);
  if (!metadata) return null;
  const status = lifecycle.status;
  if (
    status !== "completed" && status !== "failed" && status !== "cancelled"
  ) return null;
  const terminalStatus: ToolTerminalStatus = status;
  const actionRunId = requiredText(
    lifecycle.actionRunId,
    "Tool Action lifecycle run ID",
  );
  return Object.freeze({
    metadata,
    terminal: Object.freeze({
      actionRunId,
      status: terminalStatus,
      input: lifecycle.input,
      ...(terminalStatus === "completed" ? { output: lifecycle.output } : {}),
      ...(terminalStatus !== "completed"
        ? { error: record(lifecycle.error) }
        : {}),
    }),
  });
}
