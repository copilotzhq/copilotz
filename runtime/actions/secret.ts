import type { ActionSchema } from "./types.ts";

const SECRET_MARKER = "x-copilotz-secret";
const REDACTED_SECRET_VALUE = Object.freeze({ "$copilotz-secret": true });

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type SplitSecretActionValue = Readonly<{
  publicValue: JsonValue;
  secret: boolean;
}>;

export type SecretActionSchema<TSchema extends ActionSchema = ActionSchema> =
  & TSchema
  & Readonly<{ "x-copilotz-secret": true }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalidSchema(message: string): never {
  throw new TypeError(`Action secret schema is invalid: ${message}.`);
}

function invalidValue(message: string): never {
  throw new TypeError(`Action secret value is invalid: ${message}.`);
}

function jsonPointerSegment(value: string): string {
  return value.replace(/~/g, "~0").replace(/\//g, "~1");
}

function appendPointer(pointer: string, segment: string): string {
  return `${pointer}/${jsonPointerSegment(segment)}`;
}

function decodePointerSegment(value: string): string {
  if (/~(?:[^01]|$)/.test(value)) {
    invalidSchema("a $ref has an invalid JSON Pointer escape");
  }
  return value.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalRef(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) {
    invalidSchema(`$ref '${ref}' is not a local JSON Pointer`);
  }

  let current: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = decodePointerSegment(rawSegment);
    if (
      !current || typeof current !== "object" ||
      !Object.prototype.hasOwnProperty.call(current, segment)
    ) {
      invalidSchema(`$ref '${ref}' cannot be resolved`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function schemaNode(
  value: unknown,
  name: string,
): boolean | Record<string, unknown> {
  if (typeof value === "boolean") return value;
  if (!isRecord(value)) {
    invalidSchema(`${name} must be a JSON Schema object or boolean`);
  }
  return value;
}

function schemaMap(value: unknown, name: string): Record<string, unknown> {
  if (!isRecord(value)) invalidSchema(`${name} must be an object`);
  return value;
}

function schemaList(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) invalidSchema(`${name} must be an array`);
  return value;
}

function schemaKeyword(
  node: Record<string, unknown>,
  name: string,
): unknown | undefined {
  return Object.prototype.hasOwnProperty.call(node, name)
    ? node[name]
    : undefined;
}

function visitSchemaChildren(
  node: Record<string, unknown>,
  root: Record<string, unknown>,
  refs: ReadonlySet<string>,
  visit: (
    child: boolean | Record<string, unknown>,
    refs: ReadonlySet<string>,
  ) => void,
): void {
  const ref = schemaKeyword(node, "$ref");
  if (ref !== undefined) {
    if (typeof ref !== "string") invalidSchema("$ref must be a string");
    if (refs.has(ref)) invalidSchema(`$ref '${ref}' is cyclic`);
    visit(
      schemaNode(resolveLocalRef(root, ref), `$ref '${ref}'`),
      new Set([...refs, ref]),
    );
  }

  for (
    const name of [
      "additionalProperties",
      "unevaluatedProperties",
      "contains",
      "propertyNames",
      "not",
      "if",
      "then",
      "else",
    ]
  ) {
    const child = schemaKeyword(node, name);
    if (child !== undefined) visit(schemaNode(child, name), refs);
  }

  for (
    const name of [
      "properties",
      "patternProperties",
      "dependentSchemas",
      "$defs",
      "definitions",
    ]
  ) {
    const children = schemaKeyword(node, name);
    if (children === undefined) continue;
    for (const [key, child] of Object.entries(schemaMap(children, name))) {
      visit(schemaNode(child, `${name}.${key}`), refs);
    }
  }

  for (const name of ["items", "prefixItems", "allOf", "anyOf", "oneOf"]) {
    const children = schemaKeyword(node, name);
    if (children === undefined) continue;
    if (Array.isArray(children)) {
      for (const child of schemaList(children, name)) {
        visit(schemaNode(child, name), refs);
      }
    } else {
      visit(schemaNode(children, name), refs);
    }
  }
}

/** Validates the JSON Schema features used by the secret traversal. */
export function validateSecretActionSchema(schema: ActionSchema): void {
  const root = schemaNode(schema, "root");
  if (typeof root === "boolean") {
    invalidSchema("root must be a JSON Schema object");
  }
  const objects = new WeakSet<object>();
  const visit = (
    node: boolean | Record<string, unknown>,
    refs: ReadonlySet<string>,
  ): void => {
    if (typeof node === "boolean") return;
    if (objects.has(node)) invalidSchema("schema object graph is cyclic");
    objects.add(node);
    try {
      visitSchemaChildren(node, root, refs, visit);
    } finally {
      objects.delete(node);
    }
  };
  visit(root, new Set());
}

/** Whether a schema contains a true `x-copilotz-secret` marker. */
export function actionSchemaHasSecrets(
  schema: ActionSchema | undefined,
): boolean {
  if (!schema) return false;
  const root = schemaNode(schema, "root");
  if (typeof root === "boolean") {
    invalidSchema("root must be a JSON Schema object");
  }
  let hasSecrets = false;
  const objects = new WeakSet<object>();
  const visit = (
    node: boolean | Record<string, unknown>,
    refs: ReadonlySet<string>,
  ): void => {
    if (typeof node === "boolean") return;
    if (objects.has(node)) invalidSchema("schema object graph is cyclic");
    objects.add(node);
    try {
      hasSecrets ||= hasSecretMarker(node);
      visitSchemaChildren(node, root, refs, visit);
    } finally {
      objects.delete(node);
    }
  };
  visit(root, new Set());
  return hasSecrets;
}

function cloneJsonValue(
  value: unknown,
  path: string,
  ancestors = new WeakSet<object>(),
): JsonValue {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidValue(`${path} is not finite`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (!value || typeof value !== "object") invalidValue(`${path} is not JSON`);
  if (ancestors.has(value)) invalidValue(`${path} is cyclic`);
  if (Object.getOwnPropertySymbols(value).length > 0) {
    invalidValue(`${path} has symbol properties`);
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) {
        invalidValue(`${path} is a sparse array`);
      }
      return Object.freeze(
        value.map((item, index) =>
          cloneJsonValue(item, `${path}[${index}]`, ancestors)
        ),
      );
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalidValue(`${path} is not a plain object`);
    }
    const names = Object.getOwnPropertyNames(value);
    const entries = names.map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !("value" in descriptor)) {
        invalidValue(`${path}.${key} is not an enumerable data property`);
      }
      return [
        key,
        cloneJsonValue(descriptor.value, `${path}.${key}`, ancestors),
      ] as const;
    });
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    ancestors.delete(value);
  }
}

