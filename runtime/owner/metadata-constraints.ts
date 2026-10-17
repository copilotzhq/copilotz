/** Private wire encoding of current ServerConstraints.operations.metadata.
 * Undefined is an explicit absent-key requirement, never omitted or null.
 * This codec carries restrictions; only current owner policy grants authority. */
import { assertJsonValue } from "../json.ts";
import type { OwnerJson } from "./boundary.ts";

export type OwnerMetadataConstraints = Readonly<{
  values: Readonly<Record<string, OwnerJson>>;
  absentKeys: readonly string[];
}>;
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Metadata constraints must be an object.");
  }
}
function bounded(value: unknown): void {
  assertJsonValue(value, {
    maxDepth: 32,
    maxNodes: 10_000,
    rejectNegativeZero: true,
  });
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024) {
    throw new RangeError("Metadata constraints exceed their byte limit.");
  }
}
function ordered(value: OwnerJson): OwnerJson {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((
        key,
      ) => [key, ordered((value as Record<string, OwnerJson>)[key])]),
    );
  }
  return value;
}
export function encodeOwnerMetadataConstraints(
  metadata: Readonly<Record<string, unknown>>,
): OwnerMetadataConstraints {
  object(metadata);
  // Validate descriptors before reading any value; nested undefined is invalid.
  assertJsonValue(metadata, {
    omitUndefinedProperties: true,
    maxDepth: 32,
    maxNodes: 10_000,
    rejectNegativeZero: true,
  });
  const absentKeys: string[] = [];
  const entries: [string, OwnerJson][] = [];
  for (const key of Object.keys(metadata).sort()) {
    const value = metadata[key];
    if (value === undefined) absentKeys.push(key);
    else {
      bounded(value);
      entries.push([key, ordered(value as OwnerJson)]);
    }
  }
  const result = { values: Object.fromEntries(entries), absentKeys };
  bounded(result);
  return result;
}
export function decodeOwnerMetadataConstraints(
  input: unknown,
): OwnerMetadataConstraints {
  bounded(input);
  object(input);
  if (
    Object.keys(input).length !== 2 || !Object.hasOwn(input, "values") ||
    !Object.hasOwn(input, "absentKeys")
  ) {
    throw new TypeError(
      "Metadata constraint encoding requires values and absentKeys.",
    );
  }
  object(input.values);
  if (
    !Array.isArray(input.absentKeys) ||
    input.absentKeys.some((key) => typeof key !== "string") ||
    new Set(input.absentKeys).size !== input.absentKeys.length ||
    input.absentKeys.some((key) => Object.hasOwn(input.values as object, key))
  ) {
    throw new TypeError(
      "Metadata absent-key restrictions are invalid or contradictory.",
    );
  }
  return {
    values: ordered(input.values as Record<string, OwnerJson>) as Record<
      string,
      OwnerJson
    >,
    absentKeys: [...input.absentKeys].sort(),
  };
}
export function matchesOwnerMetadataConstraints(
  encoded: OwnerMetadataConstraints,
  candidate: unknown,
): boolean {
  const constraints = decodeOwnerMetadataConstraints(encoded);
  try {
    bounded(candidate);
    object(candidate);
  } catch {
    return false;
  }
  return constraints.absentKeys.every((key) =>
    !Object.hasOwn(candidate, key)
  ) &&
    Object.entries(constraints.values).every(([key, value]) =>
      Object.hasOwn(candidate, key) &&
      JSON.stringify(ordered(candidate[key] as OwnerJson)) ===
        JSON.stringify(value)
    );
}
