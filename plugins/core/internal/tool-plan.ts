import {
  actionCallerDefinitionId,
  isActionInputValidationError,
  isSettledActionError,
  parseActionLifecycleEvent,
} from "@copilotz/copilotz/actions";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import type {
  ContentInput,
  ContentRef,
  ContentSequence,
} from "@copilotz/copilotz/content";
import {
  deriveWorkflowId,
  type EventVisibility,
} from "@copilotz/copilotz/events";
import type {
  LlmJsonObject,
  LlmToolCall,
  LlmToolPipelineStage,
} from "@copilotz/copilotz/llm";
import type { Processor } from "@copilotz/copilotz/plugins";
import { coreAgent, type CoreToolProcessorContext } from "./runtime-context.ts";
import { toolsForAgent } from "../processors/internal/helpers.ts";
import { resolveToolGrants } from "./capabilities/grants.ts";
import { createThreadMessage } from "../../core-collections/actions/create-thread-message/index.ts";
import {
  type AgentAskMetadata,
  agentAskMetadata,
  type AgentAskResultMetadata,
  agentAskResultMetadata,
  CORE_TOOL_ACTION_METADATA_SCHEMA,
  type CoreAgentTurnMetadata,
  type CoreToolActionMetadata,
  coreToolActionMetadata,
  type CoreToolActionOrigin,
  coreToolPlanMetadata,
  defineCoreToolActionMetadata,
  withAgentAskResultMetadata,
  withCoreAgentTurnMetadata,
  withCoreToolActionMessageMetadata,
  withCoreToolPlanResultMetadata,
  withWorkflowMetadata,
} from "./workflow-metadata.ts";
import { evaluateCoreJq, mergePipelineArguments } from "./jq.ts";

const TERMINAL_SCHEMA = "copilotz.core.tool-plan-stage-result.v1";
type TerminalStatus = "completed" | "failed" | "cancelled";
type ToolTerminal = Readonly<
  {
    actionRunId?: string;
    sourceAction?: Readonly<{ stageIndex: number; actionRunId: string }>;
    status: TerminalStatus;
    input?: unknown;
    output?: unknown;
    error?: Readonly<Record<string, unknown>>;
    askResult?: AgentAskResultMetadata;
  }
>;
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
  responseVisibility: EventVisibility;
  parentLlmActionRunId:
    string; /** Immutable root Tool presentation, independent of restart composition. */
  agentTurn?: CoreAgentTurnMetadata;
  rootTools: readonly Readonly<
    { alias: string; name: string }
  >[]; /** Immutable Tool history policy per pipeline stage. */
  stageHistoryVisibility: readonly (readonly (
    | string
    | null
  )[])[]; /** Definition identity snapshot for every executable stage. */
  stageActionIds: readonly (readonly (string | null)[])[];
  ask?: AgentAskMetadata;
}>;
type ToolPlan = Readonly<
  { message: CollectionRecord; calls: readonly LlmToolCall[] }
