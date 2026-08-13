import { ulid } from "../../dependencies/ulid.ts";
import type { ContentSequence } from "../content/index.ts";
import type { EventVisibility } from "../events/index.ts";
import { cloneContentRef } from "../content/input.ts";
import type {
  CancelToolExecutionInput,
  CompleteToolExecutionInput,
  CreateToolExecutionRepositoryOptions,
  FailToolExecutionInput,
  ToolExecution,
  ToolExecutionRepository,
  ToolExecutionStatus,
  UpdateToolExecutionInput,
} from "./workflow-types.ts";
import { TOOL_CONTENT_ROLE } from "./workflow-types.ts";
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
  workflowTimestamp,
} from "./workflow-support.ts";
import type { MutationIdentity } from "./types.ts";

const ATTACHMENT_ROLE = "attachment";
const TERMINAL_STATUSES = new Set<ToolExecutionStatus>([
  "completed",
  "failed",
  "cancelled",
]);

function toolStatus(value: unknown): ToolExecutionStatus {
  if (
    value === "pending" || value === "running" || value === "completed" ||
    value === "failed" || value === "cancelled"
  ) return value;
  throw new Error(
    `Stored tool execution has invalid status '${String(value)}'.`,
  );
}

function normalizedContent(value: unknown): ContentSequence {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(value.map((ref) => cloneContentRef(ref)));
}

function mapToolExecution(row: WorkflowNodeRow): ToolExecution {
  const data = workflowRecord(row.data);
  const threadId = typeof data.threadId === "string" ? data.threadId : "";
  const toolCallId = typeof data.toolCallId === "string" ? data.toolCallId : "";
  if (!threadId || !toolCallId) {
    throw new Error(`Tool execution '${row.id}' has invalid identity fields.`);
  }
  const tool = workflowObject(data.tool);
  if (typeof tool.id !== "string" || !tool.id.trim()) {
    throw new Error(`Tool execution '${row.id}' has no tool ID.`);
  }
  const startedAt = typeof data.startedAt === "string"
    ? data.startedAt
    : workflowIso(row.created_at);
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
    ...(typeof data.agentId === "string" ? { agentId: data.agentId } : {}),
    toolCallId,
    tool,
    status: toolStatus(data.status),
    content: normalizedContent(data.content),
    ...(typeof data.historyVisibility === "string"
      ? { historyVisibility: data.historyVisibility }
      : {}),
    ...(mapWorkflowSafeError(data.safeError)
      ? { safeError: mapWorkflowSafeError(data.safeError) }
      : {}),
    startedAt,
    ...(typeof data.finishedAt === "string"
      ? { finishedAt: data.finishedAt }
      : {}),
    ...(typeof data.durationMs === "number"
      ? { durationMs: data.durationMs }
      : {}),
    metadata: workflowObject(data.metadata),
    createdAt: workflowIso(row.created_at),
    updatedAt: workflowIso(row.updated_at),
  });
}

function boundedLimit(value: number | undefined): number {
  if (value === undefined) return 100;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("Tool execution limit must be a positive integer.");
  }
  return Math.min(value, 1_000);
}

function callSourceId(threadId: string, toolCallId: string): string {
  return JSON.stringify([threadId, toolCallId]);
}

function identityWithDefault(
  identity: MutationIdentity | undefined,
  deduplicationId: string | undefined,
): MutationIdentity | undefined {
  if (identity?.deduplicationId || !deduplicationId) return identity;
  return { ...identity, deduplicationId };
}

type TransitionInput =
  | UpdateToolExecutionInput
  | CompleteToolExecutionInput
  | FailToolExecutionInput
  | CancelToolExecutionInput;

type TransitionOperation = "updated" | "completed" | "failed" | "cancelled";

