import type {
  CollectionMutationRef,
  CollectionRecord,
  CollectionUpdatePatch,
} from "../collections/types.ts";
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
export type ProtectedActionOwnerContext<Input = unknown, Output = unknown> =
  Readonly<{
    query: SqlExecutor["query"];
    scope: Readonly<{ databaseSchema: string; namespace: string }>;
    action: Readonly<{
      id: string;
      runId: string;
      parentRunId?: string;
      /** Owner-resolved immediate parent declaration; current policy remains required. */
      parentId?: string;
    }>;
    input: Input;
    commandTime: string;
    signal: AbortSignal;
    resolveSource(): Promise<ProtectedActionSource>;
    /** Fixed accepted output of this Action/run; authorize provenance before reading. */
    readAcceptedOutput(): Promise<Output | undefined>;
  }>;

/** Registered alias-keyed mutations, staged in the current output acceptance transaction. */
export type ProtectedActionCollection = Readonly<{
  create(
    input: Readonly<Record<string, unknown>>,
  ): Promise<CollectionMutationRef>;
  update(
    input: CollectionUpdatePatch<CollectionRecord> & { readonly id: string },
  ): Promise<CollectionMutationRef>;
  delete(input: Readonly<{ id: string }>): Promise<CollectionMutationRef>;
  commands: Readonly<
    Record<
      string,
      (
        input: Readonly<Record<string, unknown> & { id: string }>,
      ) => Promise<CollectionMutationRef>
    >
  >;
}>;
export type ProtectedActionCollections = Readonly<
  Record<string, ProtectedActionCollection>
>;
export type ProtectedActionAdoptionContext<Input = unknown, Output = unknown> =
  & ProtectedActionOwnerContext<Input, Output>
  & Readonly<{ collections: ProtectedActionCollections }>;

/** Local policy/storage phases only. External network effects belong in Actions. */
export type ProtectedActionDefinition<Input = unknown, Output = unknown> =
  Readonly<{
    /** Exact non-overlapping JSON Pointers to declared public scalar revision fields. */
    publicRevisionFields?: readonly string[];
    /** Read-only policy phase; recheck current domain permissions on every replay. */
    authorize(
      input: Input,
      context: ProtectedActionOwnerContext<Input, Output>,
    ): void | Promise<void>;
    /** Runs at first input capture; may change only secret slots and revision fields. */
    prepareInput?(
      input: Input,
      context: ProtectedActionOwnerContext<Input, Output>,
    ): Input | Promise<Input>;
    /** Runs atomically with first accepted output; output is immutable. */
    acceptOutput?(
      output: Output,
      context: ProtectedActionAdoptionContext<Input, Output>,
    ): void | Promise<void>;
  }>;
export type ProtectedActionDefinitions = Readonly<
  Record<string, ProtectedActionDefinition>
>;
