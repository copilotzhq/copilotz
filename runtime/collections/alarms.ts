import type { AuthenticatedAuthority } from "../authorization/authority.ts";
import type { OwnerAuthorization } from "../authorization/evaluator.ts";
import { withCollectionAlarmPolicy } from "./alarm-authority.ts";
import { reportDeliveryDiagnostic } from "../execution/diagnostics.ts";
import type { DeliveryDiagnosticSink } from "../execution/types.ts";
import { isOwnerAuthorizationRefusal } from "../engine/authorization-refusal.ts";
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
  authorization?: OwnerAuthorization;
  aliases?: Readonly<Record<string, CollectionDefinition>>;
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
        for (const deadline of deadlines) {
          if (deadline.namespace === null) {
            throw new Error("Collection alarm has no namespace.");
          }
          try {
            await run("alarm.collection.run", {}, async (_input, context) => {
              const selected = await context.transaction.query(
                `SELECT key FROM ${
                  createCoreTableNames(options.schema).owner_deadlines
                }
                 WHERE owner='schema' AND source=$1 AND key=$2 AND revision=$3::bigint
                   AND namespace=$4 AND due_at=$5::timestamptz AND due_at<=$6::timestamptz`,
                [
                  deadline.source,
                  deadline.key,
                  deadline.revision,
                  deadline.namespace,
                  deadline.dueAt,
                  context.commandTime,
                ],
              );
              if (!selected.rows.length) return;
              const id = (deadline.payload as { id: string }).id;
              const alias = Object.entries(options.aliases ?? {}).find((
                [, value],
              ) => value.name === definition.name)?.[0];
              const policy = alias && options.authorization?.collections[alias];
              const ownerScope = options.authorization?.systemScopes
                ?.[deadline.namespace!];
              const authority: AuthenticatedAuthority | undefined =
                policy && ownerScope
                  ? {
                    version: 1,
                    principal: { kind: "host-task", id: deadline.source },
                    scope: ownerScope,
                    validity: {
                      kind: "occurrence",
                      key: deadline.key,
                      revision: deadline.revision,
                    },
                    policy,
                    requestFacts: {
                      endpoint: deadline.source,
                      transport: "alarm",
                      operation: "due",
                      params: { id },
                      input: null,
                    },
                    provenance: { ingress: "alarm", source: deadline.key },
                    dependencies: [],
                    authorityBasis: { kind: "occurrence", id: deadline.key },
                  }
                  : undefined;
              if (policy && !authority) {
                throw new Error(
                  "Protected owner alarms require explicit systemScopes placement.",
                );
              }
              const scope = { namespace: deadline.namespace! };
              const collection = options.collections.get(definition.name)!;
              const current = await withCollectionAlarmPolicy({
                authority,
                definition,
                deadline,
                databaseSchema: options.schema,
                signal: options.owner.signal,
                method: "get",
                args: { id },
              }, async () =>
                (await options.collections.transaction({
                  namespace: scope.namespace,
                  operationKey: deadline.key,
                  execute: () => collection.get(scope, { id }),
                }, context)).value);
              if (
                !current ||
                definition.alarm!.deadline(current) !== deadline.dueAt
              ) {
                await completeOwnerDeadline(
                  context.transaction,
                  options.schema,
                  deadline,
                );
                return;
              }
              const command = definition.alarm!.command(current, {
                dueAt: deadline.dueAt,
                now: context.commandTime,
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
                  command.name !== "due" ||
                  command.input.mode !== "scheduled" ||
                  command.input.scheduledFor !== deadline.dueAt ||
                  typeof command.input.occurrenceId !== "string"
                ) {
                  throw new Error("Scheduled alarm command is invalid.");
                }
                withScheduledAlarmAdmission(callOptions, {
                  ...(authority ? { authority } : {}),
                  databaseSchema: options.schema,
                  namespace: deadline.namespace!,
                  scheduleId: id,
                  occurrenceId: command.input.occurrenceId,
                  scheduledFor: deadline.dueAt,
                  scheduleVersion: await scheduledJobDelegationDigest({
                    databaseSchema: options.schema,
                    namespace: deadline.namespace!,
                    record: current,
                  }),
                  deadline,
                });
              }
              await withCollectionAlarmPolicy(
                {
                  authority,
                  definition,
                  deadline,
                  databaseSchema: options.schema,
                  signal: options.owner.signal,
                  method: "command",
                  args: { id, name: command.name, input: command.input },
                },
                () =>
                  options.collections.transaction({
                    namespace: scope.namespace,
                    operationKey: command.key,
                    identity: callOptions.identity,
                    execute: ({ collections }) =>
                      collections[definition.name].commands[command.name]({
                        ...command.input,
                        id,
                      }, callOptions),
                  }, context),
              );
            });
          } catch (error) {
            if (!isOwnerAuthorizationRefusal(error)) throw error;
            await run(
              "alarm.collection.refused",
              {},
              (_input, context) =>
                completeOwnerDeadline(
                  context.transaction,
                  options.schema,
                  deadline,
                ),
            );
            reportDeliveryDiagnostic(options.onDiagnostic, {
              phase: "owner_alarm_refused",
              timestampMs: options.now().getTime(),
              databaseSchema: options.schema,
              namespace: deadline.namespace,
              status: "forbidden",
            });
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
