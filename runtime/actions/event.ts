import type {
  ActionEventData,
  ActionStatus,
  AnyActionDefinition,
} from "./types.ts";

const ACTION_STATUSES = Object.freeze(
  [
    "invoked",
    "progress",
    "completed",
    "failed",
    "cancelled",
  ] as const satisfies readonly ActionStatus[],
);

const ACTION_STATUS_SET = new Set<ActionStatus>(ACTION_STATUSES);
const BASE_DATA_KEYS = Object.freeze(
  [
    "actionId",
    "actionRunId",
    "input",
    "metadata",
    "status",
  ] as const,
);

export type ParseActionLifecycleEventOptions = Readonly<{
  /** Require the lifecycle to belong to this stable Action id. */
  actionId?: string;
  /** Restrict the accepted lifecycle statuses. */
  statuses?: readonly ActionStatus[];
  /** Reject nested Action lifecycles carrying parentActionRunId. */
  requireRoot?: boolean;
}>;

type ActionLifecycleEventCandidate = Readonly<{
  durable: unknown;
  type: unknown;
  namespace?: unknown;
  subject?: unknown;
  payload?: unknown;
  metadata: unknown;
  deduplicationId?: unknown;
  data?: unknown;
}>;

function dataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const names = Object.getOwnPropertyNames(value);
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor?.enumerable || !("value" in descriptor)) return null;
  }
  return value as Record<string, unknown>;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index]);
}

function nonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function strictJsonValue(
  value: unknown,
  ancestors: WeakSet<object>,
): boolean {
  if (
    value === null || typeof value === "string" || typeof value === "boolean"
  ) return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (!value || typeof value !== "object" || ancestors.has(value)) return false;
  if (Object.getOwnPropertySymbols(value).length > 0) return false;

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Object.keys(value);
      if (
        keys.length !== value.length ||
        keys.some((key, index) => key !== String(index))
      ) return false;
      return value.every((child) => strictJsonValue(child, ancestors));
    }
    const record = dataRecord(value);
    if (!record) return false;
    return Object.values(record).every((child) =>
      strictJsonValue(child, ancestors)
    );
  } finally {
    ancestors.delete(value);
  }
}

function strictJsonObject(value: unknown): value is Record<string, unknown> {
  return dataRecord(value) !== null &&
    strictJsonValue(value, new WeakSet<object>());
}

function statusKeys(status: ActionStatus, nested: boolean): readonly string[] {
  const base = nested
    ? [...BASE_DATA_KEYS, "parentActionRunId"]
    : BASE_DATA_KEYS;
  switch (status) {
    case "invoked":
      return base;
    case "progress":
      return [...base, "progress", "progressIndex"];
    case "completed":
      return [...base, "output"];
    case "failed":
    case "cancelled":
      return [...base, "error"];
  }
}

function validStatusConfiguration(
  statuses: readonly ActionStatus[] | undefined,
): ReadonlySet<ActionStatus> | null {
  if (!statuses) return ACTION_STATUS_SET;
  if (
    statuses.length === 0 ||
    statuses.some((status) => !ACTION_STATUS_SET.has(status))
  ) return null;
  return new Set(statuses);
}

function lifecycleDeduplicationId(
  actionRunId: string,
  status: ActionStatus,
  progressIndex?: number,
): string {
  if (status === "invoked") return `${actionRunId}:action:invoked`;
  if (status === "progress") {
    return `${actionRunId}:action:progress:${String(progressIndex)}`;
  }
  return `${actionRunId}:action:terminal`;
}

/**
 * Validates one runtime-resolved durable Action lifecycle Event.
 *
 * The raw EventBody ref is bound to namespace and semantic deduplication ID,
 * while the resolved body is cross-checked against its envelope coordinates.
 * Callers must supply the resolved `data` paired with the raw Event `payload`,
 * as Processor Events and the runtime Action receipt loader do.
 */
