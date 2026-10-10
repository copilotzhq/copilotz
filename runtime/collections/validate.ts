import { addFormats, Ajv } from "../../dependencies/ajv.ts";
import { markNonRetryable } from "../failure.ts";
import { createCollectionValidationError } from "./errors.ts";

type JsonSchema = Record<string, unknown>;
type AjvValidator = ((value: unknown) => boolean) & {
  errors?: readonly unknown[] | null;
};

const validators = new WeakMap<object, AjvValidator>();
const jsonSchemaValidationErrors = new WeakSet<object>();

/** True only when a value failed an otherwise valid JSON Schema. */
export function isJsonSchemaValidationError(
  error: unknown,
): error is TypeError {
  return error instanceof TypeError && jsonSchemaValidationErrors.has(error);
}

function createAjv() {
  // deno-lint-ignore no-explicit-any
  const instance = new (Ajv as any)({
    strict: false,
    allErrors: true,
    useDefaults: false,
  });
  // deno-lint-ignore no-explicit-any
  (addFormats as any)(instance);
  return instance;
}

const ajv = createAjv();

export function validateAgainstJsonSchema(
  schema: object,
  value: unknown,
  label: string,
): void {
  try {
    let validator = validators.get(schema);
    if (!validator) {
      validator = ajv.compile(schema as JsonSchema) as AjvValidator;
      validators.set(schema, validator);
    }
    const candidate = structuredClone(value);
    if (validator(candidate)) return;
    const details = ajv.errorsText(validator.errors ?? [], { separator: "; " });
    const error = new TypeError(
      `${label} failed schema validation: ${details}`,
    );
    jsonSchemaValidationErrors.add(error);
    throw error;
  } catch (error) {
    if (error instanceof Error) throw markNonRetryable(error);
    throw markNonRetryable(new Error(String(error)));
  }
}

export function validateCollectionRecord(
  schema: object,
  record: Readonly<Record<string, unknown>>,
  label: string,
): void {
  validateCollectionInput(schema, record, label);
}

/** Classifies value validation only; invalid schemas remain internal failures. */
export function validateCollectionInput(
  schema: object,
  value: unknown,
  label: string,
): void {
  try {
    validateAgainstJsonSchema(schema, value, label);
  } catch (error) {
    if (isJsonSchemaValidationError(error)) {
      throw createCollectionValidationError(error.message);
    }
    throw error;
  }
}
