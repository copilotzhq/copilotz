/** Defines immutable process-local Agent Resources. @module */

import {
  type LlmModelSelections,
  normalizeLlmModelSelections,
} from "@copilotz/copilotz/llm";
import type { SnapshotCollections } from "@copilotz/copilotz/collections";

const ALIAS_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const UNSAFE_ALIASES = new Set(["__proto__", "constructor", "prototype"]);
const AGENT_KEYS = new Set([
  "id",
  "name",
  "role",
  "instructions",
  "dynamicResolve",
  "personality",
  "description",
  "models",
  "capabilities",
  "metadata",
]);
const MODEL_KEYS = new Set(["generate", "session"]);
const CAPABILITY_KEYS = new Set(["tools", "agents", "skills"]);

/** Explicit aliases granted to an Agent. Omission grants none. */
export type AgentCapabilitySelection = readonly string[];

export type AgentCapabilities = Readonly<{
  tools?: AgentCapabilitySelection;
  agents?: AgentCapabilitySelection;
  skills?: AgentCapabilitySelection;
}>;

/** Ordered connection/model candidates selected for one interaction mode. */
export type AgentModelSelection = LlmModelSelections;

/** Model candidates selected independently for each interaction mode. */
export type AgentModels = Readonly<{
  generate?: AgentModelSelection;
  session?: AgentModelSelection;
}>;

/**
 * Frozen, process-local Agent definition. Provider configuration and clients
 * belong to LLM connections and Adapters, never to an Agent. Dynamic
 * resolution is pure, deterministic composition policy over the supplied
 * durable turn facts: its result is captured only by the subsequent
 * `llm.call` Action.
 */
export type AgentResource = Readonly<{
  id: string;
  name: string;
  role: string;
  instructions?: string;
  dynamicResolve?: AgentDynamicResolver;
  personality?: string;
  description?: string;
  models: AgentModels;
  capabilities?: AgentCapabilities;
  metadata?: Readonly<Record<string, unknown>>;
}>;

/** Stable turn identity supplied to a process-local dynamic resolver. */
export type AgentDynamicResolveExecution = Readonly<{
  agentId: string;
  agentParticipantId: string;
  threadId: string;
  triggerMessageId: string;
  namespace: string;
  operationKey: string;
  correlationId?: string;
  causationId?: string;
}>;

/** Read-only durable Core facts available to a dynamic Agent resolver. */
export type AgentDynamicResolveContext = Readonly<{
  baseAgent: AgentResource;
  participant: import("../../shared/contracts.ts").Participant;
  thread: import("../../shared/contracts.ts").ConversationThread;
  triggerMessage: import("../../shared/contracts.ts").ConversationMessage;
  collections: SnapshotCollections;
}>;

/** Effective values selected for one prepared Agent turn. */
export type AgentDynamicResolveOutput = Readonly<{
  instructions?: string;
  models?: AgentModels;
  /** Small durable prompt-policy identifier, never prompt text. */
  revision?: string;
}>;

export type AgentDynamicResolver = (
  context: AgentDynamicResolveContext,
  execution: AgentDynamicResolveExecution,
) =>
  | AgentDynamicResolveOutput
  | undefined
  | Promise<
    AgentDynamicResolveOutput | undefined
  >;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>,
  label: string,
): void {
  const unknown = Object.keys(value).find((key) => !keys.has(key));
  if (unknown) throw new TypeError(`${label} cannot declare '${unknown}'.`);
}

