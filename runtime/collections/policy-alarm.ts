/** Only the registered owner scheduler mints this exact, short-lived authority. */
import { captureHostCommandJson } from "../application/host-command-json.ts";
import type { OwnerDeadline } from "../engine/alarms.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { CollectionDefinition } from "./definition.ts";
import { stableStringify } from "./equal.ts";
import { collectionPolicyRefused } from "./policy-authorization.ts";
import { withOwnerCollectionInvocation } from "./policy-invocation.ts";

const stale = new WeakSet<object>();
export function isCollectionAlarmPolicyStale(error: unknown): boolean {
  return !!error && typeof error === "object" && stale.has(error);
}
function staleAlarm(): never {
  const error = Object.assign(
    new Error("Collection alarm authority is stale."),
    { code: "owner_alarm_policy_stale" },
  );
  stale.add(error);
  throw error;
}

export function withCollectionAlarmPolicy<T>(
  options: Readonly<{
    definition: CollectionDefinition;
    deadline: OwnerDeadline;
    databaseSchema: string;
    signal: AbortSignal;
    method: "get" | "command";
    args: unknown;
  }>,
  run: () => T | Promise<T>,
): Promise<T> {
  const { definition, deadline, databaseSchema, signal, method } = options;
  const namespace = deadline.namespace;
  const recordId = (deadline.payload as { id?: unknown })?.id;
  if (
    !definition.alarm || !namespace || typeof recordId !== "string" ||
    deadline.source !== `collection:${definition.name}` ||
    deadline.key !== JSON.stringify([namespace, recordId])
  ) collectionPolicyRefused();
  const args = captureHostCommandJson(options.args);
  const invocation = Object.freeze({
    kind: "alarm" as const,
    id: deadline.source,
    runId: JSON.stringify([deadline.source, deadline.key, deadline.revision]),
    collection: definition.name,
    recordId,
    deadline: Object.freeze({
      key: deadline.key,
      revision: deadline.revision,
      dueAt: deadline.dueAt,
    }),
  });
  return withOwnerCollectionInvocation({
    scope: Object.freeze({ databaseSchema, namespace }),
    signal,
    invocation,
    check() {
      signal.throwIfAborted();
    },
    resolveSource() {
      return Promise.reject(new Error("Owner alarms have no Action source."));
    },
    async authorizeIntent(intent, read) {
      if (
        intent.collection.name !== definition.name ||
        intent.method !== method ||
        stableStringify(intent.args) !== stableStringify(args)
      ) collectionPolicyRefused();
      // A successful declared alarm command advances/removes its selected deadline.
      // Its result still passes the domain's fresh current-state disclosure policy.
      if (method === "command" && intent.phase === "result") return;
      const selected = await read.transaction.query(
        `SELECT key FROM ${
          createCoreTableNames(databaseSchema).owner_deadlines
        } WHERE owner='schema' AND source=$1 AND key=$2 AND revision=$3::bigint AND namespace=$4 AND due_at=$5::timestamptz`,
        [
          deadline.source,
          deadline.key,
          deadline.revision,
          namespace,
          deadline.dueAt,
        ],
      );
      if (selected.rows.length !== 1) staleAlarm();
    },
  }, run);
}
