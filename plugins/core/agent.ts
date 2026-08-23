const ALIAS_PATTERN = /^[a-z][a-zA-Z0-9_]*$/;
const UNSAFE_ALIASES = new Set(["__proto__", "constructor", "prototype"]);
const AGENT_KEYS = new Set([
  "id",
  "name",
  "role",
  "instructions",
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

/** Model Resource aliases selected independently for each interaction mode. */
export type AgentModels = Readonly<{
  generate?: string;
  session?: string;
}>;

/**
 * Core's plain, declarative Agent Resource. Provider configuration and clients
 * belong to Model Resources and LLM Adapters, never to an Agent.
 */
export type AgentResource = Readonly<{
  id: string;
  name: string;
  role: string;
  instructions?: string;
  personality?: string;
  description?: string;
  models: AgentModels;
  capabilities?: AgentCapabilities;
  metadata?: Readonly<Record<string, unknown>>;
}>;

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

function models(value: unknown, agentId: string): AgentModels {
  if (!isPlainRecord(value)) {
    throw new TypeError(`Agent '${agentId}' models must be an object.`);
  }
  assertKnownKeys(value, MODEL_KEYS, `Agent '${agentId}' models`);
  return Object.freeze({
    ...(value.generate !== undefined
      ? { generate: alias(value.generate, `Agent '${agentId}' generate model`) }
      : {}),
    ...(value.session !== undefined
      ? { session: alias(value.session, `Agent '${agentId}' session model`) }
      : {}),
  });
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
  const aliases = value.map((entry) =>
    alias(entry, `Agent '${agentId}' ${capability} capability`)
  );
  if (new Set(aliases).size !== aliases.length) {
    throw new TypeError(
      `Agent '${agentId}' contains duplicate ${capability} capability aliases.`,
    );
  }
  return Object.freeze(aliases);
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
  return Object.freeze({
    ...(tools ? { tools } : {}),
    ...(agents ? { agents } : {}),
    ...(skills ? { skills } : {}),
  });
}

function metadata(
  value: unknown,
  agentId: string,
): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainRecord(value)) {
    throw new TypeError(`Agent '${agentId}' metadata must be an object.`);
  }
  return Object.freeze({ ...value });
}

/**
 * Optionally validates and freezes an Agent Resource. An equivalent plain
 * object satisfying {@link AgentResource} is the canonical declaration form.
 */
export function defineAgent<const TResource extends AgentResource>(
  resource:
    & TResource
    & Record<Exclude<keyof TResource, keyof AgentResource>, never>,
): TResource {
  if (!isPlainRecord(resource)) {
    throw new TypeError("Agent Resource must be an object.");
  }
  assertKnownKeys(resource, AGENT_KEYS, "Agent Resource");

  const id = requiredText(resource.id, "Agent id");
  const normalizedCapabilities = capabilities(resource.capabilities, id);
  const normalizedMetadata = metadata(resource.metadata, id);
  const result: AgentResource = Object.freeze({
    id,
    name: requiredText(resource.name, `Agent '${id}' name`),
    role: requiredText(resource.role, `Agent '${id}' role`),
    ...(resource.instructions !== undefined
      ? {
        instructions: optionalText(
          resource.instructions,
          `Agent '${id}' instructions`,
        ),
      }
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
  });
  return result as TResource;
}
