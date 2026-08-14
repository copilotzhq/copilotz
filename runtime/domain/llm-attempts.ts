import { ulid } from "../../dependencies/ulid.ts";
import { cloneContentRef } from "../content/input.ts";
import type { ContentSequence } from "../content/index.ts";
import type { EventVisibility } from "../events/index.ts";
import type { MutationIdentity } from "./types.ts";
import {
  assertRoleContentMatches,
  composeRoleContent,
  replaceContentRoles,
  type RoleContentInput,
} from "./workflow-content.ts";
import {
  findWorkflowNode,
  insertWorkflowEdge,
  mapWorkflowSafeError,
  normalizeWorkflowSafeError,
  requireWorkflowNode,
  workflowDeepFreeze,
  workflowIdentityDraft,
  workflowIso,
  workflowMutationId,
  type WorkflowNodeRow,
  workflowObject,
  workflowOptionalText,
  workflowRecord,
  workflowRequiredText,
  workflowStringArray,
  workflowTimestamp,
} from "./workflow-support.ts";
import {
  type CancelLlmAttemptInput,
  type CompleteLlmAttemptInput,
  type CreateLlmAttemptRepositoryOptions,
  type FailLlmAttemptInput,
  LLM_CONTENT_ROLE,
  type LlmAttempt,
  type LlmAttemptRepository,
  type LlmAttemptStatus,
  type UpdateLlmAttemptInput,
} from "./workflow-types.ts";

const TERMINAL_STATUSES = new Set<LlmAttemptStatus>([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

function attemptStatus(value: unknown): LlmAttemptStatus {
  if (
    value === "pending" || value === "running" || value === "completed" ||
    value === "failed" || value === "cancelled" || value === "superseded"
  ) return value;
  throw new Error(
    "Stored LLM attempt has invalid status '" + String(value) + "'.",
  );
}

function normalizedContent(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.map((ref) => cloneContentRef(ref)));
}

function optionalRecord(value: unknown): Record<string, unknown> | undefined {
  const mapped = workflowObject(value);
  return Object.keys(mapped).length > 0 ? mapped : undefined;
}

function mapLlmAttempt(row: WorkflowNodeRow): LlmAttempt {
  const data = workflowRecord(row.data);
  const threadId = typeof data.threadId === "string" ? data.threadId : "";
  if (!threadId) {
    throw new Error("LLM attempt '" + row.id + "' has no thread ID.");
  }
  const attemptIndex = Number(data.attemptIndex ?? 0);
  if (!Number.isSafeInteger(attemptIndex) || attemptIndex < 0) {
    throw new Error(
      "LLM attempt '" + row.id + "' has an invalid attempt index.",
    );
  }
  const usage = optionalRecord(data.usage);
  const cost = optionalRecord(data.cost);
  const error = mapWorkflowSafeError(data.safeError);
  return workflowDeepFreeze({
    id: row.id,
    namespace: row.namespace,
    threadId,
    ...(typeof data.messageId === "string"
      ? { messageId: data.messageId }
      : {}),
    ...(typeof data.participantId === "string"
      ? { participantId: data.participantId }
      : {}),
    ...(typeof data.initiatorParticipantId === "string"
      ? { initiatorParticipantId: data.initiatorParticipantId }
      : {}),
    ...(typeof data.agentId === "string" ? { agentId: data.agentId } : {}),
    ...(typeof data.provider === "string" ? { provider: data.provider } : {}),
    ...(typeof data.model === "string" ? { model: data.model } : {}),
    status: attemptStatus(data.status),
    attemptIndex,
    ...(typeof data.parentAttemptId === "string"
      ? { parentAttemptId: data.parentAttemptId }
      : {}),
    inputMessageIds: workflowStringArray(data.inputMessageIds),
    availableToolIds: workflowStringArray(data.availableToolIds),
    content: normalizedContent(data.content),
    ...(typeof data.finishReason === "string"
      ? { finishReason: data.finishReason }
      : {}),
    ...(usage ? { usage } : {}),
    ...(cost ? { cost } : {}),
    ...(error ? { safeError: error } : {}),
    startedAt: typeof data.startedAt === "string"
      ? data.startedAt
      : workflowIso(row.created_at),
    ...(typeof data.finishedAt === "string"
      ? { finishedAt: data.finishedAt }
      : {}),
    ...(typeof data.metricsFinalizedAt === "string"
      ? { metricsFinalizedAt: data.metricsFinalizedAt }
      : {}),
    metadata: workflowObject(data.metadata),
    createdAt: workflowIso(row.created_at),
    updatedAt: workflowIso(row.updated_at),
  });
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("LLM attempt limit must be a positive integer.");
  }
  return Math.min(value, 1_000);
}

