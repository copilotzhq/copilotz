/** A boundary returns this only after deciding that a value needs traversal. */
export const dataProperties = Symbol("data properties");

type DataOnlyPolicy = {
  value(value: unknown, depth: number, nodes: number): unknown;
  cycle(): never;
  properties(
    value: object,
    array: boolean,
    visit: (key: string, value: unknown) => void,
  ): void;
};

/**
 * Shared graph traversal and optional immutable copying. Boundaries own scalar,
 * prototype, descriptor and budget policies; only their data values descend.
 * Validation does not allocate a second object graph.
 */
export function walkDataOnly(
  value: unknown,
  policy: DataOnlyPolicy,
  capture: boolean | "json",
): unknown {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    const scalar = policy.value(value, depth, ++nodes);
    if (scalar !== dataProperties) {
      return capture === "json" ? JSON.stringify(scalar) : scalar;
    }
    const object = value as object;
    if (ancestors.has(object)) policy.cycle();
    const array = Array.isArray(object);
    const result = capture
      ? (array || capture === "json" ? [] : {})
      : undefined;
    ancestors.add(object);
    try {
      policy.properties(object, array, (key, child) => {
        const captured = visit(child, depth + 1);
        if (capture === "json") {
          (result as string[]).push(
            array ? captured as string : `${JSON.stringify(key)}:${captured}`,
          );
        } else if (array && result) (result as unknown[]).push(captured);
        else if (result) {
          Object.defineProperty(result, key, {
            value: captured,
            enumerable: true,
          });
        }
      });
      return capture === "json"
        ? `${array ? "[" : "{"}${(result as string[]).join(",")}${
          array ? "]" : "}"
        }`
        : result
        ? Object.freeze(result)
        : undefined;
    } finally {
      ancestors.delete(object);
    }
  };
  return visit(value, 0);
}

/** Charge escaped UTF-8, including quotes, without serialization or allocation. */
export function chargeJsonString(
  value: string,
  remaining: number,
  charge: (bytes: number) => void,
): string {
  // Every UTF-16 code unit needs at least one byte; reject huge inputs early.
  if (value.length > remaining) charge(value.length);
  charge(2);
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92) charge(2);
    else if (code < 32) charge([8, 9, 10, 12, 13].includes(code) ? 2 : 6);
    else if (code < 128) charge(1);
    else if (code < 2048) charge(2);
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        charge(4);
        index++;
      } else charge(6);
    } else if (code >= 0xdc00 && code <= 0xdfff) charge(6);
    else charge(3);
  }
  return value;
}

/** Ordering policies preserve the bytes of existing receipt and digest formats. */
type JsonOrder = "code-unit" | "locale";
type CanonicalOptions = {
  order?: JsonOrder;
  /** Object reconstruction follows JSON.stringify's integer-key ordering. */
  objectOrder?: boolean;
  undefinedValue?: "null" | "undefined";
  transform?: (value: unknown) => unknown;
};

function orderedValue(
  input: unknown,
  options: CanonicalOptions,
  text: boolean,
): unknown {
  const value = options.transform ? options.transform(input) : input;
  if (!value || typeof value !== "object") {
    const type = typeof value;
    if (type === "function" || type === "symbol" || type === "bigint") {
      throw new TypeError("JSON requires data values.");
    }
    const normalized = Object.is(value, -0) ? 0 : value;
    return text
      ? JSON.stringify(normalized) ?? options.undefinedValue
      : normalized;
  }
  if (Array.isArray(value)) {
    const items = Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor) return undefined;
      if (!("value" in descriptor)) {
        throw new TypeError("JSON requires data properties.");
      }
      return orderedValue(descriptor.value, options, text);
    });
    return text ? `[${items.join(",")}]` : items;
  }
  const keys = Object.keys(value).sort(
    options.order === "locale" ? (a, b) => a.localeCompare(b) : undefined,
  );
  const entries = keys.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!("value" in descriptor)) {
      throw new TypeError("JSON requires data properties.");
    }
    const child = orderedValue(descriptor.value, options, text);
    return text ? `${JSON.stringify(key)}:${child}` : [key, child] as const;
  });
  return text
    ? `{${entries.join(",")}}`
    : Object.fromEntries(entries as Array<readonly [string, unknown]>);
}

/** Shared textual encoding; callers retain their boundary validation policy. */
export function canonicalJson(
  value: unknown,
  options: CanonicalOptions = {},
): string {
  return options.objectOrder
    ? JSON.stringify(orderedValue(value, options, false))
    : orderedValue(value, options, true) as string;
}

/** Detached ordered JSON for boundaries that retain a value instead of text. */
export function orderedJson(
  value: unknown,
  order: JsonOrder = "code-unit",
): unknown {
  return orderedValue(value, { order }, false);
}