>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}
function text(value: unknown, label: string): string {
  const result = typeof value === "string" ? value.trim() : "";
  if (!result) throw new TypeError(`${label} must be non-empty.`);
  return result;
}
function sameJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length &&
      a.every((value, index) => sameJson(value, b[index]));
  }
  if (!a || typeof a !== "object" || !b || typeof b !== "object") return false;
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).sort(),
    rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] && sameJson(left[key], right[key])
    );
}
function stages(call: LlmToolCall): readonly LlmToolPipelineStage[] {
  const value = call.pipeline?.stages ??
    [{
      type: "tool" as const,
      id: call.id,
      action: call.action,
      input: call.input,
    }];
  const first = value[0];
  if (
    !first || first.type !== "tool" || first.id !== call.id ||
    first.action !== call.action || !sameJson(first.input, call.input)
  ) {
    throw new TypeError(
      `Tool pipeline '${call.id}' root must match its provider call.`,
    );
  }
  for (let index = 0; index < value.length; index++) {
    const stage = value[index];
    if (stage.type === "tool") {
      text(stage.id, "Tool pipeline stage ID");
      text(stage.action, "Tool pipeline Action");
      if (
        !stage.input || typeof stage.input !== "object" ||
        Array.isArray(stage.input)
      ) throw new TypeError("Tool pipeline input must be an object.");
    } else text(stage.filter, "Tool pipeline jq filter");
  }
  return Object.freeze(structuredClone(value));
}
function calls(value: unknown): readonly LlmToolCall[] {
  if (!Array.isArray(value) || !value.length) {
    throw new TypeError("Core Tool plan must contain at least one branch.");
  }
  const result = value.map((raw, index) => {
    const call = record(raw);
    const id = text(call.id, `Tool plan call ${index} ID`);
    const action = text(call.action, `Tool plan call '${id}' Action`);
    if (
      !call.input || typeof call.input !== "object" || Array.isArray(call.input)
    ) throw new TypeError(`Tool plan call '${id}' input must be an object.`);
    const copy = Object.freeze({
      id,
      action,
      input: structuredClone(call.input) as LlmJsonObject,
      ...(call.pipeline
        ? {
          pipeline: structuredClone(call.pipeline) as LlmToolCall["pipeline"],
        }
        : {}),
    });
    stages(copy);
    return copy;
  });
  if (new Set(result.map((call) => call.id)).size !== result.length) {
    throw new TypeError("Tool plan call IDs must be unique.");
  }
  return Object.freeze(result);
}
function available(
  context: CoreToolProcessorContext,
  base: Pick<CoreToolPlanBase, "agentId" | "availableToolIds">,
  planCalls: readonly LlmToolCall[],
) {
  const agent = coreAgent(context.resources, base.agentId);
  if (!agent) throw new Error(`Unknown agent '${base.agentId}'.`);
  const tools = toolsForAgent(context, agent);
  const ids = tools.map((tool) => tool.alias);
  if (
    ids.length !== base.availableToolIds.length ||
    ids.some((id, i) => id !== base.availableToolIds[i])
  ) throw new Error("Tool grants changed while plan was running.");
  const granted = new Set(ids);
  for (const call of planCalls) {
    for (const stage of stages(call)) {
      if (
        stage.type === "tool" &&
        (!granted.has(stage.action) ||
          typeof context.actions[stage.action] !== "function")
      ) throw new Error(`Tool Action '${stage.action}' is unavailable.`);
    }
  }
}
export function validateCoreToolPlan(
  context: CoreToolProcessorContext,
  input: Readonly<
    {
      agentId: string;
      availableToolIds: readonly string[];
      calls: readonly LlmToolCall[];
    }
  >,
): readonly LlmToolCall[] {
  const result = calls(input.calls);
  available(context, input, result);
  return result;
}
export function snapshotToolStageHistory(
  context: CoreToolProcessorContext,
  planCalls: readonly LlmToolCall[],
): readonly (readonly (string | null)[])[] {
  return Object.freeze(
    planCalls.map((call) =>
      Object.freeze(
        stages(call).map((stage) =>
          stage.type === "tool"
            ? context.resources.tools[stage.action]?.history?.visibility ?? null
            : null
        ),
      )
    ),
  );
}
export function snapshotToolStageActionIds(
  context: CoreToolProcessorContext,
  planCalls: readonly LlmToolCall[],
): readonly (readonly (string | null)[])[] {
  return Object.freeze(
    planCalls.map((call) =>
      Object.freeze(
        stages(call).map((stage) => {
          if (stage.type !== "tool") return null;
          const actionId = actionCallerDefinitionId(
            context.actions[stage.action],
          );
          if (!actionId) {
            throw new Error(
              `Tool Action '${stage.action}' has no registered definition identity.`,
            );
          }
          return actionId;
        }),
      )
    ),
  );
}
export function snapshotRootTools(
  context: CoreToolProcessorContext,
  planCalls: readonly LlmToolCall[],
): readonly Readonly<{ alias: string; name: string }>[] {
  return Object.freeze(planCalls.map((call) => {
    const tool = context.resources.tools[call.action];
    if (!tool) {
      throw new Error(`Tool Resource '${call.action}' is unavailable.`);
    }
    return Object.freeze({ alias: call.action, name: tool.name });
  }));
}
function stageAt(call: LlmToolCall, index: number) {
  const stage = stages(call)[index];
  if (!stage || stage.type !== "tool") {
    throw new Error(`Pipeline '${call.id}' cursor is not a Tool stage.`);
  }
  return stage;
}
export function toolActionMetadataAt(
  plan: CoreToolPlanBase,
  call: LlmToolCall,
  planIndex: number,
  stageIndex = 0,
): CoreToolActionMetadata {
  const stage = stageAt(call, stageIndex);
  return defineCoreToolActionMetadata({
    schema: CORE_TOOL_ACTION_METADATA_SCHEMA,
    planId: plan.planId,
    planMessageId: plan.planMessageId,
    planIndex,
    stageIndex,
    stageCount: stages(call).length,
    planSize: plan.planSize,
    toolCallId: call.id,
    action: stage.action,
    threadId: plan.threadId,
    triggerMessageId: plan.triggerMessageId,
    agentId: plan.agentId,
    agentParticipantId: plan.agentParticipantId,
    initiatorParticipantId: plan.initiatorParticipantId,
    availableToolIds: plan.availableToolIds,
    responseVisibility: plan.responseVisibility,
    parentLlmActionRunId: plan.parentLlmActionRunId,
    ...(plan.agentTurn ? { agentTurn: plan.agentTurn } : {}),
    ...(plan.ask ? { ask: plan.ask } : {}),
  });
}
async function loadPlan(
  context: CoreToolProcessorContext,
  base: CoreToolPlanBase | CoreToolActionOrigin,
): Promise<ToolPlan> {
  const message = await context.collections.message?.get({
    id: base.planMessageId,
  });
  if (!message) {
    throw new Error(`Tool plan Message '${base.planMessageId}' was not found.`);
  }
  const marker = coreToolPlanMetadata(message.metadata);
  if (
    !marker || marker.planId !== base.planId ||
    marker.planSize !== base.planSize ||
    String(message.threadId) !== base.threadId
  ) throw new Error(`Tool plan '${base.planId}' is invalid.`);
  const result = calls(record(message.metadata).llmToolCalls);
  if (result.length !== base.planSize) {
    throw new Error("Tool plan size changed.");
  }
  if ("stageHistoryVisibility" in base) {
    const snapshot = base.stageHistoryVisibility;
    const actionIds = base.stageActionIds;
    if (
      !Array.isArray(snapshot) || snapshot.length !== result.length ||
      snapshot.some((row: readonly (string | null)[], index: number) =>
        !Array.isArray(row) || row.length !== stages(result[index]).length ||
        row.some((policy: string | null) =>
          policy !== null && policy !== "requester_only" &&
          policy !== "public_status" && policy !== "public"
        )
      ) || !Array.isArray(actionIds) || actionIds.length !== result.length ||
      actionIds.some((row: readonly (string | null)[], index: number) =>
        !Array.isArray(row) || row.length !== stages(result[index]).length ||
        row.some((actionId: string | null, stageIndex: number) =>
          stages(result[index])[stageIndex].type === "tool"
            ? !text(actionId, "Tool-plan stage Action definition ID")
            : actionId !== null
        )
      )
    ) throw new Error("Tool-plan immutable stage snapshot is invalid.");
  }
  return Object.freeze({ message, calls: result });
}
function baseFrom(recordValue: CollectionRecord): CoreToolPlanBase {
  const base = record(record(recordValue.state).base);
  if (base.planId !== recordValue.id) {
    throw new Error("Invalid Tool-plan base.");
  }
  return structuredClone(base) as CoreToolPlanBase;
}
function branch(
  plan: CollectionRecord,
  index: number,
): Record<string, unknown> | undefined {
  const branches = Array.isArray(record(plan.state).branches)
    ? record(plan.state).branches as unknown[]
    : [];
  return record(branches[index]);
}
function terminalContent(value: ToolTerminal): ContentInput {
  return {
    type: "json",
    role: "tool.plan.stage-result",
    value: { schema: TERMINAL_SCHEMA, ...structuredClone(value) },
  };
}
async function stageResult(
  context: CoreToolProcessorContext,
  planId: string,
  branchIndex: number,
  stageIndex: number,
  terminal: ToolTerminal,
): Promise<string> {
  const collection = context.collections.toolPlanStageResult;
  if (!collection) {
    throw new Error("Collection 'toolPlanStageResult' is not bound.");
  }
  const id = await deriveWorkflowId(
    "tool-plan-stage-result",
    planId,
    String(branchIndex),
    String(stageIndex),
  );
  const operationKey =
    `tool-plan:${planId}:${branchIndex}:${stageIndex}:result`;
  const prepared = await context.content.prepare(terminalContent(terminal), {
    operationKey,
  });
  await collection.create({
    id,
    planId,
    branchIndex,
    stageIndex,
    content: prepared as never,
    metadata: {},
  }, { operationKey });
  // A deterministic id makes post-create/pre-settle recovery idempotent. It
  // must nevertheless remain bound to this exact branch cursor.
  const persisted = await collection.get({ id });
  if (
    !persisted || persisted.planId !== planId ||
    Number(persisted.branchIndex) !== branchIndex ||
    Number(persisted.stageIndex) !== stageIndex
  ) {
    throw new Error("Tool stage result does not belong to its plan cursor.");
  }
  return id;
}
async function stageResultId(
  planId: string,
  branchIndex: number,
  stageIndex: number,
): Promise<string> {
  return await deriveWorkflowId(
    "tool-plan-stage-result",
    planId,
    String(branchIndex),
    String(stageIndex),
  );
}
async function readTerminal(
  context: CoreToolProcessorContext,
  id: string,
  expected?: Readonly<{
    planId: string;
    branchIndex: number;
    stageIndex?: number;
  }>,
): Promise<{ terminal: ToolTerminal; stageIndex: number }> {
  const item = await context.collections.toolPlanStageResult?.get({ id });
  if (!item) throw new Error(`Tool stage result '${id}' was not found.`);
  if (
    expected &&
    (item.planId !== expected.planId ||
      Number(item.branchIndex) !== expected.branchIndex ||
      (expected.stageIndex !== undefined &&
        Number(item.stageIndex) !== expected.stageIndex))
  ) {
    throw new Error(
      "Tool stage result does not match its expected plan cursor.",
    );
  }
  const content = item.content as ContentSequence;
  if (content.length !== 1) {
    throw new Error(
      "Tool stage result must have exactly one content envelope.",
    );
  }
  const resolved = await context.content.resolve(content[0] as ContentRef);
  const value = record(resolved.value);
  if (
    Object.keys(value).some((key) =>
      ![
        "schema",
        "actionRunId",
        "sourceAction",
        "status",
        "input",
        "output",
        "error",
        "askResult",
      ].includes(key)
    ) ||
    value.schema !== TERMINAL_SCHEMA ||
    (value.status !== "completed" && value.status !== "failed" &&
      value.status !== "cancelled")
  ) throw new Error("Tool stage result envelope is invalid.");
  const actionRunId = value.actionRunId === undefined
    ? undefined
    : text(value.actionRunId, "Tool stage result Action run ID");
  const source = value.sourceAction === undefined
    ? undefined
    : record(value.sourceAction);
  if (
    source &&
    (Object.keys(source).length !== 2 ||
      !Number.isSafeInteger(source.stageIndex) ||
      Number(source.stageIndex) < 0 ||
      !text(source.actionRunId, "Tool stage source Action run ID") ||
      source.actionRunId !== actionRunId)
  ) throw new Error("Tool stage result source Action is invalid.");
  if (
    value.error !== undefined &&
    (!value.error || typeof value.error !== "object" ||
      Array.isArray(value.error))
  ) {
    throw new Error("Tool stage result error is invalid.");
  }
  const askResult = value.askResult === undefined
    ? undefined
    : agentAskResultMetadata({ copilotzAskResult: value.askResult });
  if (
    value.askResult !== undefined &&
    (!askResult || askResult.status !== value.status)
  ) {
    throw new Error("Tool stage result Ask receipt is invalid.");
  }
  return {
    terminal: {
      ...(value as ToolTerminal),
      ...(askResult ? { askResult: structuredClone(askResult) } : {}),
    },
    stageIndex: Number(item.stageIndex),
  };
}
function actionOutput(terminal: ToolTerminal): unknown {
  if (terminal.status !== "completed") {
    throw new Error("A failed Tool stage has no downstream value.");
  }
  return terminal.output;
}
async function inputFor(
  context: CoreToolProcessorContext,
  plan: CollectionRecord,
  call: LlmToolCall,
  branchIndex: number,
  stageIndex: number,
): Promise<LlmJsonObject> {
  const current = branch(plan, branchIndex);
  const stage = stageAt(call, stageIndex);
  if (current?.resultId === undefined) return structuredClone(stage.input);
  const prior = await readTerminal(
    context,
    text(current.resultId, "Stage result ID"),
  );
  return mergePipelineArguments(
    actionOutput(prior.terminal),
    stage.input,
  ) as LlmJsonObject;
}
/**
 * Resolve only the selected stage's current grant.  Unlike `toolsForAgent`,
 * this deliberately does not require every unrelated composed caller to
 * remain present after a restart.
 */
