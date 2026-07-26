import type { ToolDefinition, ToolInvocation } from "@/runtime/llm/types.ts";
import { generateAgentTypesFromSchema } from "@/runtime/tools/schema-to-agent-types.ts";
import type { Agent, Thread } from "@/types/index.ts";

export const CONSULT_AGENT_CONTROL = "consult_agent" as const;
/** @deprecated Read-only compatibility alias for historical model output. */
export const ASK_IN_THREAD_CONTROL = "ask_in_thread" as const;
/** @deprecated Read-only compatibility alias for historical model output. */
export const HANDOFF_IN_THREAD_CONTROL = "handoff_in_thread" as const;
export const ROUTING_CONTROL_SOURCE = "model_control" as const;

export const ROUTING_CONTROL_NAMES = [
  CONSULT_AGENT_CONTROL,
  ASK_IN_THREAD_CONTROL,
  HANDOFF_IN_THREAD_CONTROL,
] as const;

export type RoutingControlName = typeof ROUTING_CONTROL_NAMES[number];
export type RoutingControlAction = "consult" | "ask" | "handoff";

export interface RoutingControlMetadata {
  action: RoutingControlAction;
  targetId: string;
  source: typeof ROUTING_CONTROL_SOURCE;
  /** Complete visible consultation message. Optional for legacy metadata. */
  message?: string;
  controlCallId?: string;
}

/** Validated atomic control intent parsed from a model tool call. */
export interface RoutingControlIntent extends RoutingControlMetadata {
  action: "consult";
  /** Complete message to deliver to the target participant. */
  message: string;
}

export interface InThreadRoutingTarget {
  id: string;
  name: string;
}

export interface InThreadRoutingTargets {
  consult: InThreadRoutingTarget[];
}

export type RoutingControlValidationErrorCode =
  | "not_routing_control"
  | "invalid_call"
  | "invalid_arguments"
  | "invalid_target"
  | "empty_message";

export type RoutingControlParseResult =
  | { ok: true; intent: RoutingControlIntent }
  | {
    ok: false;
    code: RoutingControlValidationErrorCode;
    message: string;
  };

export type RoutingControlSelection =
  | { kind: "none"; executableCalls: ToolInvocation[] }
  | { kind: "routing"; intent: RoutingControlIntent }
  | {
    kind: "invalid";
    code:
      | RoutingControlValidationErrorCode
      | "mixed_routing_and_tools"
      | "multiple_routing_controls";
    message: string;
  };

function normalizeIdentity(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function identityMatches(value: string, agent: Agent): boolean {
  const normalized = value.toLowerCase();
  return agent.id.toLowerCase() === normalized ||
    agent.name.toLowerCase() === normalized;
}

function sameAgent(left: Agent, right: Agent): boolean {
  return identityMatches(left.id, right) || identityMatches(left.name, right);
}

function agentIsAllowed(currentAgent: Agent, targetAgent: Agent): boolean {
  if (currentAgent.allowedAgents === undefined) return true;
  if (!Array.isArray(currentAgent.allowedAgents)) return false;

  const configured = currentAgent.allowedAgents
    .map(normalizeIdentity)
    .filter((value): value is string => value !== null);
  if (configured.length === 0) return false;
  return configured.some((candidate) =>
    identityMatches(candidate, targetAgent)
  );
}

/**
 * Resolve canonical same-thread agent targets in participant order.
 * Human aliases and the current agent are intentionally excluded.
 */
export function resolveAllowedInThreadRoutingTargets(
  currentAgent: Agent,
  thread: Thread,
  availableAgents: Agent[],
): InThreadRoutingTarget[] {
  const participants = Array.isArray(thread.participants)
    ? thread.participants
      .map(normalizeIdentity)
      .filter((value): value is string => value !== null)
    : [];
  const targets: InThreadRoutingTarget[] = [];
  const seen = new Set<string>();

  for (const participant of participants) {
    const targetAgent = availableAgents.find((agent) =>
      identityMatches(participant, agent)
    );
    if (
      !targetAgent || sameAgent(currentAgent, targetAgent) ||
      !agentIsAllowed(currentAgent, targetAgent)
    ) {
      continue;
    }

    const targetId = normalizeIdentity(targetAgent.id) ??
      normalizeIdentity(targetAgent.name);
    if (!targetId) continue;
    const normalizedTargetId = targetId.toLowerCase();
    if (seen.has(normalizedTargetId)) continue;

    seen.add(normalizedTargetId);
    targets.push({ id: targetId, name: targetAgent.name });
  }

  return targets;
}

/** Resolve the agent-only target catalog for the consult-and-return control. */
export function resolveInThreadRoutingTargets(
  currentAgent: Agent,
  thread: Thread,
  availableAgents: Agent[],
): InThreadRoutingTargets {
  return {
    consult: resolveAllowedInThreadRoutingTargets(
      currentAgent,
      thread,
      availableAgents,
    ),
  };
}

export function buildRoutingControlInputSchema(
  allowedTargetIds: readonly string[],
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      target: {
        type: "string",
        enum: [...allowedTargetIds],
        description: "Exact id of an allowed agent participant in this thread.",
      },
      message: {
        type: "string",
        minLength: 1,
        description:
          "Complete non-empty message to deliver to the target agent.",
      },
    },
    required: ["target", "message"],
  };
}

