/** Resolves only this owner invocation's fixed immediate parent declaration. */
import type { SqlExecutor } from "../events/session.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import { readEventByDeduplicationIdOn } from "../events/store.ts";
import { actionInvocationParent } from "./invocation-parent.ts";
import type { ActionInvocationFrame } from "./invoker.ts";
import { publicActionLifecycleData } from "./protected-lifecycle.ts";
import type { AnyActionDefinition } from "./types.ts";

export async function resolveProtectedActionParent(
  options: Readonly<{
    transaction: SqlExecutor;
    databaseSchema: string;
    namespace: string;
    frame: Pick<
      ActionInvocationFrame,
      "actionId" | "actionRunId" | "parentActionRunId"
    >;
    actions: Readonly<Record<string, AnyActionDefinition>>;
  }>,
): Promise<string | undefined> {
  const { frame, transaction, namespace } = options;
  if (!frame.parentActionRunId) return;
  const tables = createCoreTableNames(options.databaseSchema);
  const refused = () =>
    new Error("Protected Action parent binding is unavailable.");
  const read = async (runId: string) => {
    const event = await readEventByDeduplicationIdOn(
      transaction,
      tables,
      namespace,
      `${runId}:action:invoked`,
    );
    if (!event) return;
    const body = await readEventBody(
      { transaction, tables },
      namespace,
      eventDataRef(event.payload),
    );
    const data = publicActionLifecycleData(body) as {
      status?: unknown;
      actionId?: unknown;
      actionRunId?: unknown;
      parentActionRunId?: unknown;
    };
    if (
      !data || data.status !== "invoked" || data.actionRunId !== runId ||
      typeof data.actionId !== "string" ||
      event.type !== `${data.actionId}.invoked` ||
      event.subject?.id !== runId || event.subject.type !== data.actionId ||
      !Object.values(options.actions).some((action) =>
        action.id === data.actionId
      )
    ) throw refused();
    return data;
  };
  const child = await read(frame.actionRunId);
  const actual = actionInvocationParent(frame);
  if (child) {
    if (
      child.actionId !== frame.actionId ||
      child.parentActionRunId !== frame.parentActionRunId
    ) throw refused();
  } else if (
    !actual || actual.actionId !== frame.actionId ||
    actual.actionRunId !== frame.actionRunId ||
    actual.parentRunId !== frame.parentActionRunId
  ) throw refused();
  const parent = await read(frame.parentActionRunId);
  if (!parent || actual && parent.actionId !== actual.parentId) throw refused();
  return parent.actionId as string;
}
