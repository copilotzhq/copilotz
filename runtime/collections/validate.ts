import { addFormats, Ajv } from "../../dependencies/ajv.ts";
import { markNonRetryable } from "../failure.ts";
import { createCollectionValidationError } from "./errors.ts";

type JsonSchema = Record<string, unknown>;
type AjvValidator = ((value: unknown) => unknown) & {
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

/** This API is synchronous. Inspect metadata without invoking a getter, and
 * refuse inherited declarations rather than allowing contradictory metadata.
 * AJV rejects nested/referenced async schemas during synchronous compilation. */
function assertSynchronous(value: object): void {
  const marker = Object.getOwnPropertyDescriptor(value, "$async");
  if (
    marker ? !("value" in marker) || marker.value !== false : "$async" in value
  ) {
    throw new TypeError("Asynchronous JSON Schema validation is unsupported.");
  }
}

export function validateAgainstJsonSchema(
  schema: object,
  value: unknown,
  label: string,
): void {
  try {
    // Recheck even for a cached schema: later mutations cannot enable async work.
    assertSynchronous(schema);
    let validator = validators.get(schema);
    if (!validator) {
      validator = ajv.compile(schema as JsonSchema) as AjvValidator;
      assertSynchronous(validator);
      validators.set(schema, validator);
    }
    assertSynchronous(validator);
    const candidate = structuredClone(value);
    const valid = validator(candidate);
    if (valid === true) return;
    if (valid !== false) {
      throw new TypeError(
        "JSON Schema validator must return a synchronous boolean.",
      );
    }
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
