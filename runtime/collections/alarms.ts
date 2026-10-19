import { reportDeliveryDiagnostic } from "../execution/diagnostics.ts";
import type { DeliveryDiagnosticSink } from "../execution/types.ts";
import { isOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
import {
  isCollectionAlarmPolicyStale,
  withCollectionAlarmPolicy,
} from "./policy-alarm.ts";
import { withScheduledAlarmAdmission } from "../application/ingress/scheduled.ts";
import { scheduledJobDelegationDigest } from "../schedules/delegation.ts";
import type { CollectionDefinition } from "./definition.ts";
import type { CollectionRuntime } from "./kernel.ts";
import type { CollectionRecord } from "./types.ts";
import { mapNode, type NodeRow } from "./reducer.ts";
import type { DatabaseOwner } from "../engine/commands.ts";
import { createSchemaCommandRunner } from "../engine/commands.ts";
import { completeOwnerDeadline, writeOwnerDeadline } from "../engine/alarms.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import { createCoreTableNames } from "../events/schema.ts";

export async function syncCollectionAlarm(
  transaction: SqlExecutor,
  schema: string,
  definition: CollectionDefinition,
  record: CollectionRecord,
  deleted = false,
): Promise<void> {
  if (!definition.alarm) return;
  await writeOwnerDeadline(transaction, schema, {
    source: `collection:${definition.name}`,
    key: JSON.stringify([record.namespace, record.id]),
    namespace: record.namespace,
    dueAt: deleted ? null : definition.alarm.deadline(record),
    payload: { id: record.id },
  });
}

/** Installs declarations on their database owner; a wake touches only due records. */
export function registerCollectionAlarms(options: {
  owner: DatabaseOwner;
  session: SqlSession;
  schema: string;
  definitions: readonly CollectionDefinition[];
  collections: CollectionRuntime;
  now(): Date;
  onDiagnostic?: DeliveryDiagnosticSink;
}): { seed(): Promise<void>; close(): void } {
  const run = createSchemaCommandRunner(options.session, options.schema);
  const definitions = options.definitions.filter((definition) =>
    definition.alarm
  );
  const cleanup: Array<() => void> = [];
  for (const definition of definitions) {
    cleanup.push(options.owner.registerAlarmSource({
      name: `collection:${definition.name}`,
      async wake(deadlines) {
        const collection = options.collections.get(definition.name)!;
        for (const deadline of deadlines) {
          if (deadline.namespace === null) {
            throw new Error("Collection alarm has no namespace.");
          }
          const id = (deadline.payload as { id: string }).id;
          const scope = { namespace: deadline.namespace };
          const cancelSelected = () =>
            run(
              "alarm.collection.cancel",
              {},
              (_input, context) =>
                completeOwnerDeadline(
                  context.transaction,
                  options.schema,
                  deadline,
                ),
            );
          const refuseSelected = async (error: unknown) => {
            await cancelSelected();
            if (isOwnerAuthorizationRefusal(error)) {
              reportDeliveryDiagnostic(options.onDiagnostic, {
                phase: "owner_alarm_refused",
                timestampMs: options.now().getTime(),
                databaseSchema: options.schema,
                namespace: deadline.namespace!,
                status: "forbidden",
              });
            }
          };
          const readCurrent = () =>
            withCollectionAlarmPolicy({
              definition,
              deadline,
              databaseSchema: options.schema,
              signal: options.owner.signal,
              method: "get",
              args: { id },
            }, () => collection.get(scope, { id }));
          let current: CollectionRecord | null;
          try {
            current = await readCurrent();
          } catch (error) {
            if (
              !isCollectionAlarmPolicyStale(error) &&
              !isOwnerAuthorizationRefusal(error)
            ) throw error;
            await refuseSelected(error);
            continue;
          }
          const dueAt = current && definition.alarm!.deadline(current);
          if (!current || dueAt !== deadline.dueAt) {
            await run(
              "alarm.collection.cancel",
              {},
              (_input, context) =>
                completeOwnerDeadline(
                  context.transaction,
                  options.schema,
                  deadline,
                ),
            );
            continue;
          }
          const command = definition.alarm!.command(current, {
            dueAt: deadline.dueAt,
            now: options.now().toISOString(),
          });
          const callOptions = {
            operationKey: command.key,
            identity: {
              deduplicationId: command.key,
              metadata: { sourceOwnerAlarm: true },
            },
          };
          if (definition.alarm!.ingress === "scheduled-occurrence") {
            if (
              command.name !== "due" || command.input.mode !== "scheduled" ||
              command.input.scheduledFor !== deadline.dueAt ||
              typeof command.input.occurrenceId !== "string"
            ) {
              throw new Error("Scheduled alarm command is invalid.");
            }
            withScheduledAlarmAdmission(callOptions, {
              databaseSchema: options.schema,
              namespace: deadline.namespace,
              scheduleId: id,
              occurrenceId: command.input.occurrenceId,
              scheduledFor: deadline.dueAt,
              scheduleVersion: await scheduledJobDelegationDigest({
                databaseSchema: options.schema,
                namespace: deadline.namespace,
                record: current,
              }),
              deadline,
            });
          }
          try {
            await withCollectionAlarmPolicy({
              definition,
              deadline,
              databaseSchema: options.schema,
              signal: options.owner.signal,
              method: "command",
              args: { id, name: command.name, input: command.input },
            }, () =>
              collection.commands[command.name](scope, {
                ...command.input,
                id,
              }, callOptions));
          } catch (error) {
            if (
              isCollectionAlarmPolicyStale(error) ||
              isOwnerAuthorizationRefusal(error)
            ) {
              await refuseSelected(error);
              continue;
            }
            let latest: CollectionRecord | null;
            try {
              latest = await readCurrent();
            } catch {
              // A later refusal cannot reclassify an earlier infrastructure
              // failure as a permanent denial. Keep the selected work pending.
              throw error;
            }
            if (
              latest && definition.alarm!.deadline(latest) === deadline.dueAt
            ) {
              // A changed schedule may retain the same due time. Its new durable
              // revision must get a fresh proof rather than failing the owner
              // because the stale wake's immutable digest was correctly refused.
              const unchanged =
                definition.alarm!.ingress !== "scheduled-occurrence" ||
                await run(
                  "alarm.collection.validate",
                  {},
                  async (_input, context) => {
                    const selected = await context.transaction.query(
                      `SELECT key FROM ${
                        createCoreTableNames(options.schema).owner_deadlines
                      } WHERE owner='schema' AND source=$1 AND key=$2 AND revision=$3::bigint AND namespace=$4 AND due_at=$5::timestamptz`,
                      [
                        deadline.source,
                        deadline.key,
                        deadline.revision,
                        deadline.namespace,
                        deadline.dueAt,
                      ],
                    );
                    return selected.rows.length > 0;
                  },
                );
              if (unchanged) throw error;
            }
            await run(
              "alarm.collection.cancel",
              {},
              (_input, context) =>
                completeOwnerDeadline(
                  context.transaction,
                  options.schema,
                  deadline,
                ),
            );
          }
        }
      },
    }));
  }
  return {
    close() {
      for (const dispose of cleanup.splice(0)) dispose();
    },
    async seed() {
      const tables = createCoreTableNames(options.schema);
      // Activation is the sole retained-data seed. Normal writes update the
      // deadline index in their own transaction; wakes never scan active jobs.
      for (const definition of definitions) {
        let after = "";
        for (;;) {
          const count = await run(
            "alarm.collection.seed",
            {},
            async (_input, context) => {
              const records = await context.transaction.query<NodeRow>(
                `SELECT * FROM ${tables.nodes} WHERE type=$1 AND id>$2 ORDER BY id LIMIT 1000`,
                [definition.name, after],
              );
              for (const row of records.rows) {
                await syncCollectionAlarm(
                  context.transaction,
                  options.schema,
                  definition,
                  mapNode(row),
                );
              }
              after = records.rows.at(-1)?.id ?? after;
              return records.rows.length;
            },
          );
          if (count < 1000) break;
        }
      }
    },
  };
}