function renderControlInputTypes(
  name: RoutingControlName,
  schema: Record<string, unknown>,
): string {
  const rootName = name === CONSULT_AGENT_CONTROL
    ? "ConsultAgentInput"
    : name === ASK_IN_THREAD_CONTROL
    ? "AskInThreadInput"
    : "HandoffInThreadInput";
  return generateAgentTypesFromSchema(schema, {
    rootName,
    moduleName: name,
  });
}

/** Build the single reserved, non-executable routing control for the LLM. */
export function buildRoutingControlToolDefinitions(
  allowedTargets: InThreadRoutingTargets,
): ToolDefinition[] {
  if (allowedTargets.consult.length === 0) return [];
  const schema = buildRoutingControlInputSchema(
    allowedTargets.consult.map((target) => target.id),
  );
  const targetSummary = allowedTargets.consult
    .map((target) =>
      target.name === target.id ? target.id : `${target.id} (${target.name})`
    )
    .join(", ");

  return [{
    type: "function",
    function: {
      name: CONSULT_AGENT_CONTROL,
      description:
        "Ask another agent in this thread for one bounded turn, then automatically resume after its reply. " +
        `Allowed targets: ${targetSummary}. The message is visible in the shared conversation and is delivered atomically.`,
      inputTypes: renderControlInputTypes(CONSULT_AGENT_CONTROL, schema),
    },
  }];
}

export function isRoutingControlName(
  value: unknown,
): value is RoutingControlName {
  return value === CONSULT_AGENT_CONTROL ||
    value === ASK_IN_THREAD_CONTROL ||
    value === HANDOFF_IN_THREAD_CONTROL;
}

export function routingControlActionForName(
  _name: RoutingControlName,
): "consult" {
  return "consult";
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Parse and validate one reserved routing control call without throwing. */
export function parseRoutingControlCall(
  call: unknown,
  allowedTargets: InThreadRoutingTargets,
): RoutingControlParseResult {
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    return {
      ok: false,
      code: "invalid_call",
      message: "Routing control call must be an object.",
    };
  }

  const record = call as Record<string, unknown>;
  const tool = record.tool && typeof record.tool === "object" &&
      !Array.isArray(record.tool)
    ? record.tool as Record<string, unknown>
    : null;
  const controlName = tool?.id;
  if (!isRoutingControlName(controlName)) {
    return {
      ok: false,
      code: "not_routing_control",
      message: "Tool call is not a reserved in-thread routing control.",
    };
  }

  const args = parseArguments(record.args);
  if (!args) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: `${controlName} arguments must be a JSON object.`,
    };
  }
  const unexpectedKeys = Object.keys(args).filter((key) =>
    key !== "target" && key !== "message"
  );
  if (unexpectedKeys.length > 0) {
    return {
      ok: false,
      code: "invalid_arguments",
      message: `${controlName} accepts only target and message arguments.`,
    };
  }

  const requestedTarget = normalizeIdentity(args.target);
  const action = routingControlActionForName(controlName);
  const allowedTargetIds = allowedTargets.consult.map((target) => target.id);
  const targetId = requestedTarget
    ? allowedTargetIds.find((candidate) =>
      candidate.toLowerCase() === requestedTarget.toLowerCase()
    )
    : undefined;
  if (!targetId) {
    return {
      ok: false,
      code: "invalid_target",
      message: `${controlName} target must be one of: ${
        allowedTargetIds.join(", ") || "(none)"
      }.`,
    };
  }

  const message = normalizeIdentity(args.message);
  if (!message) {
    return {
      ok: false,
      code: "empty_message",
      message: `${controlName} requires a non-empty message argument.`,
    };
  }

  const controlCallId = normalizeIdentity(record.id) ?? undefined;
  return {
    ok: true,
    intent: {
      action,
      targetId,
      message,
      source: ROUTING_CONTROL_SOURCE,
      ...(controlCallId ? { controlCallId } : {}),
    },
  };
}

/**
 * Enforce the terminal/exclusive routing-control contract before any tool
 * events can be materialized.
 */
export function selectRoutingControl(
  calls: readonly ToolInvocation[] | null | undefined,
  allowedTargets: InThreadRoutingTargets,
): RoutingControlSelection {
  const toolCalls = Array.isArray(calls) ? [...calls] : [];
  const routingCalls = toolCalls.filter((call) =>
    isRoutingControlName(call?.tool?.id)
  );
  if (routingCalls.length === 0) {
    return { kind: "none", executableCalls: toolCalls };
  }
  if (routingCalls.length > 1) {
    return {
      kind: "invalid",
      code: "multiple_routing_controls",
      message: "A response may contain exactly one in-thread routing control.",
    };
  }
  if (toolCalls.length > 1) {
    return {
      kind: "invalid",
      code: "mixed_routing_and_tools",
      message:
        "An in-thread routing control cannot be combined with executable tool calls.",
    };
  }

  const parsed = parseRoutingControlCall(routingCalls[0], allowedTargets);
  return parsed.ok ? { kind: "routing", intent: parsed.intent } : {
    kind: "invalid",
    code: parsed.code,
    message: parsed.message,
  };
}

export function assertNoRoutingControlToolCollisions(
  tools: readonly { key: string }[],
): void {
  const collision = tools.find((tool) => isRoutingControlName(tool.key));
  if (!collision) return;
  throw new Error(
    `Tool name "${collision.key}" is reserved for Copilotz in-thread routing.`,
  );
}
