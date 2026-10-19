import type { HostCommandJson } from "../application/host-command-types.ts";
import type { ProtectedActionSource } from "../actions/protected-action-types.ts";
import type { SqlExecutor } from "../events/session.ts";
import type { CollectionRecord } from "./types.ts";

/** Exact owner-resolved operation, never a worker's description of its authority. */
export type CollectionPolicyIntent = Readonly<{
  collection: Readonly<{ alias: string; name: string }>;
  method:
    | "get"
    | "list"
    | "aggregate"
    | "search"
    | "query"
    | "relations.list"
    | "create"
    | "update"
    | "delete"
    | "command"
    | "vectors.search"
    | "vectors.upsert"
    | "relations.upsert";
  args: HostCommandJson;
  phase: "read" | "mutation" | "result";
  /** Exact bounded value being disclosed, separate from fresh current state. */
  result?: HostCommandJson;
  /** Current stored record, read in the same authorization transaction. */
  current?: CollectionRecord | null;
  /** Actual proposed record after the Collection's declared hooks. */
  next?: CollectionRecord | null;
}>;
export type CollectionPolicyInvocation =
  | Readonly<{
    /** Owner-minted after configured server authentication and authorization. */
    kind: "viewer";
    id: string;
    runId: string;
    actor: Readonly<{
      id: string;
      externalId?: string;
      name?: string;
      email?: string;
    }>;
    /** Only the host's bounded context.viewer projection, never request claims. */
    claims: Readonly<Record<string, unknown>>;
  }>
  | Readonly<
    {
      kind: "action" | "processor";
      id: string;
      runId: string;
      parentRunId?: string;
    }
  >
  | Readonly<
    {
      kind: "alarm";
      id: string;
      runId: string;
      collection: string;
      recordId: string;
      deadline: Readonly<{ key: string; revision: string; dueAt: string }>;
    }
  >;
export type CollectionPolicyContext = Readonly<{
  query: SqlExecutor["query"];
  scope: Readonly<{ databaseSchema: string; namespace: string }>;
  invocation: CollectionPolicyInvocation;
  commandTime: string;
  signal: AbortSignal;
  /** Retained original source with verified evidence. Alarms and viewers have no Action source and reject this call. */
  resolveSource(): Promise<ProtectedActionSource>;
}>;
export type CollectionPolicy = Readonly<{
  /**
   * Read-only local policy. An ActionError with code forbidden/status 403 explicitly
   * refuses; other exceptions fail closed without permanent-denial classification.
   * No external I/O or authorization writes.
   */
  authorize(
    intent: CollectionPolicyIntent,
    context: CollectionPolicyContext,
  ): void | Promise<void>;
}>;
export type CollectionPolicies = Readonly<Record<string, CollectionPolicy>>;
