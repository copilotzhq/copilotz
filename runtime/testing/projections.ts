import type {
  ConversationMessage,
  ConversationThread,
  Participant,
} from "../domain/index.ts";
import type { ActionEventData } from "../actions/index.ts";
import { mapParticipantRecord } from "../engine/collection-graph.ts";
import type { ProcessorEvent } from "../plugins/index.ts";
import {
  createTestDomainContext,
  projectTestMessage,
  projectTestMessages,
  projectTestThread,
  type TestDomainHost,
} from "./domain-context.ts";

export async function projectMessages(
  host: TestDomainHost,
  namespace: string,
  threadId: string,
  options: Readonly<{
    after?: string;
    before?: string;
    limit?: number;
    order?: "asc" | "desc";
    view?: "active" | "all";
  }> = {},
): Promise<readonly ConversationMessage[]> {
  const context = createTestDomainContext(host, namespace);
  return await projectTestMessages(
    context,
    await context.collections.message.queries.history({ threadId, ...options }),
  );
}

export async function projectMessageById(
  host: TestDomainHost,
  namespace: string,
  id: string,
): Promise<ConversationMessage | null> {
  const context = createTestDomainContext(host, namespace);
  return await projectTestMessage(
    context,
    await context.collections.message.get({ id }),
  );
}

export async function projectThreadById(
  host: TestDomainHost,
  namespace: string,
  id: string,
): Promise<ConversationThread | null> {
  const context = createTestDomainContext(host, namespace);
  return await projectTestThread(
    context,
    await context.collections.thread.get({ id }),
  );
}

export async function projectThreadByExternalId(
  host: TestDomainHost,
  namespace: string,
  externalId: string,
): Promise<ConversationThread | null> {
  const context = createTestDomainContext(host, namespace);
  const [record] = await context.collections.thread.queries.byExternalId({
    externalId,
  });
  return await projectTestThread(context, record ?? null);
}

export async function projectThreads(
  host: TestDomainHost,
  namespace: string,
): Promise<readonly ConversationThread[]> {
  const context = createTestDomainContext(host, namespace);
  return Object.freeze(
    (await Promise.all(
      (await context.collections.thread.list()).map((record) =>
        projectTestThread(context, record)
      ),
    )).filter((thread): thread is ConversationThread => thread !== null),
  );
}

export async function projectParticipants(
  host: TestDomainHost,
  namespace: string,
): Promise<readonly Participant[]> {
  const context = createTestDomainContext(host, namespace);
  return Object.freeze(
    (await context.collections.participant.list()).map(mapParticipantRecord),
  );
}

export async function projectParticipantById(
  host: TestDomainHost,
  namespace: string,
  id: string,
): Promise<Participant | null> {
  const context = createTestDomainContext(host, namespace);
  const record = await context.collections.participant.get({ id });
  return record ? mapParticipantRecord(record) : null;
}

/** Resolves persisted Action lifecycle bodies through the Processor path. */
export async function projectActionEvents(
  host: TestDomainHost,
  namespace: string,
  actionId: string,
  options: Readonly<{
    status?: ActionEventData["status"];
    threadId?: string;
  }> = {},
): Promise<readonly ActionEventData[]> {
  const projected: ActionEventData[] = [];
  const unbind = await host.bindTransient({
    id: `test.action-events.${crypto.randomUUID()}`,
    on: [{ eventType: "*" }],
    handle(event: ProcessorEvent) {
      if (!isActionEventData(event.data)) return;
      if (event.data.actionId !== actionId) return;
      if (options.status && event.data.status !== options.status) return;
      if (
        options.threadId &&
        actionThreadId(event.data.input) !== options.threadId
      ) return;
      projected.push(event.data);
    },
  }, { namespace, afterPosition: "0" });
  unbind();
  return Object.freeze(projected);
}

function isActionEventData(value: unknown): value is ActionEventData {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ActionEventData>;
  return typeof candidate.actionId === "string" &&
    typeof candidate.actionRunId === "string" &&
    (candidate.status === "invoked" || candidate.status === "completed" ||
      candidate.status === "failed" || candidate.status === "cancelled") &&
    "input" in candidate;
}

function actionThreadId(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const threadId = (input as Record<string, unknown>).threadId;
  return typeof threadId === "string" ? threadId : undefined;
}
