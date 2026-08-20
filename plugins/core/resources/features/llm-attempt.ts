import {
  type DurableContentInput,
  LLM_CONTENT_ROLE,
} from "@copilotz/copilotz/content";
import type {
  FeatureContext,
  FeatureResource,
} from "@copilotz/copilotz/features";
import {
  asRecord,
  contentSequence,
  linkContent,
  persistRoleContent,
  preparedContent,
  requiredText,
} from "./content-policy.ts";

export const LLM_ATTEMPT_FEATURE_ID = "copilotz.core.llm-attempt";

async function create(input: unknown, context: FeatureContext) {
  const data = asRecord(input);
  const id = requiredText(data.id, "LLM attempt ID");
  const threadId = requiredText(data.threadId, "Thread ID");
  const supplied = data.content as DurableContentInput | undefined;
  const content = supplied === undefined
    ? undefined
    : await context.content.materialize(supplied, {
      origin: {
        scope: { type: "thread", id: threadId },
        producer: { type: "llm_attempt", id },
      },
    });
  const { content: _content, ...fields } = data;
  const created = await context.collections.llm_attempt.create({
    ...fields,
    id,
    threadId,
    ...(content ? { content } : {}),
  }, { threadId });
  if (content) await linkContent(context, id, content);
  return created;
}

async function complete(input: unknown, context: FeatureContext) {
  const data = asRecord(input);
  const id = requiredText(data.id, "LLM attempt ID");
  const current = await context.collections.llm_attempt.get({ id });
  if (!current) throw new Error(`LLM attempt '${id}' was not found.`);
  const threadId = requiredText(current.threadId, "Thread ID");
  const content = await persistRoleContent(
    context,
    { type: "llm_attempt", id, threadId },
    contentSequence(current.content),
    [
      {
        role: LLM_CONTENT_ROLE.answer,
        input: preparedContent(data.answer),
        cardinality: "one",
      },
      {
        role: LLM_CONTENT_ROLE.reasoning,
        input: preparedContent(data.reasoning),
        cardinality: "one",
      },
      {
        role: LLM_CONTENT_ROLE.toolCalls,
        input: preparedContent(data.toolCalls),
        cardinality: "one",
      },
    ],
  );
  const metadataPatch = asRecord(data.metadataPatch);
  const updated = await context.collections.llm_attempt.commands.complete({
    id,
    content,
    ...(data.finishReason ? { finishReason: data.finishReason } : {}),
    ...(data.usage ? { usage: data.usage } : {}),
    ...(data.cost ? { cost: data.cost } : {}),
    finishedAt: typeof data.finishedAt === "string"
      ? data.finishedAt
      : new Date().toISOString(),
    ...(data.metricsFinalizedAt
      ? { metricsFinalizedAt: data.metricsFinalizedAt }
      : {}),
    ...(Object.keys(metadataPatch).length
      ? { metadata: { ...asRecord(current.metadata), ...metadataPatch } }
      : {}),
  }, { threadId });
  await linkContent(context, id, content);
  return updated;
}

async function fail(input: unknown, context: FeatureContext) {
  const data = asRecord(input);
  const id = requiredText(data.id, "LLM attempt ID");
  const current = await context.collections.llm_attempt.get({ id });
  if (!current) throw new Error(`LLM attempt '${id}' was not found.`);
  const threadId = requiredText(current.threadId, "Thread ID");
  const safeError = asRecord(data.safeError);
  const metadataPatch = asRecord(data.metadataPatch);
  const content = await persistRoleContent(
    context,
    { type: "llm_attempt", id, threadId },
    contentSequence(current.content),
    [{
      role: LLM_CONTENT_ROLE.errorDetail,
      input: preparedContent(data.errorDetail),
      cardinality: "one",
    }],
  );
  const updated = await context.collections.llm_attempt.commands.fail({
    id,
    message: String(safeError.message ?? "LLM attempt failed"),
    ...(safeError.code ? { code: safeError.code } : {}),
    content,
    finishedAt: typeof data.finishedAt === "string"
      ? data.finishedAt
      : new Date().toISOString(),
    ...(data.usage ? { usage: data.usage } : {}),
    ...(data.cost ? { cost: data.cost } : {}),
    ...(Object.keys(metadataPatch).length
      ? { metadata: { ...asRecord(current.metadata), ...metadataPatch } }
      : {}),
  }, { threadId });
  await linkContent(context, id, content);
  return updated;
}

export const llmAttemptFeature: FeatureResource = Object.freeze({
  id: LLM_ATTEMPT_FEATURE_ID,
  alias: "llmAttempt",
  actions: Object.freeze({ create, complete, fail }),
});