function requiredText(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${label} is required.`);
  if (normalized !== value) {
    throw new TypeError(`${label} must not contain surrounding whitespace.`);
  }
  return value as string;
}

function optionalText(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredText(value, label);
}

function alias(value: unknown, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    normalized !== value || !ALIAS_PATTERN.test(normalized) ||
    UNSAFE_ALIASES.has(normalized)
  ) {
    throw new TypeError(`${label} has invalid alias '${String(value)}'.`);
  }
  return normalized;
}

function modelSelection(
  value: unknown,
  agentId: string,
  mode: keyof AgentModels,
): AgentModelSelection | undefined {
  if (value === undefined) return undefined;
  return normalizeLlmModelSelections(
    value,
    `Agent '${agentId}' ${mode} models`,
  );
}

function models(value: unknown, agentId: string): AgentModels {
  if (!isPlainRecord(value)) {
    throw new TypeError(`Agent '${agentId}' models must be an object.`);
  }
  assertKnownKeys(value, MODEL_KEYS, `Agent '${agentId}' models`);
  const generate = modelSelection(value.generate, agentId, "generate");
  const session = modelSelection(value.session, agentId, "session");
  return ({
    ...(generate ? { generate } : {}),
    ...(session ? { session } : {}),
  } as const);
}

/** Validates a complete model map returned by a dynamic Agent resolver. */
export function normalizeAgentModels(
  value: unknown,
  agentId: string,
): AgentModels {
  return models(value, agentId);
}

function selection(
  value: unknown,
  agentId: string,
  capability: string,
): AgentCapabilitySelection | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new TypeError(
      `Agent '${agentId}' ${capability} capabilities must be an array of aliases.`,
    );
  }
  const aliases = value.map((entry) => {
    if (capability !== "skills") {
      return alias(entry, `Agent '${agentId}' ${capability} capability`);
    }
    const name = typeof entry === "string" ? entry.trim() : "";
    if (name !== entry || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      throw new TypeError(
        `Agent '${agentId}' skills capability must be a canonical Skill name.`,
      );
    }
    return name;
  });
  if (new Set(aliases).size !== aliases.length) {
    throw new TypeError(
      `Agent '${agentId}' contains duplicate ${capability} capability aliases.`,
    );
  }
  return aliases;
}

function capabilities(
  value: unknown,
  agentId: string,
): AgentCapabilities | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new TypeError(`Agent '${agentId}' capabilities must be an object.`);
  }
  assertKnownKeys(value, CAPABILITY_KEYS, `Agent '${agentId}' capabilities`);
  const tools = selection(value.tools, agentId, "tools");
  const agents = selection(value.agents, agentId, "agents");
  const skills = selection(value.skills, agentId, "skills");
  return ({
    ...(tools ? { tools } : {}),
    ...(agents ? { agents } : {}),
    ...(skills ? { skills } : {}),
  } as const);
}

function metadata(
  value: unknown,
  agentId: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new TypeError(`Agent '${agentId}' metadata must be an object.`);
  }
  return immutableJsonValue(value, `Agent '${agentId}' metadata`) as Readonly<
    Record<string, unknown>
  >;
}

/** Clones JSON data without invoking accessors and freezes every copied node. */
function immutableJsonValue(
  value: unknown,
  label: string,
  ancestors = new Set<object>(),
): unknown {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`${label} must contain only finite JSON numbers.`);
    }
    return value;
  }
  if (!value || typeof value !== "object") {
    throw new TypeError(`${label} must contain only JSON values.`);
  }
  if (ancestors.has(value)) {
    throw new TypeError(`${label} must not contain cycles.`);
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (
        Reflect.ownKeys(value).some((key) =>
          key !== "length" &&
          (typeof key !== "string" || !/^(0|[1-9][0-9]*)$/.test(key))
        )
      ) {
        throw new TypeError(`${label} must contain only JSON values.`);
      }
      return (Array.from({ length: value.length }, (_, index) => {
        const descriptor = Object.getOwnPropertyDescriptor(
          value,
          String(index),
        );
        if (!descriptor || !("value" in descriptor)) {
          throw new TypeError(`${label}[${index}] must be a JSON value.`);
        }
        return immutableJsonValue(
          descriptor.value,
          `${label}[${index}]`,
          ancestors,
        );
      }));
    }
    if (!isPlainRecord(value)) {
      throw new TypeError(`${label} must contain only plain JSON objects.`);
    }
    const entries: [string, unknown][] = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new TypeError(`${label} must not contain symbol keys.`);
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
        throw new TypeError(
          `${label}.${key} must be an enumerable data property.`,
        );
      }
      entries.push([
        key,
        immutableJsonValue(descriptor.value, `${label}.${key}`, ancestors),
      ]);
    }
    return (Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}

/**
 * Optionally validates and freezes an Agent Resource. An equivalent plain
 * object satisfying {@link AgentResource} is the canonical declaration form.
 */
export function defineAgent<const TResource extends AgentResource>(
  resource:
    & TResource
    & Record<Exclude<keyof TResource, keyof AgentResource>, never>,
): TResource;
export function defineAgent(
  resource: AgentResource,
): AgentResource {
  return defineAgentValue(resource);
}

function instructions(value: unknown, agentId: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`Agent '${agentId}' instructions must be text.`);
  }
  return optionalText(value, `Agent '${agentId}' instructions`);
}

function dynamicResolve(
  value: unknown,
  agentId: string,
): AgentDynamicResolver | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "function") {
    throw new TypeError(
      `Agent '${agentId}' dynamicResolve must be a function.`,
    );
  }
  return value as AgentDynamicResolver;
}

function defineAgentValue<const TResource extends AgentResource>(
  resource: TResource,
): AgentResource {
  if (!isPlainRecord(resource)) {
    throw new TypeError("Agent Resource must be an object.");
  }
  assertKnownKeys(resource, AGENT_KEYS, "Agent Resource");

  const id = requiredText(resource.id, "Agent id");
  const normalizedInstructions = instructions(resource.instructions, id);
  const normalizedDynamicResolve = dynamicResolve(resource.dynamicResolve, id);
  const normalizedCapabilities = capabilities(resource.capabilities, id);
  const normalizedMetadata = metadata(resource.metadata, id);
  const result: AgentResource = {
    id,
    name: requiredText(resource.name, `Agent '${id}' name`),
    role: requiredText(resource.role, `Agent '${id}' role`),
    ...(normalizedInstructions !== undefined
      ? { instructions: normalizedInstructions }
      : {}),
    ...(normalizedDynamicResolve !== undefined
      ? { dynamicResolve: normalizedDynamicResolve }
      : {}),
    ...(resource.personality !== undefined
      ? {
        personality: optionalText(
          resource.personality,
          `Agent '${id}' personality`,
        ),
      }
      : {}),
    ...(resource.description !== undefined
      ? {
        description: optionalText(
          resource.description,
          `Agent '${id}' description`,
        ),
      }
      : {}),
    models: models(resource.models, id),
    ...(normalizedCapabilities ? { capabilities: normalizedCapabilities } : {}),
    ...(normalizedMetadata ? { metadata: normalizedMetadata } : {}),
  } as const;
  return result;
}
