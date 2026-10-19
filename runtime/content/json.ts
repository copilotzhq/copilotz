import { encodeJsonValue } from "../json.ts";

/** Deterministic bytes for newly authored inline JSON; existing refs are untouched. */
export function canonicalContentJson(value: unknown): string {
  return encodeJsonValue(value, {
    label: "Inline JSON content",
    maxDepth: 64,
    maxNodes: 100_000,
  });
}
