/**
 * What both maintenance Actions hold to: the collections their operations
 * reach (declared ones, never the runtime's own `sys.*`, which only SQL
 * reaches), and the fields each operation needs.
 */
import { invalid } from "../../../../runtime/mod.ts";

/** A collection maintenance may name: a declared one, not the runtime's own. */
export function own(collection: string): string {
  if (collection.startsWith("sys.")) {
    throw invalid(`"${collection}" is the runtime's own: its operations don't reach it.`);
  }
  return collection;
}

/** A field an operation needs. */
export function needs<T>(value: T | undefined, op: string, field: string): T {
  if (value === undefined) throw invalid(`${op} takes \`${field}\`.`);
  return value;
}