function transitionFields(
  input: TransitionInput,
): { fields: RoleContentInput[]; roles: Set<string> } {
  const fields: RoleContentInput[] = [];
  const roles = new Set<string>();
  const add = (
    role: string,
    value: unknown,
    cardinality: "one" | "many" = "one",
  ) => {
    if (value === undefined) return;
    fields.push({
      role,
      input: value as RoleContentInput["input"],
      cardinality,
    });
    roles.add(role);
  };
  if ("output" in input) add(TOOL_CONTENT_ROLE.output, input.output);
  if ("projectedOutput" in input) {
    add(TOOL_CONTENT_ROLE.projectedOutput, input.projectedOutput);
  }
  if ("errorDetail" in input) {
    add(TOOL_CONTENT_ROLE.errorDetail, input.errorDetail);
  }
  if ("attachments" in input) {
    add(ATTACHMENT_ROLE, input.attachments, "many");
  }
  return { fields, roles };
}

function transitionStatus(
  operation: TransitionOperation,
  input: TransitionInput,
  previous: ToolExecutionStatus,
): ToolExecutionStatus {
  if (operation === "completed") return "completed";
  if (operation === "failed") return "failed";
  if (operation === "cancelled") return "cancelled";
  return "status" in input && input.status ? input.status : previous;
}

function eventVisibility(
  input: { visibility?: EventVisibility },
  participantId: string | undefined,
  historyVisibility: string | undefined,
): EventVisibility {
  if (input.visibility) return input.visibility;
  if (!participantId) return { kind: "internal" };
  const policy = historyVisibility === "requester_only" ||
      historyVisibility === "public"
    ? historyVisibility
    : "public_status";
  return { kind: "tool", policy, requesterId: participantId };
}

function toolName(tool: Readonly<Record<string, unknown>>): string | undefined {
  return typeof tool.name === "string" && tool.name.trim()
    ? tool.name.trim()
    : undefined;
}