/** Captures an immutable exact JSON Schema snapshot used by one Action. */
export function snapshotActionSchema(schema: ActionSchema): ActionSchema {
  validateSecretActionSchema(schema);
  return cloneJsonValue(schema, "schema") as ActionSchema;
}

/** Marks one JSON Schema root as a durable Action secret. */
export function secret<const TSchema extends ActionSchema>(
  schema: TSchema,
): SecretActionSchema<TSchema> {
  if (!isRecord(schema)) invalidSchema("root must be a JSON Schema object");
  return snapshotActionSchema({
    ...schema,
    [SECRET_MARKER]: true,
  }) as SecretActionSchema<TSchema>;
}

function hasSecretMarker(node: Record<string, unknown>): boolean {
  return node[SECRET_MARKER] === true;
}

function addSecretPointers(
  schema: boolean | Record<string, unknown>,
  value: JsonValue,
  pointer: string,
  root: Record<string, unknown>,
  refs: ReadonlySet<string>,
  pointers: Set<string>,
): void {
  if (typeof schema === "boolean") return;
  if (hasSecretMarker(schema)) {
    pointers.add(pointer);
    return;
  }

  const visit = (
    child: boolean | Record<string, unknown>,
    nextValue: JsonValue,
    nextPointer: string,
    nextRefs: ReadonlySet<string>,
  ) =>
    addSecretPointers(child, nextValue, nextPointer, root, nextRefs, pointers);

  const ref = schemaKeyword(schema, "$ref");
  if (ref !== undefined) {
    if (typeof ref !== "string") invalidSchema("$ref must be a string");
    if (refs.has(ref)) invalidSchema(`$ref '${ref}' is cyclic`);
    visit(
      schemaNode(resolveLocalRef(root, ref), `$ref '${ref}'`),
      value,
      pointer,
      new Set([...refs, ref]),
    );
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Readonly<Record<string, JsonValue>>;
    const properties = schemaKeyword(schema, "properties");
    if (properties !== undefined) {
      for (
        const [key, child] of Object.entries(
          schemaMap(properties, "properties"),
        )
      ) {
        if (Object.prototype.hasOwnProperty.call(record, key)) {
          visit(
            schemaNode(child, `properties.${key}`),
            record[key],
            appendPointer(pointer, key),
            refs,
          );
        }
      }
    }
    const patterns = schemaKeyword(schema, "patternProperties");
    if (patterns !== undefined) {
      for (
        const [pattern, child] of Object.entries(
          schemaMap(patterns, "patternProperties"),
        )
      ) {
        let expression: RegExp;
        try {
          expression = new RegExp(pattern);
        } catch {
          invalidSchema(
            `patternProperties.${pattern} is not a valid regular expression`,
          );
        }
        for (const [key, childValue] of Object.entries(record)) {
          if (expression.test(key)) {
            visit(
              schemaNode(child, `patternProperties.${pattern}`),
              childValue,
              appendPointer(pointer, key),
              refs,
            );
          }
        }
      }
    }
    const additional = schemaKeyword(schema, "additionalProperties");
    if (additional !== undefined && isRecord(additional)) {
      const known = new Set(
        properties === undefined
          ? []
          : Object.keys(schemaMap(properties, "properties")),
      );
      for (const [key, childValue] of Object.entries(record)) {
        if (!known.has(key)) {
          visit(
            schemaNode(additional, "additionalProperties"),
            childValue,
            appendPointer(pointer, key),
            refs,
          );
        }
      }
    }
  }

  if (Array.isArray(value)) {
    const prefixItems = schemaKeyword(schema, "prefixItems");
    const tupleItems = schemaKeyword(schema, "items");
    const prefix = prefixItems === undefined
      ? (Array.isArray(tupleItems) ? tupleItems : [])
      : schemaList(prefixItems, "prefixItems");
    for (
      let index = 0;
      index < Math.min(value.length, prefix.length);
      index++
    ) {
      visit(
        schemaNode(prefix[index], "items"),
        value[index],
        appendPointer(pointer, String(index)),
        refs,
      );
    }
    const items = prefixItems === undefined && Array.isArray(tupleItems)
      ? undefined
      : tupleItems;
    if (items !== undefined && !Array.isArray(items)) {
      const itemSchema = schemaNode(items, "items");
      for (let index = prefix.length; index < value.length; index++) {
        visit(
          itemSchema,
          value[index],
          appendPointer(pointer, String(index)),
          refs,
        );
      }
    }
  }

  for (const name of ["allOf", "anyOf", "oneOf"]) {
    const choices = schemaKeyword(schema, name);
    if (choices === undefined) continue;
    for (const child of schemaList(choices, name)) {
      visit(schemaNode(child, name), value, pointer, refs);
    }
  }
}