function identityWithDefault(
  identity: MutationIdentity | undefined,
  deduplicationId: string | undefined,
): MutationIdentity | undefined {
  if (identity?.deduplicationId || !deduplicationId) return identity;
  return { ...identity, deduplicationId };
}

function uniqueText(values: readonly string[] | undefined, name: string) {
  const result = new Set<string>();
  for (const value of values ?? []) {
    result.add(workflowRequiredText(value, name));
  }
  return Object.freeze([...result]);
}

function eventVisibility(
  input: { visibility?: EventVisibility },
): EventVisibility {
  return input.visibility ?? { kind: "internal" };
}

type TransitionInput =
  | UpdateLlmAttemptInput
  | CompleteLlmAttemptInput
  | FailLlmAttemptInput
  | CancelLlmAttemptInput;
type TransitionOperation = "updated" | "completed" | "failed" | "cancelled";

function transitionContent(
  input: TransitionInput,
): { fields: RoleContentInput[]; roles: Set<string> } {
  const fields: RoleContentInput[] = [];
  const roles = new Set<string>();
  const add = (role: string, value: unknown) => {
    if (value === undefined) return;
    fields.push({
      role,
      input: value as RoleContentInput["input"],
      cardinality: "one",
    });
    roles.add(role);
  };
  if ("answer" in input) add(LLM_CONTENT_ROLE.answer, input.answer);
  if ("reasoning" in input) add(LLM_CONTENT_ROLE.reasoning, input.reasoning);
  if ("toolCalls" in input) add(LLM_CONTENT_ROLE.toolCalls, input.toolCalls);
  if ("errorDetail" in input) {
    add(LLM_CONTENT_ROLE.errorDetail, input.errorDetail);
  }
  add(LLM_CONTENT_ROLE.trace, input.trace);
  return { fields, roles };
}

