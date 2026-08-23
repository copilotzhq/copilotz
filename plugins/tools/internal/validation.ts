import type { Tool } from "./types.ts";

import { addFormats, Ajv } from "../../../dependencies/ajv.ts";

export type ToolValidationResult = Readonly<{
  valid: boolean;
  error?: string;
}>;

export type ToolCallValidation = Readonly<{
  name: string;
  arguments: unknown;
}>;

type JsonSchema = Record<string, unknown>;
type ValidationError = Readonly<{
  keyword?: string;
  instancePath?: string;
  schemaPath?: string;
  message?: string;
}>;

type AjvValidator = ((value: unknown) => boolean) & {
  errors?: readonly ValidationError[] | null;
};

type AjvLike = Readonly<{
  compile(schema: unknown): AjvValidator;
  errorsText(errors?: readonly ValidationError[] | null): string;
  addKeyword(keyword: string): void;
}>;

function createAjv(): AjvLike {
  // npm's CommonJS declaration shape differs across supported runtimes.
  // deno-lint-ignore no-explicit-any
  const instance = new (Ajv as any)({ strict: false, allErrors: true });
  // deno-lint-ignore no-explicit-any
  (addFormats as any)(instance);
  instance.addKeyword("x-ui");
  return instance as AjvLike;
}

const ajv = createAjv();

function schemaRecord(value: unknown): JsonSchema | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonSchema
    : null;
}

function schemaBranches(value: unknown): readonly JsonSchema[] {
  return Array.isArray(value)
    ? value.map(schemaRecord).filter((item): item is JsonSchema =>
      item !== null
    )
    : [];
}

function schemaProperties(schema: JsonSchema): JsonSchema {
  return schemaRecord(schema.properties) ?? {};
}

/**
 * Produces an actionable diagnostic for the common discriminated-oneOf tool
 * schema shape. Generic Ajv diagnostics remain the fallback for every other
 * schema.
 */
export function formatDiscriminatedOneOfError(
  schemaValue: unknown,
  argsValue: unknown,
  toolName = "tool",
  errors?: readonly ValidationError[] | null,
): string | null {
  const schema = schemaRecord(schemaValue);
  const args = schemaRecord(argsValue) ?? {};
  if (!schema) return null;
  const branches = schemaBranches(schema.oneOf);
  if (branches.length < 2) return null;

  const firstProperties = schemaProperties(branches[0]);
  const candidates = Object.keys(firstProperties).filter((key) => {
    const property = schemaRecord(firstProperties[key]);
    return typeof property?.const === "string";
  });

  for (const discriminator of candidates) {
    const byValue = new Map<string, { branch: JsonSchema; index: number }>();
    for (const [index, branch] of branches.entries()) {
      const property = schemaRecord(schemaProperties(branch)[discriminator]);
      if (typeof property?.const !== "string") {
        byValue.clear();
        break;
      }
      byValue.set(property.const, { branch, index });
    }
    if (byValue.size < 2) continue;

    const allowed = [...byValue.keys()];
    const selectedValue = args[discriminator];
    if (selectedValue === undefined || selectedValue === null) {
      return `Missing required field '${discriminator}'. Allowed ${discriminator}s: ${
        allowed.join(", ")
      }`;
    }
    if (typeof selectedValue !== "string" || !byValue.has(selectedValue)) {
      return `Unknown ${discriminator} '${
        String(selectedValue)
      }'. Allowed ${discriminator}s: ${allowed.join(", ")}`;
    }

    const selected = byValue.get(selectedValue)!;
    const branchErrors = (errors ?? []).filter((error) =>
      error.schemaPath?.includes(`/oneOf/${selected.index}/`)
    );
    const nested = formatDiscriminatedOneOfError(
      selected.branch,
      args,
      toolName,
      branchErrors,
    );
    if (nested) return nested;

    const properties = schemaProperties(selected.branch);
    const required = Array.isArray(selected.branch.required)
      ? selected.branch.required.filter((value): value is string =>
        typeof value === "string"
      )
      : [];
    const allowedFields = new Set(Object.keys(properties));
    for (const nestedBranch of schemaBranches(selected.branch.oneOf)) {
      for (const key of Object.keys(schemaProperties(nestedBranch))) {
        allowedFields.add(key);
      }
    }
    const missing = required.filter((field) => !(field in args));
    const unexpected = Object.keys(args).filter((field) =>
      !allowedFields.has(field)
    );
    const constraintKeywords = new Set([
      "maximum",
      "minimum",
      "maxLength",
      "minLength",
      "pattern",
      "enum",
      "const",
      "type",
      "format",
      "exclusiveMaximum",
      "exclusiveMinimum",
    ]);
    const constraints = branchErrors.flatMap((error) => {
      if (!error.keyword || !constraintKeywords.has(error.keyword)) return [];
      const path = error.instancePath?.replace(/^\//, "") ?? "value";
      return [`Constraint: ${path} ${error.message ?? "is invalid"}`];
    });
    if (!missing.length && !unexpected.length && !constraints.length) {
      return null;
    }
    let message =
      `Invalid arguments for ${toolName} ${discriminator} '${selectedValue}'.`;
    if (required.length) message += ` Required: ${required.join(", ")}.`;
    if (allowedFields.size) {
      message += ` Allowed: ${[...allowedFields].join(", ")}.`;
    }
    if (unexpected.length) {
      message += ` Unexpected: ${unexpected.join(", ")}.`;
    }
    if (constraints.length) message += ` ${constraints.join(". ")}.`;
    return message;
  }
  return null;
}

/** Validates one parsed tool argument value against the tool's JSON schema. */
export function validateToolCall(
  toolCall: ToolCallValidation,
  tool: Pick<Tool, "inputSchema">,
): ToolValidationResult {
  const inputSchema = tool.inputSchema;
  if (!inputSchema) return Object.freeze({ valid: true });
  const args = toolCall.arguments ?? {};
  const properties = schemaRecord(inputSchema.properties);
  const required = Array.isArray(inputSchema.required)
    ? inputSchema.required
    : [];
  const combinators = ["oneOf", "anyOf", "allOf", "if", "then", "else", "not"];
  if (
    inputSchema.type === "object" &&
    (!properties || Object.keys(properties).length === 0) &&
    required.length === 0 &&
    !combinators.some((key) => key in inputSchema)
  ) {
    return Object.freeze({ valid: true });
  }
  try {
    const validate = ajv.compile(inputSchema);
    if (validate(args)) return Object.freeze({ valid: true });
    return Object.freeze({
      valid: false,
      error: formatDiscriminatedOneOfError(
        inputSchema,
        args,
        toolCall.name,
        validate.errors,
      ) ?? ajv.errorsText(validate.errors),
    });
  } catch (error) {
    return Object.freeze({
      valid: false,
      error: `Schema validation error: ${
        error instanceof Error ? error.message : "Unknown error"
      }`,
    });
  }
}
