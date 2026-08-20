import type {
  ConversationMessage,
  ConversationThread,
  LlmAttempt,
  Participant,
  ToolExecution,
} from "../domain/index.ts";
import {
  mapLlmAttemptRecord,
  mapParticipantRecord,
  mapToolExecutionRecord,
} from "../engine/collection-graph.ts";
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

export async function projectLlmAttempts(
  host: TestDomainHost,
  namespace: string,
  threadId: string,
  options: Readonly<{ after?: string; limit?: number }> = {},
): Promise<readonly LlmAttempt[]> {
  const context = createTestDomainContext(host, namespace);
  return Object.freeze(
    (await context.collections.llm_attempt.list({
      where: { threadId },
      order: { field: "createdAt", direction: "asc" },
      ...options,
    })).map(mapLlmAttemptRecord),
  );
}

export async function projectToolExecutions(
  host: TestDomainHost,
  namespace: string,
  threadId: string,
  options: Readonly<{ after?: string; limit?: number }> = {},
): Promise<readonly ToolExecution[]> {
  const context = createTestDomainContext(host, namespace);
  return Object.freeze(
    (await context.collections.tool_execution.list({
      where: { threadId },
      order: { field: "createdAt", direction: "asc" },
      ...options,
    })).map(mapToolExecutionRecord),
  );
}

export async function projectToolExecutionById(
  host: TestDomainHost,
  namespace: string,
  id: string,
): Promise<ToolExecution | null> {
  const context = createTestDomainContext(host, namespace);
  const record = await context.collections.tool_execution.get({ id });
  return record ? mapToolExecutionRecord(record) : null;
}
