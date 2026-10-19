/** Explicit host-bound directory reads for the platform staff exception. */
import type {
  CollectionQuery,
  CollectionRecord,
} from "../collections/types.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  type CommandContext,
  schemaCommandContext,
} from "../engine/commands.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { stableStringify } from "../collections/equal.ts";
import { withoutOwnerCommandAuthorization } from "../engine/command-authorization.ts";
import { withoutCollectionPolicyInvocation } from "./invocation.ts";

export type StaffAuthorizationSource = Readonly<{
  kind: "platform-staff";
  alias: string;
  /** Opaque directory owner identity, never a tenant-local role alias. */
  owner: string;
  namespace: string;
  collection: string;
  /** Host-bound capability: issue fresh read commands to this directory owner. */
  read: Readonly<{
    get(id: string, signal: AbortSignal): Promise<CollectionRecord | null>;
    list(
      query: CollectionQuery,
      signal: AbortSignal,
    ): Promise<readonly CollectionRecord[]>;
  }>;
}>;
export type AuthorizationSource = string | StaffAuthorizationSource;
export const sourceAlias = (source: AuthorizationSource): string =>
  typeof source === "string" ? source : source.alias;

export function validStaffSource(source: StaffAuthorizationSource): boolean {
  return !!source && source.kind === "platform-staff" &&
    [source.alias, source.owner, source.namespace, source.collection].every(
      (value) => typeof value === "string" && !!value.trim(),
    ) && typeof source.read?.get === "function" &&
    typeof source.read?.list === "function";
}
export function captureAuthorizationSource(
  source: AuthorizationSource,
): AuthorizationSource {
  return typeof source === "string" ? source : Object.freeze({
    kind: source.kind,
    alias: source.alias,
    owner: source.owner,
    namespace: source.namespace,
    collection: source.collection,
    read: Object.freeze({ get: source.read.get, list: source.read.list }),
  });
}

type DirectoryResult = CollectionRecord | null | readonly CollectionRecord[];
// Result gates in the same command finish under the authority read at admission.
// No directory result survives into the next command's transaction.
const commandReads = new WeakMap<
  CommandContext,
  Map<StaffAuthorizationSource, Map<string, Promise<DirectoryResult>>>
>();
export function readStaffSource(
  source: StaffAuthorizationSource,
  request: { id: string } | { query: CollectionQuery },
  command: Readonly<{ transaction: SqlExecutor; signal: AbortSignal }>,
  databaseSchema: string,
): Promise<DirectoryResult> {
  command.signal.throwIfAborted();
  const captured = captureHostCommandJson(request, {
    omitUndefinedProperties: true,
  }) as typeof request;
  const key = stableStringify(captured);
  const context = schemaCommandContext(command.transaction, databaseSchema);
  let sources = commandReads.get(context);
  if (!sources) commandReads.set(context, sources = new Map());
  let reads = sources.get(source);
  if (!reads) sources.set(source, reads = new Map());
  let result = reads.get(key);
  if (!result) {
    result = withoutOwnerCommandAuthorization(() =>
      withoutCollectionPolicyInvocation(async () => {
        const value = "id" in captured
          ? await source.read.get(captured.id, command.signal)
          : await source.read.list(
            captured.query as CollectionQuery,
            command.signal,
          );
        command.signal.throwIfAborted();
        return captureHostCommandJson(value) as DirectoryResult;
      })
    );
    reads.set(key, result);
  }
  return result;
}
