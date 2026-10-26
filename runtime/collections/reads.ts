import type { ReadCollections } from "./kernel.ts";
import type { RuntimeContext } from "../actions/types.ts";
export type ReadResult<T> = Readonly<
  { value: T; asOf: Readonly<{ epoch: number; lastSeq: number }> }
>;
export type ReadOptions = import("../persistence/read-limiter.ts").ReadOptions;
export type ReadContext =
  & Pick<
    RuntimeContext,
    | "namespace"
    | "databaseSchema"
    | "resources"
    | "signal"
    | "now"
    | "operationKey"
    | "read"
    | "identity"
  >
  & { readonly collections: ReadCollections };
export type RegisteredRead<A, T> = Readonly<
  {
    kind: "registered-read";
    execute(args: A, context: ReadContext): T | Promise<T>;
  }
>;
/** Register under resources.reads; only the name and JSON input cross a worker boundary. */
export function defineRead<A, T>(
  execute: (args: A, context: ReadContext) => T | Promise<T>,
): RegisteredRead<A, T> {
  return Object.freeze({ kind: "registered-read", execute });
}
export type ReadScope = Readonly<{
  namespace: string;
  reads?: Readonly<Record<string, unknown>>;
  aliases?: Readonly<Record<string, { name: string }>>;
  context?: object;
}>;

/** Owner-only execution metadata; never accepted from a capability request. */
export type ReadExecution = Pick<
  RuntimeContext,
  "operationKey" | "identity" | "signal"
>;
export type OwnerRead = <T = unknown>(
  name: string,
  args?: unknown,
  options?: ReadOptions,
  execution?: ReadExecution,
) => Promise<ReadResult<T>>;
