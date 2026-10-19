import type { SqlExecutor } from "../events/session.ts";

/** Owner-created admission classification; it does not authorize an end user. */
export type ProtectedActionIngress = Readonly<
  { kind: "host" } | { kind: "server-route"; routeId: string } | {
    kind: "scheduled-occurrence";
    scheduleId: string;
    occurrenceId: string;
    scheduledFor: string;
    scheduleVersion: string;
  } | {
    kind: "authenticated-server";
    actor: Readonly<
      { id: string; externalId?: string; name?: string; email?: string }
    >;
  }
>;
/** Retained owner-resolved invocation, never caller-selected metadata. */
export type ProtectedActionSourceEntry = Readonly<{
  event: Readonly<{
    id: string;
    type: string;
    namespace: string;
    metadata: Readonly<Record<string, unknown>>;
  }>;
  data: unknown;
  /** Present only when exact retained event/body has owner-created admission evidence. */
  ingress?: ProtectedActionIngress;
}>;
export type ProtectedActionSource =
  & ProtectedActionSourceEntry
  & Readonly<{
    /** Root-first retained operation ingress chain, including the original root. */
    ancestors: readonly ProtectedActionSourceEntry[];
  }>;

/** Query-only transaction authority, revoked when each local callback ends. */
export type ProtectedActionOwnerContext<Input = unknown> = Readonly<{
  query: SqlExecutor["query"];
  scope: Readonly<{ databaseSchema: string; namespace: string }>;
  action: Readonly<{
    id: string;
    runId: string;
    parentRunId?: string;
  }>;
  input: Input;
  commandTime: string;
  signal: AbortSignal;
  resolveSource(): Promise<ProtectedActionSource>;
}>;

/** Local policy/storage phases only. External network effects belong in Actions. */
export type ProtectedActionDefinition<Input = unknown> = Readonly<{
  /** Exact non-overlapping JSON Pointers to declared public scalar revision fields. */
  publicRevisionFields?: readonly string[];
  /** Read-only policy phase; recheck current domain permissions on every replay. */
  authorize(
    input: Input,
    context: ProtectedActionOwnerContext<Input>,
  ): void | Promise<void>;
  /** Runs at first input capture; may change only secret slots and revision fields. */
  prepareInput?(
    input: Input,
    context: ProtectedActionOwnerContext<Input>,
  ): Input | Promise<Input>;
}>;
export type ProtectedActionDefinitions = Readonly<
  Record<string, ProtectedActionDefinition>
>;
