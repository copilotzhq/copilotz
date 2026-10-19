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
  capture: boolean,
): unknown {
  const ancestors = new Set<object>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    const scalar = policy.value(value, depth, ++nodes);
    if (scalar !== dataProperties) return scalar;
    const object = value as object;
    if (ancestors.has(object)) policy.cycle();
    const array = Array.isArray(object);
    const result = capture ? (array ? [] : {}) : undefined;
    ancestors.add(object);
    try {
      policy.properties(object, array, (key, child) => {
        const captured = visit(child, depth + 1);
        if (array && result) (result as unknown[]).push(captured);
        else if (result) {
          Object.defineProperty(result, key, {
            value: captured,
            enumerable: true,
          });
        }
      });
      return result ? Object.freeze(result) : undefined;
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
