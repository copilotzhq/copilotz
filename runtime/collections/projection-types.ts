import type { SqlExecutor } from "../events/session.ts";
import type { CollectionPolicyInvocation } from "./policy-types.ts";

/** Owner-only, revocable read scope. Projections must perform no writes or external side effects. */
export type CollectionProjectionContext = Readonly<{
  query: SqlExecutor["query"];
  scope: Readonly<{ databaseSchema: string; namespace: string }>;
  viewer: Extract<CollectionPolicyInvocation, { kind: "viewer" }>;
  commandTime: string;
  signal: AbortSignal;
}>;
export type CollectionProjection = Readonly<{
  /** Return only explicitly sanitized fields allowed by the declared output schema. */
  select(
    input: Readonly<Record<string, unknown>>,
    context: CollectionProjectionContext,
  ):
    | readonly Record<string, unknown>[]
    | Promise<readonly Record<string, unknown>[]>;
}>;
/** Collection alias, then declared named query. Never included in worker composition. */
export type CollectionProjections = Readonly<
  Record<string, Readonly<Record<string, CollectionProjection>>>
>;
