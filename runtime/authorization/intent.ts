import type { HostCommandJson } from "../application/host-command-types.ts";
import type { CollectionRecord } from "../collections/types.ts";

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
