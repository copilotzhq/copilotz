import type { SqlExecutor } from "../events/index.ts";
import type { MutationIdentity } from "./types.ts";
import type { SafeWorkflowError } from "./workflow-types.ts";

export type WorkflowNodeRow = Record<string, unknown> & {
  id: string;
  namespace: string;
  type: string;
  name: string;
  content: string | null;
  data: unknown;
  source_type: string | null;
  source_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export function workflowIso(value: string | Date): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}

export function workflowRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return workflowRecord(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function workflowObject(value: unknown): Record<string, unknown> {
  return structuredClone(workflowRecord(value));
}

export function mapWorkflowSafeError(
  value: unknown,
): SafeWorkflowError | undefined {
  const fields = workflowRecord(value);
  if (Object.keys(fields).length === 0) return undefined;
  if (typeof fields.message !== "string" || !fields.message.trim()) {
    throw new Error("Stored workflow record has an invalid safe error.");
  }
  return workflowDeepFreeze({
    ...(typeof fields.name === "string" ? { name: fields.name } : {}),
    message: fields.message,
    ...(typeof fields.code === "string" ? { code: fields.code } : {}),
    ...(typeof fields.retryable === "boolean"
      ? { retryable: fields.retryable }
      : {}),
    ...(fields.metadata ? { metadata: workflowObject(fields.metadata) } : {}),
  });
}

export function normalizeWorkflowSafeError(
  value: SafeWorkflowError,
): SafeWorkflowError {
  const message = workflowRequiredText(value.message, "Safe error message");
  return workflowDeepFreeze({
    ...(workflowOptionalText(value.name, "Safe error name")
      ? { name: value.name!.trim() }
      : {}),
    message,
    ...(workflowOptionalText(value.code, "Safe error code")
      ? { code: value.code!.trim() }
      : {}),
    ...(value.retryable !== undefined ? { retryable: value.retryable } : {}),
    ...(value.metadata ? { metadata: workflowObject(value.metadata) } : {}),
  });
}

export function workflowRequiredText(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} must be non-empty.`);
  return normalized;
}

export function workflowOptionalText(
  value: string | null | undefined,
  name: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  return workflowRequiredText(value, name);
}

export function workflowTimestamp(
  value: string | Date | null | undefined,
  name: string,
): string | undefined {
  if (value === null || value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${name} must be a valid timestamp.`);
  }
  return date.toISOString();
}

export function workflowDeepFreeze<T>(value: T): T {
  if (
    value && typeof value === "object" && !ArrayBuffer.isView(value) &&
    !Object.isFrozen(value)
  ) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      workflowDeepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

export function workflowMutationId(
  kind: string,
  namespace: string,
  explicit: string | undefined,
  identity: MutationIdentity | undefined,
  createId: () => string,
): string {
  if (explicit?.trim()) return explicit.trim();
  if (identity?.deduplicationId?.trim()) {
    return `${namespace}:${kind}:${identity.deduplicationId.trim()}`;
  }
  return createId();
}

export function workflowIdentityDraft(identity: MutationIdentity | undefined) {
  return {
    ...(identity?.causationId ? { causationId: identity.causationId } : {}),
    ...(identity?.correlationId
      ? { correlationId: identity.correlationId }
      : {}),
    ...(identity?.deduplicationId
      ? { deduplicationId: identity.deduplicationId }
      : {}),
    metadata: structuredClone(identity?.metadata ?? {}),
  };
}

export function workflowCanonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, child]) => [key, normalize(child)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(value));
}

export async function findWorkflowNode(
  transaction: SqlExecutor,
  table: string,
  namespace: string,
  id: string,
  type: string,
  lock = false,
): Promise<WorkflowNodeRow | null> {
  const result = await transaction.query<WorkflowNodeRow>(
    `SELECT * FROM ${table}
     WHERE namespace = $1 AND id = $2 AND type = $3 LIMIT 1${
      lock ? " FOR UPDATE" : ""
    }`,
    [namespace, id, type],
  );
  return result.rows[0] ?? null;
}

export async function requireWorkflowNode(
  transaction: SqlExecutor,
  table: string,
  namespace: string,
  id: string,
  type: string,
  lock = false,
): Promise<WorkflowNodeRow> {
  const row = await findWorkflowNode(
    transaction,
    table,
    namespace,
    id,
    type,
    lock,
  );
  if (!row) throw new Error(`${type} '${id}' was not found.`);
  return row;
}

export async function insertWorkflowEdge(
  transaction: SqlExecutor,
  edges: string,
  createId: () => string,
  input: {
    namespace: string;
    sourceId: string;
    targetId: string;
    type: string;
  },
): Promise<void> {
  await transaction.query(
    `INSERT INTO ${edges} (
       id, namespace, source_node_id, target_node_id, type, data, weight
     ) VALUES ($1, $2, $3, $4, $5, '{}', 1)
     ON CONFLICT DO NOTHING`,
    [
      createId(),
      input.namespace,
      input.sourceId,
      input.targetId,
      input.type,
    ],
  );
}

export function workflowStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([]);
  return Object.freeze(
    value.filter((item): item is string =>
      typeof item === "string" && item.length > 0
    ),
  );
}