function currentStageGranted(
  context: CoreToolProcessorContext,
  agentId: string,
  alias: string,
): boolean {
  const agent = coreAgent(context.resources, agentId);
  if (!agent) return false;
  try {
    const entries = Object.entries(context.resources.tools ?? {}).flatMap((
      [toolAlias, resource],
    ) => resource ? [Object.freeze({ alias: toolAlias, resource })] : []);
    return resolveToolGrants(agent, entries, {
      agents: Object.values(context.resources.agents ?? {}).filter((
        value,
      ): value is NonNullable<typeof value> => Boolean(value)),
      skills: Object.values(context.resources.skills ?? {}).filter((
        value,
      ): value is NonNullable<typeof value> => Boolean(value)),
    }).some((tool) => tool.alias === alias);
  } catch {
    // A removed mechanism resource is an unavailable current stage, not a
    // coordinator retry condition.
    return false;
  }
}
/** Action invocation remains ordinary durable Action lifecycle; this is called only by stage-ready delivery. */
export async function invokeToolPlanAction(
  context: CoreToolProcessorContext,
  metadata: CoreToolActionMetadata,
  input?: LlmJsonObject,
): Promise<void> {
  const plan = await loadPlan(context, metadata);
  const call = plan.calls[metadata.planIndex];
  const action = context.actions[metadata.action];
  if (!call || typeof action !== "function") {
    throw new Error(`Tool Action '${metadata.action}' is unavailable.`);
  }
  try {
    await action(
      structuredClone(input ?? stageAt(call, metadata.stageIndex).input),
      {
        operationKey:
          `tool-plan:${metadata.planId}:${metadata.planIndex}:${metadata.stageIndex}:${metadata.toolCallId}`,
        metadata,
        identity: context.identity,
        signal: context.signal,
      },
    );
  } catch (error) {
    if (isSettledActionError(error)) return;
    if (!isActionInputValidationError(error)) throw error;
    // Model-authored arguments may fail a valid Tool Action schema before an
    // Action lifecycle begins. That is a recoverable Tool result, not broken
    // orchestration. Keep the schema diagnostic bounded and never persist the
    // rejected input (which may contain schema-marked secret values).
    const diagnostic = error.message.trim();
    await projectAndAdvanceToolPlan(context, metadata, {
      status: "failed",
      error: {
        name: "ToolInputValidationError",
        message: diagnostic
          ? diagnostic.slice(0, 1_000)
          : `Tool Action '${metadata.action}' input failed validation.`,
      },
    });
  }
}
export async function createDurableToolPlan(
  context: CoreToolProcessorContext,
  plan: CoreToolPlanBase,
  planCalls: readonly LlmToolCall[],
): Promise<void> {
  const collection = context.collections.toolPlan;
  if (!collection) throw new Error("Collection 'toolPlan' is not bound.");
  await collection.create({
    id: plan.planId,
    threadId: plan.threadId,
    planMessageId: plan.planMessageId,
    state: {
      status: "running",
      base: structuredClone(plan),
      branches: planCalls.map(() => ({ status: "ready", stageIndex: 0 })),
    },
    metadata: {},
  }, { operationKey: `tool-plan:${plan.planId}:create` });
}
/** Emits independent ready events. It never invokes a Tool itself. */
export async function scheduleReadyBranches(
  context: CoreToolProcessorContext,
  plan: CollectionRecord,
): Promise<void> {
  if (
    !context.collections.toolPlan || record(plan.state).status !== "running"
  ) {
    return;
  }
  const branches = Array.isArray(record(plan.state).branches)
    ? record(plan.state).branches as unknown[]
    : [];
  const ready = branches.flatMap((raw, branchIndex) => {
    const item = record(raw);
    return item.status === "ready"
      ? [{ branchIndex, stageIndex: Number(item.stageIndex) }]
      : [];
  });
  if (ready.length === 0) return;
  // Publish every currently-ready cursor in one transaction. Dispatch begins
  // only after commit, so a fast branch cannot claim the shared plan record
  // while sibling ready Events are still being prepared.
  await context.transaction(async (tx) => {
    const plans = tx.collections.toolPlan;
    if (!plans) throw new Error("Collection 'toolPlan' is not bound.");
    for (const cursor of ready) {
      await plans.commands.stageReady({
        id: plan.id,
        branchIndex: cursor.branchIndex,
        stageIndex: cursor.stageIndex,
      }, {
        operationKey:
          `tool-plan:${plan.id}:${cursor.branchIndex}:${cursor.stageIndex}:ready`,
      });
    }
  }, {
    operationKey: `tool-plan:${plan.id}:schedule:${
      ready.map((cursor) => `${cursor.branchIndex}:${cursor.stageIndex}`).join(
        ",",
      )
    }`,
  });
}
/** Sole Tool dispatcher: the durable stage-ready event id is the lease owner. */
export async function dispatchReadyStage(
  context: CoreToolProcessorContext,
  event: { id: string },
  plan: CollectionRecord,
  branchIndex: number,
  stageIndex: number,
): Promise<void> {
  const collection = context.collections.toolPlan;
  if (!collection) throw new Error("Collection 'toolPlan' is not bound.");
  const claimed = await collection.commands.claimStage({
    id: plan.id,
    branchIndex,
    stageIndex,
    owner: event.id,
  }, {
    operationKey:
      `tool-plan:${plan.id}:${branchIndex}:${stageIndex}:claim:${event.id}`,
  });
  const current = branch(claimed, branchIndex);
  if (current?.status !== "running" || current.owner !== event.id) return;
  const base = baseFrom(claimed);
  const loaded = await loadPlan(context, base);
  const call = loaded.calls[branchIndex];
  if (!call) throw new Error("Tool-plan branch does not exist.");
  const metadata = toolActionMetadataAt(base, call, branchIndex, stageIndex);
  const expectedActionId = base.stageActionIds[branchIndex]?.[stageIndex];
  const granted = currentStageGranted(context, base.agentId, metadata.action);
  if (
    !granted || !context.resources.tools[metadata.action] ||
    typeof context.actions[metadata.action] !== "function" ||
    !expectedActionId ||
    actionCallerDefinitionId(context.actions[metadata.action]) !==
      expectedActionId
  ) {
    const prior = current.resultId
      ? await readTerminal(context, text(current.resultId, "Stage result ID"))
      : undefined;
    await projectAndAdvanceToolPlan(context, metadata, {
      ...(prior?.terminal.sourceAction
        ? {
          actionRunId: prior.terminal.sourceAction.actionRunId,
          sourceAction: prior.terminal.sourceAction,
        }
        : {}),
      status: "failed",
      error: {
        name: "ToolUnavailable",
        message:
          `Tool Action '${metadata.action}' is unavailable for this stage.`,
      },
    });
    return;
  }
  let input: LlmJsonObject;
  try {
    input = await inputFor(context, claimed, call, branchIndex, stageIndex);
  } catch (error) {
    if (context.signal.aborted) throw error;
    const prior = current.resultId
      ? await readTerminal(context, text(current.resultId, "Stage result ID"))
      : undefined;
    await projectAndAdvanceToolPlan(context, metadata, {
      ...(prior?.terminal.sourceAction
        ? {
          actionRunId: prior.terminal.sourceAction.actionRunId,
          sourceAction: prior.terminal.sourceAction,
        }
        : {}),
      status: "failed",
      error: {
        name: "PipelineInputError",
        message: error instanceof Error ? error.message : String(error),
      },
    });
    return;
  }
  await invokeToolPlanAction(context, metadata, input);
}
/** Atomically creates a stage result content record and advances the cursor CAS. */
export async function projectAndAdvanceToolPlan(
  context: CoreToolProcessorContext,
  metadata: CoreToolActionMetadata,
  terminal: ToolTerminal,
  authority?: Readonly<{ actionId: string; causationId?: string }>,
): Promise<void> {
  if (authority) {
    const plan = await context.collections.toolPlan?.get({
      id: metadata.planId,
    });
    if (!plan) throw new Error(`Tool plan '${metadata.planId}' was not found.`);
    const base = baseFrom(plan),
      loaded = await loadPlan(context, base),
      call = loaded.calls[metadata.planIndex];
    const current = branch(plan, metadata.planIndex);
    if (
      !call || metadata.planSize !== base.planSize ||
      metadata.stageCount !== stages(call).length ||
      metadata.toolCallId !== call.id ||
      stageAt(call, metadata.stageIndex).action !== metadata.action ||
      base.stageActionIds[metadata.planIndex]?.[metadata.stageIndex] !==
        authority.actionId
    ) {
      throw new Error(
        `Tool plan '${metadata.planId}' terminal is not authorized by its stage-ready owner.`,
      );
    }
    // A terminal delivery can retry after its result/settlement advanced the
    // cursor. Its deterministic result is already authoritative; never reopen
    // or re-invoke that branch.
    if (current?.status !== "running") {
      const persistedId = current?.resultId ?? current?.finalResultId;
      if (persistedId) {
        const persisted = await readTerminal(
          context,
          text(persistedId, "Persisted Tool result ID"),
          { planId: metadata.planId, branchIndex: metadata.planIndex },
        );
        if (
          persisted.terminal.sourceAction?.stageIndex === metadata.stageIndex &&
          persisted.terminal.sourceAction.actionRunId === terminal.actionRunId
        ) return;
      }
      throw new Error(
        `Tool plan '${metadata.planId}' terminal cursor is invalid.`,
      );
    }
    if (
      Number(current.stageIndex) !== metadata.stageIndex ||
      current.owner !== authority.causationId
    ) {
      throw new Error(
        `Tool plan '${metadata.planId}' terminal is not authorized by its stage-ready owner.`,
      );
    }
  }
  const resultId = await stageResultId(
    metadata.planId,
    metadata.planIndex,
    metadata.stageIndex,
  );
  const resultKey =
    `tool-plan:${metadata.planId}:${metadata.planIndex}:${metadata.stageIndex}:result`;
  // Content preparation is durable and idempotent but cannot be part of the
  // collection transaction. The result record and cursor settlement must be:
  // otherwise a crash could leave an existing terminal behind a running lease.
  const prepared = await context.content.prepare(terminalContent(terminal), {
    operationKey: resultKey,
  });
  // Parallel roots may settle against the same plan revision. Retry only the
  // optimistic collection revision conflict; all semantic failures still
  // surface to the durable delivery.
  for (let attempt = 0;; attempt += 1) {
    try {
      await context.transaction(async (tx) => {
        const results = tx.collections.toolPlanStageResult;
        const plans = tx.collections.toolPlan;
        if (!results || !plans) {
          throw new Error("Tool-plan collections are not bound.");
        }
        await results.create({
          id: resultId,
          planId: metadata.planId,
          branchIndex: metadata.planIndex,
          stageIndex: metadata.stageIndex,
          content: prepared as never,
          metadata: {},
        }, { operationKey: resultKey });
        await plans.commands.settleStage({
          id: metadata.planId,
          branchIndex: metadata.planIndex,
          stageIndex: metadata.stageIndex,
          resultId,
        }, {
          operationKey:
            `tool-plan:${metadata.planId}:${metadata.planIndex}:${metadata.stageIndex}:settle`,
        });
      }, {
        operationKey:
          `tool-plan:${metadata.planId}:${metadata.planIndex}:${metadata.stageIndex}:settlement:${attempt}`,
      });
      break;
    } catch (error) {
      const stale = error instanceof Error &&
        error.message.includes("changed while its mutation was prepared");
      if (!stale || attempt >= 8 || context.signal.aborted) throw error;
    }
  }
  const persisted = await context.collections.toolPlanStageResult?.get({
    id: resultId,
  });
  if (
    !persisted || persisted.planId !== metadata.planId ||
    Number(persisted.branchIndex) !== metadata.planIndex ||
    Number(persisted.stageIndex) !== metadata.stageIndex
  ) throw new Error("Tool stage result does not belong to its plan cursor.");
}
async function derivedResult(
  context: CoreToolProcessorContext,
  planId: string,
  branchIndex: number,
  stageIndex: number,
  output: unknown,
  sourceAction?: ToolTerminal["sourceAction"],
): Promise<string> {
  return await stageResult(context, planId, branchIndex, stageIndex, {
    ...(sourceAction
      ? { actionRunId: sourceAction.actionRunId, sourceAction }
      : {}),
    status: "completed",
    output,
  });
}
/** Resolves a terminal envelope then transforms jq stages before scheduling exactly the next Tool. */
export async function advanceCompletedToolMembers(
  context: CoreToolProcessorContext,
  plan: CollectionRecord,
): Promise<void> {
  const collection = context.collections.toolPlan;
  if (!collection) return;
  // A previous delivery may have committed the final `advanceBranch(done)` and
  // crashed before emitting projectionReady. Replays recover that exact gap.
  if (record(plan.state).status === "ready") {
    await collection.commands.projectionReady({ id: plan.id }, {
      operationKey: `tool-plan:${plan.id}:projection-ready`,
    });
    return;
  }
  if (record(plan.state).status !== "running") return;
  const base = baseFrom(plan), loaded = await loadPlan(context, base);
  for (const [index, call] of loaded.calls.entries()) {
    const current = branch(plan, index);
    if (current?.status !== "settled-stage") continue;
    const from = Number(current.stageIndex),
      initialId = text(current.resultId, "Stage result ID"),
      initial = await readTerminal(context, initialId, {
        planId: base.planId,
        branchIndex: index,
        stageIndex: from,
      });
    let resultId = initialId, terminal = initial.terminal, next = from + 1;
    if (terminal.status === "completed") {
      try {
        let output = terminal.output;
        while (stages(call)[next]?.type === "jq") {
          output = await evaluateCoreJq(
            output,
            (stages(call)[next] as { filter: string }).filter,
            context.signal,
          );
          resultId = await derivedResult(
            context,
            base.planId,
            index,
            next,
            output,
            terminal.sourceAction,
          );
          next++;
        }
      } catch (error) {
        if (context.signal.aborted) throw error;
        resultId = await stageResult(context, base.planId, index, next, {
          ...(terminal.sourceAction
            ? {
              actionRunId: terminal.sourceAction.actionRunId,
              sourceAction: terminal.sourceAction,
            }
            : {}),
          status: context.signal.aborted ? "cancelled" : "failed",
          error: {
            name: context.signal.aborted ? "AbortError" : "PipelineError",
            message: error instanceof Error ? error.message : String(error),
          },
        });
        terminal = (await readTerminal(context, resultId)).terminal;
        next = stages(call).length;
      }
    }
    const hasNextTool = terminal.status === "completed" &&
      next < stages(call).length;
    await collection.commands.advanceBranch({
      id: plan.id,
      branchIndex: index,
      fromStageIndex: from,
      ...(hasNextTool
        ? { stageIndex: next, resultId }
        : { done: true, resultId }),
    }, { operationKey: `tool-plan:${plan.id}:${index}:${from}:advance` });
  }
  const latest = await collection.get({ id: plan.id });
  if (!latest) return;
  if (record(latest.state).status === "ready") {
    await collection.commands.projectionReady({ id: latest.id }, {
      operationKey: `tool-plan:${latest.id}:projection-ready`,
    });
  } else await scheduleReadyBranches(context, latest);
}
type ToolVisibility = Extract<EventVisibility, { kind: "tool" }>;
function configuredVisibility(
  value: unknown,
  requesterId: string,
): ToolVisibility {
  const policy: ToolVisibility["policy"] =
    value === "public" || value === "requester_only" ? value : "public_status";
  return { kind: "tool", policy, requesterId };
}
function intersectVisibility(
  base: EventVisibility,
  policy: unknown,
  requester: string,
): EventVisibility {
  const tool = configuredVisibility(policy, requester);
  if (base.kind === "internal") return { kind: "internal" };
  if (base.kind === "public") return tool;
  if (base.kind === "participants") {
    return base.participantIds.includes(requester)
      ? (tool.policy === "public"
        ? base
        : { kind: "tool", policy: "requester_only", requesterId: requester })
      : { kind: "internal" };
  }
  if (base.requesterId !== requester) return { kind: "internal" };
  const ranks: Record<ToolVisibility["policy"], number> = {
    requester_only: 0,
    public_status: 1,
    public: 2,
  };
  return {
    kind: "tool",
    policy: ranks[base.policy] < ranks[tool.policy] ? base.policy : tool.policy,
    requesterId: requester,
  };
}
function isRef(value: unknown): value is ContentRef {
  const item = record(value);
  return typeof item.assetId === "string" && typeof item.kind === "string" &&
    typeof item.role === "string" && typeof item.mediaType === "string";
}
function resultContent(
  terminal: ToolTerminal,
  contentSequenceOutput = false,
): ContentInput | ContentSequence {
  if (terminal.status === "completed") {
    if (isRef(terminal.output)) return terminal.output;
    if (
      Array.isArray(terminal.output) &&
      (contentSequenceOutput || terminal.output.length > 0) &&
      terminal.output.every(isRef)
    ) return terminal.output as ContentSequence;
    return typeof terminal.output === "string"
      ? { type: "text", role: "tool.output", text: terminal.output }
      : { type: "json", role: "tool.output", value: terminal.output ?? null };
  }
  return {
    type: "json",
    role: "tool.projected_output",
    value: {
      status: terminal.status,
      ...(terminal.error ??
        { name: "Error", message: "Tool execution failed." }),
    },
  };
}

