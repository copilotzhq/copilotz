import { addFormats, Ajv } from "../../dependencies/ajv.ts";

type JsonSchema = Record<string, unknown>;
type AjvValidator = ((value: unknown) => boolean) & {
  errors?: readonly unknown[] | null;
};

const validators = new WeakMap<object, AjvValidator>();

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
  let validator = validators.get(schema);
  if (!validator) {
    validator = ajv.compile(schema as JsonSchema) as AjvValidator;
    validators.set(schema, validator);
  }
  const candidate = structuredClone(value);
  if (validator(candidate)) return;
  const details = ajv.errorsText(validator.errors ?? [], { separator: "; " });
  throw new TypeError(`${label} failed schema validation: ${details}`);
}

export function validateCollectionRecord(
  schema: object,
  record: Readonly<Record<string, unknown>>,
  label: string,
): void {
  validateAgainstJsonSchema(schema, record, label);
}
