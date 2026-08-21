import {
  type DurableContentInput,
  LLM_CONTENT_ROLE,
} from "@copilotz/copilotz/content";
import {
  defineFeature,
  type FeatureAction,
  type FeatureDefinition,
  type FeatureExecuteContext,
} from "@copilotz/copilotz/features";
import type { CollectionRecord } from "@copilotz/copilotz/collections";
import {
  asRecord,
  contentSequence,
  persistRoleContent,
  preparedContent,
  requiredText,
} from "./content-policy.ts";

export const LLM_ATTEMPT_FEATURE_ID = "copilotz.core.llm-attempt";

async function create(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  const data = asRecord(input);
  const id = requiredText(data.id, "LLM attempt ID");
  const threadId = requiredText(data.threadId, "Thread ID");
  const { content: _content, ...fields } = data;
  const metadata = structuredClone(asRecord(data.metadata));
  return await context.transaction(async (tx) => {
    const supplied = data.content as DurableContentInput | undefined;
    const created = await tx.collections.llm_attempt.create({
      ...fields,
      id,
      threadId,
      ...(supplied === undefined ? {} : { content: supplied }),
    }, { threadId, identity: { metadata } });
    return created;
  });
}

async function complete(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  const data = asRecord(input);
  const id = requiredText(data.id, "LLM attempt ID");
  const current = await context.collections.llm_attempt.get({ id });
  if (!current) throw new Error(`LLM attempt '${id}' was not found.`);
  const threadId = requiredText(current.threadId, "Thread ID");
  const metadataPatch = asRecord(data.metadataPatch);
  const metadata = { ...asRecord(current.metadata), ...metadataPatch };
  return await context.transaction(async (tx) => {
    const content = persistRoleContent(
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
    const updated = await tx.collections.llm_attempt.commands.complete({
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
      ...(Object.keys(metadataPatch).length ? { metadata } : {}),
    }, { threadId, identity: { metadata } });
    return updated;
  });
}

async function fail(
  input: unknown,
  context: FeatureExecuteContext,
): Promise<CollectionRecord> {
  const data = asRecord(input);
  const id = requiredText(data.id, "LLM attempt ID");
  const current = await context.collections.llm_attempt.get({ id });
  if (!current) throw new Error(`LLM attempt '${id}' was not found.`);
  const threadId = requiredText(current.threadId, "Thread ID");
  const safeError = asRecord(data.safeError);
  const metadataPatch = asRecord(data.metadataPatch);
  const metadata = { ...asRecord(current.metadata), ...metadataPatch };
  return await context.transaction(async (tx) => {
    const content = persistRoleContent(
      contentSequence(current.content),
      [{
        role: LLM_CONTENT_ROLE.errorDetail,
        input: preparedContent(data.errorDetail),
        cardinality: "one",
      }],
    );
    const updated = await tx.collections.llm_attempt.commands.fail({
      id,
      message: String(safeError.message ?? "LLM attempt failed"),
      ...(safeError.code ? { code: safeError.code } : {}),
      content,
      finishedAt: typeof data.finishedAt === "string"
        ? data.finishedAt
        : new Date().toISOString(),
      ...(data.usage ? { usage: data.usage } : {}),
      ...(data.cost ? { cost: data.cost } : {}),
      ...(Object.keys(metadataPatch).length ? { metadata } : {}),
    }, { threadId, identity: { metadata } });
    return updated;
  });
}

const idInput = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
  },
  required: ["id"],
} as const;

const createInput = {
  type: "object",
  additionalProperties: true,
  properties: {
    id: { type: "string" },
    threadId: { type: "string" },
    content: {},
  },
  required: ["id", "threadId"],
} as const;

type LlmAttemptFeature = FeatureDefinition<{
  create: FeatureAction<
    typeof createInput,
    CollectionRecord
  >;
  complete: FeatureAction<
    typeof idInput,
    CollectionRecord
  >;
  fail: FeatureAction<
    typeof idInput,
    CollectionRecord
  >;
}>;

const llmAttemptFeatureDefinition: LlmAttemptFeature = defineFeature({
  id: LLM_ATTEMPT_FEATURE_ID,
  actions: {
    create: {
      inputSchema: createInput,
      execute: create,
    },
    complete: {
      inputSchema: idInput,
      execute: complete,
    },
    fail: {
      inputSchema: idInput,
      execute: fail,
    },
  },
});

export const llmAttemptFeature: LlmAttemptFeature = llmAttemptFeatureDefinition;
