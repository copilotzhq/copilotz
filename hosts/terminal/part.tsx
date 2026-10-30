/**
 * A part in Ink: what its View shows now, drawn again when that changes and
 * only then. A failed part says why, in place; its parent still shows.
 */
import { Text } from "ink";
import { type ReactNode, useSyncExternalStore } from "react";
import type { Observed } from "../../runtime/mod.ts";

export function Part({ part }: { part: Observed }): ReactNode {
  const out = useSyncExternalStore(part.subscribe, part.get);
  if (out.status === "loading") return null;
  if (out.status === "failed") return <Text color="red">✗ {message(out.error)}</Text>;
  return node(out.value);
}

/** What a View returned, as Ink draws it: text goes in `<Text>`. */
export const node = (value: unknown): ReactNode =>
  value === undefined || value === null || value === false
    ? null
    : typeof value === "string" || typeof value === "number"
    ? <Text>{value}</Text>
    : Array.isArray(value)
    ? value.map(node)
    : value as ReactNode;

export const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