export function parseActionLifecycleEvent(
  event: ActionLifecycleEventCandidate,
  options: ParseActionLifecycleEventOptions = {},
): ActionEventData | null {
  if (!event || event.durable !== true) return null;
  const lifecycle = dataRecord(event.data);
  const subject = dataRecord(event.subject);
  const payload = dataRecord(event.payload);
  const dataRef = dataRecord(payload?.dataRef);
  const envelopeMetadata = dataRecord(event.metadata);
  if (
    !lifecycle || !subject || !payload || !dataRef || !envelopeMetadata
  ) return null;

  const status = lifecycle.status;
  if (
    typeof status !== "string" || !ACTION_STATUS_SET.has(status as ActionStatus)
  ) {
    return null;
  }
  const actionStatus = status as ActionStatus;
  const acceptedStatuses = validStatusConfiguration(options.statuses);
  if (!acceptedStatuses?.has(actionStatus)) return null;

  const actionId = lifecycle.actionId;
  const actionRunId = lifecycle.actionRunId;
  if (!nonEmptyText(actionId) || actionId !== actionId.trim()) return null;
  if (!nonEmptyText(actionRunId) || actionRunId !== actionRunId.trim()) {
    return null;
  }
  if (options.actionId !== undefined && actionId !== options.actionId) {
    return null;
  }

  const hasParent = Object.prototype.hasOwnProperty.call(
    lifecycle,
    "parentActionRunId",
  );
  if (options.requireRoot && hasParent) return null;
  if (
    hasParent &&
    (!nonEmptyText(lifecycle.parentActionRunId) ||
      lifecycle.parentActionRunId !== lifecycle.parentActionRunId.trim())
  ) return null;
  if (!hasExactKeys(lifecycle, statusKeys(actionStatus, hasParent))) {
    return null;
  }
  if (!strictJsonObject(lifecycle.metadata)) return null;
  if (
    actionStatus === "progress" &&
    (!Number.isSafeInteger(lifecycle.progressIndex) ||
      Number(lifecycle.progressIndex) < 1)
  ) return null;

  const namespace = event.namespace;
  const deduplicationId = event.deduplicationId;
  const expectedDeduplicationId = lifecycleDeduplicationId(
    actionRunId,
    actionStatus,
    actionStatus === "progress" ? lifecycle.progressIndex as number : undefined,
  );
  if (
    !nonEmptyText(namespace) || namespace !== namespace.trim() ||
    !nonEmptyText(deduplicationId) ||
    deduplicationId !== expectedDeduplicationId ||
    !hasExactKeys(payload, ["dataRef"]) ||
    !hasExactKeys(dataRef, ["eventBodyId", "mediaType", "schemaVersion"]) ||
    dataRef.eventBodyId !==
      `event-body:${namespace}:${deduplicationId}` ||
    dataRef.schemaVersion !== 1 || dataRef.mediaType !== "application/json"
  ) return null;

  if (
    event.type !== `${actionId}.${actionStatus}` ||
    !hasExactKeys(subject, ["id", "type"]) ||
    subject.type !== actionId || subject.id !== actionRunId ||
    !strictJsonObject(envelopeMetadata) ||
    envelopeMetadata.actionId !== actionId ||
    envelopeMetadata.actionStatus !== actionStatus
  ) return null;

  if (actionStatus === "failed" || actionStatus === "cancelled") {
    const error = dataRecord(lifecycle.error);
    if (
      !error || !hasExactKeys(error, ["message", "name"]) ||
      !nonEmptyText(error.name) || error.name !== error.name.trim() ||
      !nonEmptyText(error.message) || error.message !== error.message.trim()
    ) return null;
  }

  return lifecycle as ActionEventData;
}

/** True only for a registered Action's exact runtime-owned lifecycle type. */
export function isRegisteredActionLifecycleEventType(
  eventType: string,
  actions: Readonly<Record<string, AnyActionDefinition>>,
): boolean {
  const normalized = eventType.trim();
  return Object.values(actions).some((action) =>
    ACTION_STATUSES.some((status) => normalized === `${action.id}.${status}`)
  );
}

/** True only for the private semantic identities used by Action receipts. */
export function isReservedActionLifecycleDeduplicationId(
  deduplicationId: string | undefined,
): boolean {
  const normalized = deduplicationId?.trim() ?? "";
  return /^.+:action:(?:invoked|terminal|progress:[1-9][0-9]*)$/.test(
    normalized,
  );
}