/** Creates typed graph-native logical and provider LLM attempt operations. */
export function createLlmAttemptRepository(
  options: CreateLlmAttemptRepositoryOptions,
): LlmAttemptRepository {
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const names = options.eventStore.tables;

  const read = async (namespace: string, id: string) => {
    const row = await findWorkflowNode(
      options.session,
      names.nodes,
      namespace,
      id,
      "llm_attempt",
    );
    return row ? mapLlmAttempt(row) : null;
  };

  const transition = async (
    operation: TransitionOperation,
    input: TransitionInput,
  ) => {
    const namespace = workflowRequiredText(input.namespace, "Namespace");
    const id = workflowRequiredText(input.id, "LLM attempt ID");
    const existing = await read(namespace, id);
    if (!existing) throw new Error("llm_attempt '" + id + "' was not found.");
    const targetStatus = operation === "completed"
      ? "completed"
      : operation === "failed"
      ? "failed"
      : operation === "cancelled"
      ? "cancelled"
      : undefined;
    const identity = identityWithDefault(
      input.identity,
      targetStatus ? "llm_attempt:" + id + ":" + operation : undefined,
    );
    const { fields, roles } = transitionContent(input);
    const prepared = composeRoleContent(fields);
    const provider = "provider" in input
      ? workflowOptionalText(input.provider, "Provider")
      : undefined;
    const model = "model" in input
      ? workflowOptionalText(input.model, "Model")
      : undefined;
    const requestedStatus = "status" in input ? input.status : undefined;
    const finishReason = "finishReason" in input
      ? workflowOptionalText(input.finishReason, "Finish reason")
      : undefined;
    const usage = input.usage ? workflowObject(input.usage) : undefined;
    const cost = input.cost ? workflowObject(input.cost) : undefined;
    const finishedAtInput = "finishedAt" in input
      ? input.finishedAt
      : undefined;
    const metricsFinalizedAt = "metricsFinalizedAt" in input
      ? workflowTimestamp(input.metricsFinalizedAt, "metricsFinalizedAt")
      : undefined;
    const failure = operation === "failed"
      ? normalizeWorkflowSafeError((input as FailLlmAttemptInput).safeError)
      : undefined;
    const cancellation = operation === "cancelled"
      ? normalizeWorkflowSafeError({
        name: "LlmAttemptCancelled",
        message: (input as CancelLlmAttemptInput).reason ??
          "LLM attempt was cancelled.",
        code: "cancelled",
      })
      : undefined;
    const changedFields = [
      ...(roles.size > 0 ? ["content"] : []),
      ...(provider !== undefined ? ["provider"] : []),
      ...(model !== undefined ? ["model"] : []),
      ...(targetStatus || requestedStatus ? ["status"] : []),
      ...(finishReason !== undefined ? ["finishReason"] : []),
      ...(usage ? ["usage"] : []),
      ...(cost ? ["cost"] : []),
      ...(targetStatus || requestedStatus === "superseded" ||
          finishedAtInput !== undefined
        ? ["finishedAt"]
        : []),
      ...(metricsFinalizedAt ? ["metricsFinalizedAt"] : []),
      ...(failure ? ["safeError"] : []),
      ...(cancellation ? ["safeError"] : []),
      ...(input.metadataPatch ? ["metadata"] : []),
    ];

    return options.coordinator.commitMutation({
      draft: {
        type: "llm_attempt." + operation,
        namespace,
        threadId: existing.threadId,
        subject: { type: "llm_attempt", id },
        payload: { llmAttemptId: id },
        delta: {
          fields: [...new Set(changedFields)].sort(),
          ...(targetStatus ? { status: targetStatus } : {}),
          ...(!targetStatus && requestedStatus
            ? { status: requestedStatus }
            : {}),
        },
        visibility: eventVisibility(input),
        routing: existing.participantId
          ? { senderId: existing.participantId }
          : {},
        ...workflowIdentityDraft(identity),
      },
      mutate: async (context) => {
        const row = await requireWorkflowNode(
          context.transaction,
          context.tables.nodes,
          namespace,
          id,
          "llm_attempt",
          true,
        );
        const previous = mapLlmAttempt(row);
        if (operation !== "updated" && TERMINAL_STATUSES.has(previous.status)) {
          throw new Error(
            "LLM attempt '" + id + "' is already '" + previous.status + "'.",
          );
        }
        const replacement = fields.length > 0
          ? await options.assets.materialize(context, {
            namespace,
            content: prepared,
            origin: {
              scope: { type: "thread", id: existing.threadId },
              producer: { type: "llm_attempt", id },
            },
          })
          : Object.freeze([]) as ContentSequence;
        const content = replaceContentRoles(
          previous.content,
          replacement,
          roles,
        );
        const status = targetStatus ?? requestedStatus ?? previous.status;
        if (
          operation === "updated" && TERMINAL_STATUSES.has(previous.status) &&
          status !== previous.status
        ) {
          throw new Error(
            "LLM attempt '" + id + "' cannot leave '" + previous.status + "'.",
          );
        }
        const finishedAt = targetStatus || status === "superseded"
          ? workflowTimestamp(finishedAtInput, "finishedAt") ??
            previous.finishedAt ?? now().toISOString()
          : workflowTimestamp(finishedAtInput, "finishedAt") ??
            previous.finishedAt;
        const data: Record<string, unknown> = {
          ...workflowRecord(row.data),
          ...(provider !== undefined ? { provider } : {}),
          ...(model !== undefined ? { model } : {}),
          status,
          content,
          ...(finishReason !== undefined ? { finishReason } : {}),
          ...(usage ? { usage } : {}),
          ...(cost ? { cost } : {}),
          ...(failure ? { safeError: failure } : {}),
          ...(cancellation ? { safeError: cancellation } : {}),
          ...(finishedAt ? { finishedAt } : {}),
          ...(metricsFinalizedAt ? { metricsFinalizedAt } : {}),
          metadata: {
            ...workflowObject(previous.metadata),
            ...workflowObject(input.metadataPatch),
          },
        };
        const name = String(
          data.participantId ?? data.agentId ?? "agent",
        ) + ":" + String(data.provider ?? "provider") + "/" +
          String(data.model ?? "model");
        const updated = await context.transaction.query<WorkflowNodeRow>(
          "UPDATE " + context.tables.nodes +
            " SET name = $1, data = $2::jsonb, updated_at = NOW()" +
            " WHERE namespace = $3 AND id = $4 AND type = 'llm_attempt'" +
            " RETURNING *",
          [name, JSON.stringify(data), namespace, id],
        );
        await options.assets.syncOwner(context, {
          namespace,
          ownerId: id,
          content,
        });
        return mapLlmAttempt(updated.rows[0]);
      },
      recoverDuplicate: async (_event, context) => {
        const current = mapLlmAttempt(
          await requireWorkflowNode(
            context.transaction,
            context.tables.nodes,
            namespace,
            id,
            "llm_attempt",
          ),
        );
        if (fields.length > 0) {
          const expected = await options.assets.resolvePrepared(context, {
            namespace,
            content: prepared,
          });
          assertRoleContentMatches(
            current.content,
            expected,
            roles,
            "LLM attempt '" + id + "'",
          );
        }
        if (targetStatus && current.status !== targetStatus) {
          throw new Error(
            "LLM attempt '" + id + "' replay expected '" + targetStatus +
              "', found '" + current.status + "'.",
          );
        }
        return current;
      },
    });
  };

  const repository: LlmAttemptRepository = {
    create(input) {
      const namespace = workflowRequiredText(input.namespace, "Namespace");
      const threadId = workflowRequiredText(input.threadId, "Thread ID");
      const id = workflowMutationId(
        "llm_attempt",
        namespace,
        input.id,
        input.identity,
        createId,
      );
      const messageId = workflowOptionalText(input.messageId, "Message ID");
      const participantId = workflowOptionalText(
        input.participantId,
        "Participant ID",
      );
      const initiatorParticipantId = workflowOptionalText(
        input.initiatorParticipantId,
        "Initiator participant ID",
      );
      const parentAttemptId = workflowOptionalText(
        input.parentAttemptId,
        "Parent attempt ID",
      );
      const provider = workflowOptionalText(input.provider, "Provider");
      const model = workflowOptionalText(input.model, "Model");
      const attemptIndex = input.attemptIndex ?? 0;
      if (!Number.isSafeInteger(attemptIndex) || attemptIndex < 0) {
        throw new TypeError("attemptIndex must be a non-negative integer.");
      }
      const inputMessageIds = uniqueText(
        input.inputMessageIds,
        "Input message ID",
      );
      const availableToolIds = uniqueText(
        input.availableToolIds,
        "Available tool ID",
      );
      const fields: RoleContentInput[] = [];
      if (input.input !== undefined) {
        fields.push({
          role: LLM_CONTENT_ROLE.input,
          input: input.input,
          cardinality: "many",
        });
      }
      if (input.toolDefinitions !== undefined) {
        fields.push({
          role: LLM_CONTENT_ROLE.toolDefinitions,
          input: input.toolDefinitions,
          cardinality: "one",
        });
      }
      if (input.trace !== undefined) {
        fields.push({
          role: LLM_CONTENT_ROLE.trace,
          input: input.trace,
          cardinality: "one",
        });
      }
      const prepared = composeRoleContent(fields);
      const startedAt = workflowTimestamp(input.startedAt, "startedAt") ??
        now().toISOString();

      return options.coordinator.commitMutation({
        draft: {
          type: "llm_attempt.created",
          namespace,
          threadId,
          subject: { type: "llm_attempt", id },
          payload: {
            llmAttemptId: id,
            attemptIndex,
            ...(provider ? { provider } : {}),
            ...(model ? { model } : {}),
          },
          routing: participantId ? { senderId: participantId } : {},
          visibility: eventVisibility(input),
          ...workflowIdentityDraft(input.identity),
        },
        mutate: async (context) => {
          await requireWorkflowNode(
            context.transaction,
            context.tables.nodes,
            namespace,
            threadId,
            "thread",
          );
          const checkMessage = async (candidateId: string) => {
            const message = await requireWorkflowNode(
              context.transaction,
              context.tables.nodes,
              namespace,
              candidateId,
              "message",
            );
            if (workflowRecord(message.data).threadId !== threadId) {
              throw new Error(
                "Message '" + candidateId + "' belongs to another thread.",
              );
            }
          };
          if (messageId) await checkMessage(messageId);
          for (const inputMessageId of inputMessageIds) {
            await checkMessage(inputMessageId);
          }
          for (const candidate of [participantId, initiatorParticipantId]) {
            if (!candidate) continue;
            await requireWorkflowNode(
              context.transaction,
              context.tables.nodes,
              namespace,
              candidate,
              "participant",
            );
          }
          if (parentAttemptId) {
            const parent = mapLlmAttempt(
              await requireWorkflowNode(
                context.transaction,
                context.tables.nodes,
                namespace,
                parentAttemptId,
                "llm_attempt",
              ),
            );
            if (parent.threadId !== threadId) {
              throw new Error(
                "Parent LLM attempt '" + parentAttemptId +
                  "' belongs to another thread.",
              );
            }
          }
          const content = fields.length > 0
            ? await options.assets.materialize(context, {
              namespace,
              content: prepared,
              origin: {
                scope: { type: "thread", id: threadId },
                producer: { type: "llm_attempt", id },
              },
            })
            : Object.freeze([]) as ContentSequence;
          const name = (participantId ?? input.agentId ?? "agent") + ":" +
            (provider ?? "provider") + "/" + (model ?? "model");
          const inserted = await context.transaction.query<WorkflowNodeRow>(
            "INSERT INTO " + context.tables.nodes +
              " (id, namespace, type, name, data, source_type, source_id)" +
              " VALUES ($1, $2, 'llm_attempt', $3, $4::jsonb," +
              " 'llm_attempt', $1) RETURNING *",
            [
              id,
              namespace,
              name,
              JSON.stringify({
                threadId,
                messageId: messageId ?? null,
                participantId: participantId ?? null,
                initiatorParticipantId: initiatorParticipantId ?? null,
                agentId: input.agentId ?? null,
                provider: provider ?? null,
                model: model ?? null,
                status: input.status ?? "running",
                attemptIndex,
                parentAttemptId: parentAttemptId ?? null,
                inputMessageIds,
                availableToolIds,
                content,
                startedAt,
                metadata: workflowObject(input.metadata),
              }),
            ],
          );
          const links = [
            { sourceId: threadId, type: "has_llm_attempt" },
            ...(messageId
              ? [{ sourceId: messageId, type: "has_llm_attempt" }]
              : []),
            ...(participantId
              ? [{ sourceId: participantId, type: "performed_by" }]
              : []),
            ...(initiatorParticipantId
              ? [{ sourceId: initiatorParticipantId, type: "initiated_by" }]
              : []),
            ...(parentAttemptId
              ? [{ sourceId: parentAttemptId, type: "has_child_attempt" }]
              : []),
          ];
          for (const link of links) {
            await insertWorkflowEdge(
              context.transaction,
              context.tables.edges,
              createId,
              {
                namespace,
                sourceId: link.sourceId,
                targetId: id,
                type: link.type,
              },
            );
          }
          if (content.length > 0) {
            await options.assets.linkOwner(context, {
              namespace,
              ownerId: id,
              content,
            });
          }
          return mapLlmAttempt(inserted.rows[0]);
        },
        recoverDuplicate: async (_event, context) => {
          const current = mapLlmAttempt(
            await requireWorkflowNode(
              context.transaction,
              context.tables.nodes,
              namespace,
              id,
              "llm_attempt",
            ),
          );
          if (fields.length > 0) {
            const expected = await options.assets.resolvePrepared(context, {
              namespace,
              content: prepared,
            });
            assertRoleContentMatches(
              current.content,
              expected,
              new Set(expected.map((ref) => ref.role)),
              "LLM attempt '" + id + "'",
            );
          }
          if (
            current.threadId !== threadId ||
            current.attemptIndex !== attemptIndex ||
            current.parentAttemptId !== parentAttemptId
          ) {
            throw new Error(
              "LLM attempt '" + id + "' deduplication identity was reused.",
            );
          }
          return current;
        },
      });
    },
    update(input) {
      return transition("updated", input);
    },
    complete(input) {
      return transition("completed", input);
    },
    fail(input) {
      return transition("failed", input);
    },
    cancel(input) {
      return transition("cancelled", input);
    },
    async get(namespaceInput, idInput) {
      return await read(
        workflowRequiredText(namespaceInput, "Namespace"),
        workflowRequiredText(idInput, "LLM attempt ID"),
      );
    },
    async list(namespaceInput, threadIdInput, listOptions = {}) {
      const namespace = workflowRequiredText(namespaceInput, "Namespace");
      const threadId = workflowRequiredText(threadIdInput, "Thread ID");
      const params: unknown[] = [namespace, threadId];
      let afterFilter = "";
      if (listOptions.after?.trim()) {
        const cursor = await options.session.query<{
          position: string | number | bigint;
        }>(
          "SELECT position FROM " + names.events +
            " WHERE namespace = $1 AND thread_id = $2" +
            " AND type = 'llm_attempt.created'" +
            " AND subject_type = 'llm_attempt' AND subject_id = $3 LIMIT 1",
          [namespace, threadId, listOptions.after.trim()],
        );
        if (!cursor.rows[0]) {
          throw new Error(
            "LLM attempt cursor '" + listOptions.after + "' was not found.",
          );
        }
        params.push(String(cursor.rows[0].position));
        afterFilter = "AND event.position > $" + params.length + "::bigint";
      }
      params.push(boundedLimit(listOptions.limit));
      const result = await options.session.query<WorkflowNodeRow>(
        "SELECT attempt.* FROM " + names.nodes + " attempt" +
          " JOIN " + names.events + " event" +
          " ON event.namespace = attempt.namespace" +
          " AND event.subject_type = 'llm_attempt'" +
          " AND event.subject_id = attempt.id" +
          " AND event.type = 'llm_attempt.created'" +
          " WHERE attempt.namespace = $1 AND attempt.type = 'llm_attempt'" +
          " AND event.thread_id = $2 " + afterFilter +
          " ORDER BY event.position LIMIT $" + params.length,
        params,
      );
      return Object.freeze(result.rows.map(mapLlmAttempt));
    },
  };

  return Object.freeze(repository);
}
