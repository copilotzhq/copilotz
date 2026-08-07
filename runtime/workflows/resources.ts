import type { Agent } from "../resources/index.ts";
import type { ProviderConfig, ProviderRegistry } from "../llm/types.ts";
import type { ScopedPluginResources } from "../engine/index.ts";
import type {
  AgentAskMetadata,
  LlmProviderResource,
  WorkflowMetadata,
  WorkflowTool,
} from "./types.ts";

const WORKFLOW_METADATA_KEY = "copilotzWorkflow";
const AGENT_ASK_METADATA_KEY = "copilotzAsk";

function requiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function defineLlmProviderResource(
  resource: LlmProviderResource,
): LlmProviderResource {
  const id = requiredText(resource.id, "LLM provider resource id");
  if (resource.type !== "llm") {
    throw new TypeError(`Provider '${id}' must have type 'llm'.`);
  }
  if (typeof resource.factory !== "function") {
    throw new TypeError(`Provider '${id}' requires a factory.`);
  }
  return Object.freeze({ id, type: "llm", factory: resource.factory });
}

export function isLlmProviderResource(
  value: unknown,
): value is LlmProviderResource {
  const candidate = record(value);
  return typeof candidate.id === "string" && candidate.type === "llm" &&
    typeof candidate.factory === "function";
}

export function isWorkflowTool(value: unknown): value is WorkflowTool {
  const candidate = record(value);
  return typeof candidate.key === "string" &&
    typeof candidate.name === "string" &&
    typeof candidate.execute === "function";
}

export function requireAgent(
  resources: ScopedPluginResources,
  id: string,
): Agent {
  return resources.require<Agent>("agents", requiredText(id, "Agent id"));
}

export function agentTools(
  resources: ScopedPluginResources,
  agent: Agent,
): readonly WorkflowTool[] {
  const available = resources.list<WorkflowTool>("tools").filter(
    isWorkflowTool,
  );
  if (agent.allowedTools === undefined) return Object.freeze(available);
  if (!Array.isArray(agent.allowedTools) || agent.allowedTools.length === 0) {
    return Object.freeze([]);
  }
  const byKey = new Map(available.map((tool) => [tool.key, tool]));
  return Object.freeze(
    agent.allowedTools.map((key) => {
      const tool = byKey.get(key);
      if (!tool) {
        throw new Error(
          `Agent '${agent.id}' allows unknown tool '${key}'.`,
        );
      }
      return tool;
    }),
  );
}

export function providerRegistry(
  resources: ScopedPluginResources,
): ProviderRegistry {
  const entries = resources.list<LlmProviderResource>("providers")
    .filter(isLlmProviderResource)
    .map((provider) => [provider.id, provider.factory] as const);
  return Object.freeze(Object.fromEntries(entries));
}

export function agentTextBaseConfig(agent: Agent): ProviderConfig {
  const shorthand = agent.llmOptions;
  const runtime = agent.runtimes?.text;
  return {
    ...(shorthand ?? {}),
    ...(runtime
      ? {
        provider: runtime.provider as ProviderConfig["provider"],
        ...(runtime.model ? { model: runtime.model } : {}),
      }
      : {}),
  };
}

export function staticAgentTextConfig(agent: Agent): ProviderConfig {
  const config = agentTextBaseConfig(agent);
  if (!config.provider) {
    throw new Error(`Agent '${agent.id}' has no text runtime provider.`);
  }
  return config;
}

export function withWorkflowMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  workflow: WorkflowMetadata,
): Record<string, unknown> {
  return {
    ...structuredClone(metadata ?? {}),
    [WORKFLOW_METADATA_KEY]: structuredClone(workflow),
  };
}

export function workflowMetadata(value: unknown): WorkflowMetadata | null {
  const outer = record(value);
  const candidate = record(outer[WORKFLOW_METADATA_KEY]);
  const kind = candidate.kind;
  if (
    kind !== "agent_output" && kind !== "tool_result" &&
    kind !== "tool_execution" && kind !== "provider_attempt" &&
    kind !== "memory_consolidation" && kind !== "realtime_message"
  ) return null;
  return candidate as WorkflowMetadata;
}

function optionalMetadataText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Adds one public ask descriptor without replacing unrelated metadata. */
export function withAgentAskMetadata(
  metadata: Readonly<Record<string, unknown>> | undefined,
  ask: AgentAskMetadata,
): Record<string, unknown> {
  return {
    ...structuredClone(metadata ?? {}),
    [AGENT_ASK_METADATA_KEY]: structuredClone(ask),
  };
}

/** Reads validated ask metadata from a domain record or event. */
export function agentAskMetadata(value: unknown): AgentAskMetadata | null {
  const outer = record(value);
  const candidate = record(outer[AGENT_ASK_METADATA_KEY]);
  if (
    candidate.schema !== "copilotz.ask.v1" ||
    (candidate.phase !== "question" && candidate.phase !== "progress" &&
      candidate.phase !== "answer") ||
    !Number.isSafeInteger(candidate.depth) || Number(candidate.depth) < 1
  ) return null;
  const required = [
    "askId",
    "toolExecutionId",
    "questionMessageId",
    "askingParticipantId",
    "askingAgentId",
    "askedParticipantId",
    "askedAgentId",
  ] as const;
  if (required.some((key) => !optionalMetadataText(candidate[key]))) {
    return null;
  }
  for (
    const key of [
      "callingAttemptId",
      "answerAttemptId",
      "parentAskId",
    ] as const
  ) {
    if (candidate[key] !== undefined && !optionalMetadataText(candidate[key])) {
      return null;
    }
  }
  return candidate as AgentAskMetadata;
}

export function providerAttemptEventMetadata(value: unknown): boolean {
  return workflowMetadata(value)?.kind === "provider_attempt";
}

export function textWorkflowAttemptEventMetadata(value: unknown): boolean {
  const kind = workflowMetadata(value)?.kind;
  return kind !== "provider_attempt" && kind !== "memory_consolidation";
}
