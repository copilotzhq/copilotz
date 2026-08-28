/** Defines trusted, static prompt-instruction Resources. @module */

const RESOURCE_KEYS = new Set(["id", "type", "instructions"]);

/**
 * Immutable, process-local instruction policy contributed by an application or
 * plugin. Unlike a Context Resource, this text is trusted application policy.
 * It is static data: host-specific file loading belongs to application code.
 */
export type PromptInstructionResource = Readonly<{
  id: string;
  type: "prompt_instruction";
  instructions: string;
}>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownDataValue(
  value: Readonly<Record<string, unknown>>,
  key: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && descriptor.enumerable && "value" in descriptor
    ? descriptor.value
    : undefined;
}

function requiredIdentifier(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new TypeError("Prompt instruction resource id is required.");
  }
  if (normalized !== value) {
    throw new TypeError(
      "Prompt instruction resource id must not contain surrounding whitespace.",
    );
  }
  return normalized;
}

function requiredInstructions(value: unknown): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) {
    throw new TypeError(
      "Prompt instruction resource instructions are required.",
    );
  }
  return normalized;
}

function assertExactResource(
  value: unknown,
): asserts value is Readonly<Record<string, unknown>> {
  if (!isPlainRecord(value)) {
    throw new TypeError("Prompt instruction resource must be a plain object.");
  }
  const unknown = Reflect.ownKeys(value).find((key) =>
    typeof key !== "string" || !RESOURCE_KEYS.has(key)
  );
  if (unknown !== undefined) {
    throw new TypeError(
      `Prompt instruction resource cannot declare '${String(unknown)}'.`,
    );
  }
  for (const key of RESOURCE_KEYS) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError(
        `Prompt instruction resource '${key}' must be an enumerable data property.`,
      );
    }
  }
}

/** Validates and freezes one trusted, static prompt-instruction Resource. */
export function definePromptInstructionResource(
  resource: PromptInstructionResource,
): PromptInstructionResource {
  assertExactResource(resource);
  const id = requiredIdentifier(ownDataValue(resource, "id"));
  if (ownDataValue(resource, "type") !== "prompt_instruction") {
    throw new TypeError(
      `Prompt instruction resource '${id}' must have type 'prompt_instruction'.`,
    );
  }
  return Object.freeze({
    id,
    type: "prompt_instruction" as const,
    instructions: requiredInstructions(ownDataValue(resource, "instructions")),
  });
}

/** Returns whether a value is a valid-shaped trusted prompt instruction. */
export function isPromptInstructionResource(
  value: unknown,
): value is PromptInstructionResource {
  if (!isPlainRecord(value)) return false;
  if (
    Reflect.ownKeys(value).some((key) =>
      typeof key !== "string" || !RESOURCE_KEYS.has(key)
    )
  ) return false;
  const id = ownDataValue(value, "id");
  const instructions = ownDataValue(value, "instructions");
  return [...RESOURCE_KEYS].every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return Boolean(descriptor?.enumerable && "value" in (descriptor ?? {}));
  }) && typeof id === "string" && id.trim() === id && Boolean(id) &&
    ownDataValue(value, "type") === "prompt_instruction" &&
    typeof instructions === "string" && instructions.trim() === instructions &&
    Boolean(instructions);
}