/** Sole provider projection authority: same event owner re-enters, all others lose. */
export async function projectDurableToolPlan(
  context: CoreToolProcessorContext,
  event: { id: string },
  plan: CollectionRecord,
): Promise<void> {
  const collection = context.collections.toolPlan;
  if (!collection) throw new Error("Collection 'toolPlan' is not bound.");
  const claimed = await collection.commands.claimProjection({
    id: plan.id,
    owner: event.id,
  }, { operationKey: `tool-plan:${plan.id}:projection-claim:${event.id}` });
  const state = record(claimed.state);
  if (state.status !== "projecting" || state.projectionOwner !== event.id) {
    return;
  }
  const base = baseFrom(claimed), loaded = await loadPlan(context, base);
  const completionAction = base.agentTurn?.ownerParticipantId ===
      base.agentParticipantId
    ? base.agentTurn.completeOn?.action
    : undefined;
  const completesTurn = completionAction
    ? (await Promise.all(loaded.calls.map(async (call, index) => {
      const current = branch(claimed, index);
      const resultId = current?.finalResultId;
      if (!resultId) return false;
      const result = await readTerminal(
        context,
        text(resultId, "Final stage result ID"),
        {
          planId: base.planId,
          branchIndex: index,
        },
      );
      const source = result.terminal.sourceAction;
      const stage = source ? stages(call)[source.stageIndex] : undefined;
      return result.terminal.status === "completed" &&
        stage?.type === "tool" && stage.action === completionAction;
    }))).some(Boolean)
    : false;
  for (const [index, call] of loaded.calls.entries()) {
    const current = branch(claimed, index);
    const result = await readTerminal(
      context,
      text(current?.finalResultId, "Final stage result ID"),
      { planId: base.planId, branchIndex: index },
    );
    let visibility = base.responseVisibility;
    for (let stageIndex = 0; stageIndex <= result.stageIndex; stageIndex++) {
      const stage = stages(call)[stageIndex];
      if (stage?.type === "tool") {
        visibility = intersectVisibility(
          visibility,
          base.stageHistoryVisibility[index][stageIndex],
          base.agentParticipantId,
        );
      }
    }
    const root = base.rootTools[index];
    if (!root || root.alias !== call.action) {
      throw new Error("Tool-plan root presentation snapshot is invalid.");
    }
    const hasNext = index + 1 < loaded.calls.length;
    const invocation = {
      id: call.id,
      tool: { id: root.alias, name: root.name },
      args: JSON.stringify(call.input),
    };
    const historyVisibility = visibility.kind === "tool"
      ? visibility.policy
      : visibility.kind === "public"
      ? "public"
      : "requester_only";
    const source = result.terminal.sourceAction;
    const executedToolIndex = source?.stageIndex ??
      ([...stages(call).keys()].reverse().find((stageIndex) =>
        stageIndex <= result.stageIndex &&
        stages(call)[stageIndex]?.type === "tool"
      ) ?? 0);
    const actionResultId = await deriveWorkflowId(
      "tool-plan-stage-result",
      base.planId,
      String(index),
      String(executedToolIndex),
    );
    const actionTerminal = await readTerminal(context, actionResultId);
    const rootTerminal = call.action === "ask"
      ? await readTerminal(
        context,
        await deriveWorkflowId(
          "tool-plan-stage-result",
          base.planId,
          String(index),
          "0",
        ),
        { planId: base.planId, branchIndex: index, stageIndex: 0 },
      )
      : undefined;
    const origin = toolActionMetadataAt(base, call, index, executedToolIndex);
    let branchMetadata = withWorkflowMetadata({
      historyVisibility,
      requesterId: base.agentParticipantId,
      toolStatus: result.terminal.status,
      toolId: call.action,
      toolInvocation: invocation,
      toolPlanIndex: index,
      toolPlanSize: base.planSize,
    } as never, {
      kind: "tool_result",
      ...(hasNext || completesTurn ? { continuation: "none" as const } : {}),
      llmAttemptId: base.parentLlmActionRunId,
      parentLlmAttemptId: base.parentLlmActionRunId,
      sourceMessageId: base.planMessageId,
      agentParticipantId: base.agentParticipantId,
      initiatorParticipantId: base.initiatorParticipantId,
    });
    if (base.agentTurn) {
      branchMetadata = withCoreAgentTurnMetadata(
        branchMetadata,
        base.agentTurn,
      );
    }
    // A failed/cancelled Ask remains an ordinary terminal Tool error.  Only a
    // completed Ask has a canonical Answer Message to reference.
    const receipt = rootTerminal?.terminal.askResult?.status === "completed"
      ? rootTerminal.terminal.askResult
      : undefined;
    if (receipt) {
      branchMetadata = withAgentAskResultMetadata(branchMetadata, receipt);
    }
    const actionBacked = result.terminal.status === "completed" &&
      source?.actionRunId === actionTerminal.terminal.actionRunId;
    const metadata = actionBacked && actionTerminal.terminal.actionRunId
      ? withCoreToolActionMessageMetadata(
        branchMetadata,
        origin,
        actionTerminal.terminal.actionRunId,
      )
      : withCoreToolPlanResultMetadata(branchMetadata, {
        schema: "copilotz.core.tool-plan-result.v1",
        resultKind: result.terminal.error?.name === "ToolUnavailable"
          ? "unavailable"
          : "pipeline_failure",
        origin: (() => {
          const { ask: _ask, ...value } = origin;
          return value;
        })(),
        failedStageIndex: result.stageIndex,
        failedAction: stages(call)[result.stageIndex]?.type === "tool"
          ? (stages(call)[result.stageIndex] as { action: string }).action
          : call.action,
        ...(result.terminal.sourceAction
          ? { sourceAction: result.terminal.sourceAction }
          : {}),
        ...(base.ask ? { ask: base.ask } : {}),
      });
    await createThreadMessage({
      id: await deriveWorkflowId(
        "message",
        base.planId,
        String(index),
        "result",
      ),
      threadId: base.threadId,
      sender: {
        externalId: `tool:${root.alias}`,
        participantType: "tool",
        name: root.name,
      },
      recipientIds: [base.agentParticipantId],
      content: receipt && stages(call).length === 1
        ? { type: "json", role: "tool.output", value: receipt }
        : resultContent(result.terminal, false),
      visibility,
      metadata,
      ...(base.agentTurn ? { historyScopeId: base.agentTurn.id } : {}),
    }, context);
  }
  await collection.commands.finishProjection({ id: plan.id, owner: event.id }, {
    operationKey: `tool-plan:${plan.id}:projected:${event.id}`,
  });
}
async function parentAskForResume(
  context: CoreToolProcessorContext,
  ask: AgentAskMetadata,
): Promise<AgentAskMetadata | undefined> {
  const owns = (value: AgentAskMetadata) =>
    value.origin.action === "ask" &&
    value.origin.agentId === value.askingAgentId &&
    value.origin.agentParticipantId === value.askingParticipantId &&
    (value.toolCallId === undefined ||
      value.origin.toolCallId === value.toolCallId);
  if (!owns(ask)) {
    throw new Error(`Ask '${ask.askId}' does not own its Tool-plan origin.`);
  }
  if (!ask.parentAskId && !ask.parentQuestionMessageId) {
    if (ask.depth !== 1) {
      throw new Error(`Ask '${ask.askId}' has no durable parent cursor.`);
    }
    return undefined;
  }
  if (!ask.parentAskId || !ask.parentQuestionMessageId || ask.depth <= 1) {
    throw new Error(`Ask '${ask.askId}' has an incomplete parent cursor.`);
  }
  const message = await context.collections.message?.get({
    id: ask.parentQuestionMessageId,
  });
  if (!message) {
    throw new Error(
      `Parent ask question Message '${ask.parentQuestionMessageId}' was not found.`,
    );
  }
  const parent = message ? agentAskMetadata(message.metadata) : null;
  const recipients = Array.isArray(message.recipientIds)
    ? message.recipientIds
    : [];
  if (
    !parent || !owns(parent) || parent.phase !== "question" ||
    String(message.id) !== ask.parentQuestionMessageId ||
    String(message.threadId) !== ask.origin.threadId ||
    String(message.senderId) !== parent.askingParticipantId ||
    !recipients.includes(parent.askedParticipantId) ||
    parent.askId !== ask.parentAskId ||
    parent.questionMessageId !== ask.parentQuestionMessageId ||
    parent.askedParticipantId !== ask.askingParticipantId ||
    parent.askedAgentId !== ask.askingAgentId ||
    parent.depth + 1 !== ask.depth ||
    parent.origin.threadId !== ask.origin.threadId ||
    parent.origin.toolCallId !== parent.toolCallId
  ) throw new Error(`Ask '${ask.askId}' has a forged parent cursor.`);
  return parent;
}
/** A deferred ask settles its owning action only after the asked agent's final ContentSequence arrives. */
export async function resumeDeferredToolPlan(
  context: CoreToolProcessorContext,
  ask: AgentAskMetadata,
  terminal: Omit<ToolTerminal, "actionRunId">,
): Promise<void> {
  const parent = await parentAskForResume(context, ask);
  await projectAndAdvanceToolPlan(
    context,
    defineCoreToolActionMetadata({
      ...ask.origin,
      ...(parent ? { ask: parent } : {}),
    }),
    {
      ...terminal,
      askResult: terminal.askResult ?? {
        schema: "copilotz.ask-result.v1",
        askId: ask.askId,
        status: terminal.status,
        askedParticipantId: ask.askedParticipantId,
        askedAgentId: ask.askedAgentId,
      },
      actionRunId: ask.toolActionRunId,
      sourceAction: {
        stageIndex: ask.origin.stageIndex,
        actionRunId: ask.toolActionRunId,
      },
    },
  );
}
export function coreToolTerminal(
  event: Parameters<Processor<CoreToolProcessorContext>["handle"]>[0],
):
  | Readonly<
    {
      metadata: CoreToolActionMetadata;
      terminal: ToolTerminal;
      actionId: string;
      causationId?: string;
    }
  >
  | null {
  const lifecycle = parseActionLifecycleEvent(event, {
    statuses: ["completed", "failed", "cancelled"],
    requireRoot: true,
  });
  if (!lifecycle) return null;
  const metadata = coreToolActionMetadata(lifecycle.metadata);
  if (
    !metadata ||
    (lifecycle.status !== "completed" && lifecycle.status !== "failed" &&
      lifecycle.status !== "cancelled")
  ) return null;
  return {
    metadata,
    actionId: lifecycle.actionId,
    ...(event.causationId ? { causationId: event.causationId } : {}),
    terminal: lifecycle.status === "completed"
      ? {
        actionRunId: text(lifecycle.actionRunId, "Tool Action run ID"),
        sourceAction: {
          stageIndex: metadata.stageIndex,
          actionRunId: lifecycle.actionRunId,
        },
        status: "completed",
        input: lifecycle.input,
        output: lifecycle.output,
      }
      : {
        actionRunId: text(lifecycle.actionRunId, "Tool Action run ID"),
        sourceAction: {
          stageIndex: metadata.stageIndex,
          actionRunId: lifecycle.actionRunId,
        },
        status: lifecycle.status,
        input: lifecycle.input,
        error: record(lifecycle.error),
      },
  };
}