function normalizedPointers(pointers: Iterable<string>): readonly string[] {
  return [...new Set(pointers)].sort((left, right) => {
    const depth = (value: string) =>
      value === "" ? 0 : value.split("/").length - 1;
    return depth(left) - depth(right) || left.localeCompare(right);
  }).filter((pointer, index, values) =>
    !values.slice(0, index).some((ancestor) =>
      ancestor === "" || pointer.startsWith(`${ancestor}/`)
    )
  );
}

function secretPointers(
  schema: ActionSchema,
  value: JsonValue,
): readonly string[] {
  validateSecretActionSchema(schema);
  const root = schemaNode(schema, "root");
  if (typeof root === "boolean") {
    invalidSchema("root must be a JSON Schema object");
  }
  const pointers = new Set<string>();
  addSecretPointers(root, value, "", root, new Set(), pointers);
  return normalizedPointers(pointers);
}

function replacePointers(
  value: JsonValue,
  pointers: ReadonlySet<string>,
  pointer = "",
): JsonValue {
  if (pointers.has(pointer)) return REDACTED_SECRET_VALUE;
  if (Array.isArray(value)) {
    return Object.freeze(
      value.map((child, index) =>
        replacePointers(child, pointers, appendPointer(pointer, String(index)))
      ),
    );
  }
  if (value && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) =>
        [
          key,
          replacePointers(child, pointers, appendPointer(pointer, key)),
        ] as const
      ),
    ));
  }
  return value;
}

/** Splits schema-marked secret roots from a JSON Action value. */
export function splitSecretActionValue(
  schema: ActionSchema | undefined,
  value: unknown,
): SplitSecretActionValue {
  const snapshot = cloneJsonValue(value, "value");
  if (!schema) return Object.freeze({ publicValue: snapshot, secret: false });
  const pointers = secretPointers(schema, snapshot);
  return Object.freeze({
    publicValue: replacePointers(snapshot, new Set(pointers)),
    secret: pointers.length > 0,
  });
}

function sameJsonValue(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (
    typeof left !== "object" || left === null ||
    typeof right !== "object" || right === null
  ) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]));
  }
  const leftObject = left as JsonObject;
  const rightObject = right as JsonObject;
  const leftKeys = Object.keys(leftObject).sort();
  const rightKeys = Object.keys(rightObject).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) =>
      key === rightKeys[index] &&
      sameJsonValue(leftObject[key], rightObject[key])
    );
}

/**
 * Restores sealed plaintext only when its schema-redacted projection exactly
 * equals the durable public value.
 */
export function rehydrateSecretActionValue(
  schema: ActionSchema | undefined,
  publicValue: unknown,
  plaintext: unknown,
): JsonValue {
  const publicSnapshot = cloneJsonValue(publicValue, "public value");
  const plaintextSnapshot = cloneJsonValue(plaintext, "plaintext");
  const projected =
    splitSecretActionValue(schema, plaintextSnapshot).publicValue;
  if (!sameJsonValue(projected, publicSnapshot)) {
    invalidValue("sealed plaintext does not match the durable public value");
  }
  return plaintextSnapshot;
}