/** Creates typed graph-native tool execution lifecycle operations. */
export function createToolExecutionRepository(
  options: CreateToolExecutionRepositoryOptions,
): ToolExecutionRepository {
  const createId = options.createId ?? ulid;
  const now = options.now ?? (() => new Date());
  const names = options.eventStore.tables;

  const read = async (namespace: string, id: string) => {
    const row = await findWorkflowNode(
      options.session,
      names.nodes,
      namespace,
      id,
      "tool_execution",
    );
    return row ? mapToolExecution(row) : null;
  };

  const transition = async (
    operation: TransitionOperation,
    input: TransitionInput,
  ) => {
    const namespace = workflowRequiredText(input.namespace, "Namespace");
    const id = workflowRequiredText(input.id, "Tool execution ID");
    const existing = await read(namespace, id);
    if (!existing) throw new Error(`tool_execution '${id}' was not found.`);
    const targetStatus = operation === "updated"
      ? undefined
      : operation as Exclude<TransitionOperation, "updated">;
    const identity = identityWithDefault(
      input.identity,
      targetStatus ? `tool_execution:${id}:${operation}` : undefined,
    );
    const { fields, roles } = transitionFields(input);
    const prepared = composeRoleContent(fields);
    const historyVisibility = "historyVisibility" in input
      ? input.historyVisibility
      : undefined;
    const finishedAtInput = "finishedAt" in input
      ? input.finishedAt
      : undefined;
    const failure = operation === "failed"
      ? (input as FailToolExecutionInput).safeError
      : undefined;
    const cancellationReason = operation === "cancelled"
      ? (input as CancelToolExecutionInput).reason
      : undefined;
    const safeError = operation === "failed"
      ? normalizeWorkflowSafeError(failure!)
      : operation === "cancelled" && cancellationReason
      ? normalizeWorkflowSafeError({
        name: "ToolExecutionCancelled",
        message: cancellationReason,
        code: "cancelled",
      })
      : undefined;
    const status = transitionStatus(operation, input, existing.status);
    const existingToolId = typeof existing.tool.id === "string"
      ? workflowRequiredText(existing.tool.id, "Tool ID")
      : (() => {
        throw new Error(`Tool execution '${id}' has no tool ID.`);
      })();
    const existingToolName = toolName(existing.tool);
    const changedFields = [
      ...(roles.size > 0 ? ["content"] : []),
      ...(targetStatus || ("status" in input && input.status)
        ? ["status"]
        : []),
      ...(historyVisibility !== undefined ? ["historyVisibility"] : []),
      ...(input.metadataPatch ? ["metadata"] : []),
      ...(operation === "failed" ? ["safeError"] : []),
      ...(targetStatus || finishedAtInput !== undefined ? ["finishedAt"] : []),
      ...("durationMs" in input && input.durationMs !== undefined
        ? ["durationMs"]
        : []),
    ];

    return options.coordinator.commitMutation({
      draft: {
        type: `tool_execution.${operation}`,
        namespace,
        threadId: existing.threadId,
        subject: { type: "tool_execution", id },
        payload: {
          toolExecutionId: id,
          toolCallId: existing.toolCallId,
          toolId: existingToolId,
          ...(existingToolName ? { toolName: existingToolName } : {}),
          status,
          ...(safeError ? { safeError } : {}),
        },
        delta: {
          fields: [...new Set(changedFields)].sort(),
          ...(targetStatus ? { status: targetStatus } : {}),
        },
        visibility: eventVisibility(
          input,
          existing.participantId,
          historyVisibility ?? existing.historyVisibility,
        ),
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
          "tool_execution",
          true,
        );
        const previous = mapToolExecution(row);
        if (operation !== "updated" && TERMINAL_STATUSES.has(previous.status)) {
          throw new Error(
            `Tool execution '${id}' is already '${previous.status}'.`,
          );
        }
        const replacement = fields.length > 0
          ? await options.assets.materialize(context, {
            namespace,
            content: prepared,
          })
          : Object.freeze([]) as ContentSequence;
        const content = replaceContentRoles(
          previous.content,
          replacement,
          roles,
        );
        const status = transitionStatus(operation, input, previous.status);
        if (
          operation === "updated" && TERMINAL_STATUSES.has(previous.status) &&
          status !== previous.status
        ) {
          throw new Error(
            `Tool execution '${id}' cannot leave '${previous.status}'.`,
          );
        }
        const finishedAt = operation === "updated"
          ? workflowTimestamp(finishedAtInput, "finishedAt") ??
            previous.finishedAt
          : workflowTimestamp(finishedAtInput, "finishedAt") ??
            now().toISOString();
        const durationMs = "durationMs" in input &&
            input.durationMs !== undefined
          ? input.durationMs
          : previous.durationMs;
        if (
          durationMs !== undefined &&
          (!Number.isFinite(durationMs) || durationMs < 0)
        ) {
          throw new TypeError("durationMs must be a non-negative number.");
        }
        const data = {
          ...workflowRecord(row.data),
          status,
          content,
          ...(historyVisibility !== undefined
            ? {
              historyVisibility: workflowOptionalText(
                historyVisibility,
                "historyVisibility",
              ) ?? null,
            }
            : {}),
          ...(safeError ? { safeError } : {}),
          ...(finishedAt ? { finishedAt } : {}),
          ...(durationMs !== undefined ? { durationMs } : {}),
          metadata: {
            ...workflowObject(previous.metadata),
            ...workflowObject(input.metadataPatch),
          },
        };
        const updated = await context.transaction.query<WorkflowNodeRow>(
          `UPDATE ${context.tables.nodes}
           SET data = $1::jsonb, updated_at = NOW()
           WHERE namespace = $2 AND id = $3 AND type = 'tool_execution'
           RETURNING *`,
          [JSON.stringify(data), namespace, id],
        );
        await options.assets.syncOwner(context, {
          namespace,
          ownerId: id,
          content,
        });
        return mapToolExecution(updated.rows[0]);
      },
      recoverDuplicate: async (_event, context) => {
        const current = mapToolExecution(
          await requireWorkflowNode(
            context.transaction,
            context.tables.nodes,
            namespace,
            id,
            "tool_execution",
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
            `Tool execution '${id}'`,
          );
        }
        if (targetStatus && current.status !== targetStatus) {
          throw new Error(
            `Tool execution '${id}' replay expected '${targetStatus}', found '${current.status}'.`,
          );
        }
        return current;
      },
    });
  };

  const repository: ToolExecutionRepository = {
    create(input) {
      const namespace = workflowRequiredText(input.namespace, "Namespace");
      const threadId = workflowRequiredText(input.threadId, "Thread ID");
      const toolCallId = workflowRequiredText(input.toolCallId, "Tool call ID");
      const messageId = workflowOptionalText(input.messageId, "Message ID");
      const tool = workflowObject(input.tool);
      const toolId = typeof tool.id === "string"
        ? workflowRequiredText(tool.id, "Tool ID")
        : (() => {
          throw new TypeError("Tool ID must be a non-empty string.");
        })();
      const identity = identityWithDefault(
        input.identity,
        `tool_execution:create:${
          input.id?.trim() || (messageId
            ? JSON.stringify([threadId, messageId, toolCallId])
            : callSourceId(threadId, toolCallId))
        }`,
      );
      const id = workflowMutationId(
        "tool_execution",
        namespace,
        input.id,
        identity,
        createId,
      );
      const fields: RoleContentInput[] = [{
        role: TOOL_CONTENT_ROLE.arguments,
        input: input.arguments,
        cardinality: "one",
      }];
      if (input.attachments !== undefined) {
        fields.push({
          role: ATTACHMENT_ROLE,
          input: input.attachments,
          cardinality: "many",
        });
      }
      const prepared = composeRoleContent(fields);
      const participantId = workflowOptionalText(
        input.participantId,
        "Participant ID",
      );
      const startedAt = workflowTimestamp(input.startedAt, "startedAt") ??
        now().toISOString();
      const status = input.status ?? "running";
      const sourceId = callSourceId(threadId, toolCallId);
      const name = toolName(tool);

      return options.coordinator.commitMutation({
        draft: {
          type: "tool_execution.created",
          namespace,
          threadId,
          subject: { type: "tool_execution", id },
          payload: {
            toolExecutionId: id,
            toolCallId,
            toolId,
            ...(name ? { toolName: name } : {}),
            status,
          },
          routing: participantId ? { senderId: participantId } : {},
          visibility: eventVisibility(
            input,
            participantId,
            input.historyVisibility,
          ),
          ...workflowIdentityDraft(identity),
        },
        mutate: async (context) => {
          await requireWorkflowNode(
            context.transaction,
            context.tables.nodes,
            namespace,
            threadId,
            "thread",
          );
          if (messageId) {
            const message = await requireWorkflowNode(
              context.transaction,
              context.tables.nodes,
              namespace,
              messageId,
              "message",
            );
            if (workflowRecord(message.data).threadId !== threadId) {
              throw new Error(
                `Message '${messageId}' belongs to another thread.`,
              );
            }
          }
          if (participantId) {
            await requireWorkflowNode(
              context.transaction,
              context.tables.nodes,
              namespace,
              participantId,
              "participant",
            );
          }
          const content = await options.assets.materialize(context, {
            namespace,
            content: prepared,
          });
          const inserted = await context.transaction.query<WorkflowNodeRow>(
            `INSERT INTO ${context.tables.nodes} (
               id, namespace, type, name, data, source_type, source_id
             ) VALUES ($1, $2, 'tool_execution', $3, $4::jsonb,
                       'tool_call', $5)
             RETURNING *`,
            [
              id,
              namespace,
              typeof tool.name === "string" ? tool.name : toolId,
              JSON.stringify({
                threadId,
                messageId: messageId ?? null,
                participantId: participantId ?? null,
                agentId: input.agentId ?? null,
                toolCallId,
                tool,
                status,
                content,
                historyVisibility: input.historyVisibility ?? null,
                startedAt,
                metadata: workflowObject(input.metadata),
              }),
              sourceId,
            ],
          );
          await insertWorkflowEdge(
            context.transaction,
            context.tables.edges,
            createId,
            {
              namespace,
              sourceId: threadId,
              targetId: id,
              type: "has_tool_execution",
            },
          );
          if (messageId) {
            await insertWorkflowEdge(
              context.transaction,
              context.tables.edges,
              createId,
              {
                namespace,
                sourceId: messageId,
                targetId: id,
                type: "has_tool_execution",
              },
            );
          }
          if (participantId) {
            await insertWorkflowEdge(
              context.transaction,
              context.tables.edges,
              createId,
              {
                namespace,
                sourceId: participantId,
                targetId: id,
                type: "performed_by",
              },
            );
          }
          await options.assets.linkOwner(context, {
            namespace,
            ownerId: id,
            content,
          });
          return mapToolExecution(inserted.rows[0]);
        },
        recoverDuplicate: async (_event, context) => {
          const current = mapToolExecution(
            await requireWorkflowNode(
              context.transaction,
              context.tables.nodes,
              namespace,
              id,
              "tool_execution",
            ),
          );
          const expected = await options.assets.resolvePrepared(context, {
            namespace,
            content: prepared,
          });
          const expectedRoles = new Set(expected.map((ref) => ref.role));
          assertRoleContentMatches(
            current.content,
            expected,
            expectedRoles,
            `Tool execution '${id}'`,
          );
          if (
            current.threadId !== threadId ||
            current.toolCallId !== toolCallId ||
            String(current.tool.id) !== toolId
          ) {
            throw new Error(
              `Tool execution '${id}' deduplication identity was reused.`,
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
        workflowRequiredText(idInput, "Tool execution ID"),
      );
    },
    async getByToolCallId(namespaceInput, threadIdInput, toolCallIdInput) {
      const namespace = workflowRequiredText(namespaceInput, "Namespace");
      const threadId = workflowRequiredText(threadIdInput, "Thread ID");
      const toolCallId = workflowRequiredText(toolCallIdInput, "Tool call ID");
      const result = await options.session.query<WorkflowNodeRow>(
        `SELECT * FROM ${names.nodes}
         WHERE namespace = $1 AND type = 'tool_execution'
           AND source_type = 'tool_call' AND source_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [namespace, callSourceId(threadId, toolCallId)],
      );
      return result.rows[0] ? mapToolExecution(result.rows[0]) : null;
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
          `SELECT position FROM ${names.events}
           WHERE namespace = $1 AND thread_id = $2
             AND type = 'tool_execution.created'
             AND subject_type = 'tool_execution' AND subject_id = $3
           LIMIT 1`,
          [namespace, threadId, listOptions.after.trim()],
        );
        if (!cursor.rows[0]) {
          throw new Error(
            `Tool execution cursor '${listOptions.after}' was not found.`,
          );
        }
        params.push(String(cursor.rows[0].position));
        afterFilter = `AND event.position > $${params.length}::bigint`;
      }
      params.push(boundedLimit(listOptions.limit));
      const result = await options.session.query<WorkflowNodeRow>(
        `SELECT execution.* FROM ${names.nodes} execution
         JOIN ${names.events} event
           ON event.namespace = execution.namespace
          AND event.subject_type = 'tool_execution'
          AND event.subject_id = execution.id
          AND event.type = 'tool_execution.created'
         WHERE execution.namespace = $1 AND execution.type = 'tool_execution'
           AND event.thread_id = $2 ${afterFilter}
         ORDER BY event.position LIMIT $${params.length}`,
        params,
      );
      return Object.freeze(result.rows.map(mapToolExecution));
    },
  };

  return Object.freeze(repository);
}
