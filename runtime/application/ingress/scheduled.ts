/** Only the owner alarm can attach this local capability to its Collection command. */
import { captureHostCommandJson } from "../host-command-json.ts";
import type { OwnerDeadline } from "../../engine/alarms.ts";
import { schemaCommandContext } from "../../engine/commands.ts";
import type { EventMutationContext } from "../../events/store.ts";
import { scheduledJobDelegationDigest } from "../../schedules/delegation.ts";
import {
  assertOwnerIngressReplay,
  recordOwnerIngress,
  scheduledOccurrenceIngressProof,
} from "./authority.ts";

const symbol = Symbol("owner-scheduled-occurrence");
type Admission = Readonly<{
  databaseSchema: string;
  namespace: string;
  scheduleId: string;
  occurrenceId: string;
  scheduledFor: string;
  scheduleVersion: string;
  deadline: OwnerDeadline;
}>;
const tokens = new WeakMap<object, Admission>();
export function withScheduledAlarmAdmission<T extends object>(
  target: T,
  input: Admission,
): T {
  const token = Object.freeze({});
  tokens.set(token, captureHostCommandJson(input) as Admission);
  return Object.defineProperty(target, symbol, {
    value: token,
    enumerable: true,
  });
}
export function scheduledAlarmAdmission(input: object): Admission | undefined {
  const token = (input as { [symbol]?: object })[symbol];
  if (!token) return;
  const admission = tokens.get(token);
  if (!admission) throw new Error("Scheduled occurrence authority is invalid.");
  return admission;
}
export function captureScheduledAlarmAdmission<T extends object>(
  source: T,
  captured: T,
): T {
  const token = (source as { [symbol]?: object })[symbol];
  if (!token) return captured;
  if (!tokens.has(token)) {
    throw new Error("Scheduled occurrence authority is invalid.");
  }
  return Object.defineProperty(captured, symbol, {
    value: token,
    enumerable: true,
  });
}
const proof = (admission: Admission) =>
  scheduledOccurrenceIngressProof({
    scheduleId: admission.scheduleId,
    occurrenceId: admission.occurrenceId,
    scheduledFor: admission.scheduledFor,
    scheduleVersion: admission.scheduleVersion,
  });
type Event = Parameters<typeof recordOwnerIngress>[2];
export async function recordScheduledAlarmIngress(
  context: EventMutationContext,
  input: Readonly<{
    admission: Admission;
    event: Event;
    body: unknown;
    record: Readonly<Record<string, unknown>>;
  }>,
): Promise<void> {
  const { admission, event, body, record } = input;
  const command = schemaCommandContext(
    context.transaction,
    admission.databaseSchema,
  );
  const occurrence = record.lastOccurrence as
    | Record<string, unknown>
    | undefined;
  const intent = (body as {
    intent?: {
      operation?: string;
      name?: string;
      id?: string;
      input?: unknown;
    };
  })?.intent;
  if (
    event.namespace !== admission.namespace ||
    event.type !== "scheduled_job.due" ||
    record.id !== admission.scheduleId || record.status !== "active" ||
    occurrence?.id !== admission.occurrenceId ||
    occurrence?.mode !== "scheduled" ||
    occurrence?.scheduledFor !== admission.scheduledFor ||
    intent?.operation !== "command" || intent.name !== "due" ||
    intent.id !== admission.scheduleId ||
    await scheduledJobDelegationDigest({
        databaseSchema: admission.databaseSchema,
        namespace: admission.namespace,
        record,
      }) !== admission.scheduleVersion ||
    Date.parse(admission.scheduledFor) > Date.parse(command.commandTime)
  ) {
    throw new Error("Scheduled occurrence binding is invalid.");
  }
  const deadline = admission.deadline;
  const current = await context.transaction.query(
    `SELECT key FROM ${context.tables.owner_deadlines} WHERE owner='schema' AND source=$1 AND key=$2 AND namespace=$3 AND revision=$4::bigint AND due_at=$5::timestamptz`,
    [
      deadline.source,
      deadline.key,
      admission.namespace,
      deadline.revision,
      admission.scheduledFor,
    ],
  );
  if (!current.rows.length) {
    throw new Error("Scheduled occurrence deadline is unavailable.");
  }
  await recordOwnerIngress(
    context,
    admission.databaseSchema,
    event,
    body,
    proof(admission),
  );
}
export function assertScheduledAlarmReplay(
  context: EventMutationContext,
  admission: Admission,
  event: Event,
  body: unknown,
): Promise<void> {
  return assertOwnerIngressReplay(
    context,
    admission.databaseSchema,
    event,
    body,
    proof(admission),
  );
}
