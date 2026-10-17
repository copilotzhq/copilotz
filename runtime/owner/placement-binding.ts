/** Inert canonical owner placement data. No storage, transport or authority. */
type OwnerAssignmentBase = Readonly<{
  placement: "worker";
  workerId: string;
  workerAttemptId: string;
  sessionGeneration: number;
  sessionId: string;
  parentOperationId: string;
  assignmentId: string;
  dispatchAttemptId: string;
  namespace: string;
  sourceEventId: string;
  deliveryId: string;
}>;
export type OwnerActionAssignmentBinding =
  & OwnerAssignmentBase
  & Readonly<{
    actionId: string;
    executionId: string;
  }>;
export type OwnerProcessorAssignmentBinding =
  & OwnerAssignmentBase
  & Readonly<{
    kind: "processor";
    processorId: string;
  }>;
/** Worker-only: a local reservation must never reach a Started API. */
export type OwnerAssignmentBinding =
  | OwnerActionAssignmentBinding
  | OwnerProcessorAssignmentBinding;
type OwnerLocalAssignmentBase = Readonly<{
  placement: "owner-local";
  ownerId: string;
  epoch: number;
  holderId: string;
  attemptId: string;
  namespace: string;
  sourceEventId: string;
  deliveryId: string;
}>;
export type OwnerLocalActionAssignmentBinding =
  & OwnerLocalAssignmentBase
  & Readonly<{
    kind: "action";
    actionId: string;
    actionRunId: string;
  }>;
export type OwnerLocalProcessorAssignmentBinding =
  & OwnerLocalAssignmentBase
  & Readonly<{
    kind: "processor";
    processorId: string;
    consumerId: string;
  }>;
export type OwnerLocalAssignmentBinding =
  | OwnerLocalActionAssignmentBinding
  | OwnerLocalProcessorAssignmentBinding;
export type OwnerPlacementBinding =
  | OwnerAssignmentBinding
  | OwnerLocalAssignmentBinding;
export function isOwnerProcessorAssignmentBinding(
  value: OwnerAssignmentBinding,
): value is OwnerProcessorAssignmentBinding {
  return "kind" in value && value.kind === "processor";
}
function identifier(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value || value !== value.trim() ||
    value.length > 1024
  ) {
    throw new TypeError("Invalid assignment identifier.");
  }
}
export const OWNER_ASSIGNMENT_BINDING_MAX_BYTES = 16_384;
const workerFields = [
  "placement",
  "workerId",
  "workerAttemptId",
  "sessionGeneration",
  "sessionId",
  "parentOperationId",
  "assignmentId",
  "dispatchAttemptId",
  "namespace",
  "sourceEventId",
  "deliveryId",
] as const;
const localFields = [
  "placement",
  "ownerId",
  "epoch",
  "holderId",
  "attemptId",
  "namespace",
  "sourceEventId",
  "deliveryId",
  "kind",
] as const;
/** Closed, exact and detached. Stored JSON and private callback facts use the
 * same decoder; missing tags, coercion and foreign placement fields fail closed. */
function assignmentRecord(value: unknown): Record<string, unknown> {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new TypeError("Invalid owner assignment record.");
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const entries: [string, unknown][] = [];
  for (const key of Reflect.ownKeys(descriptors)) {
    const descriptor = typeof key === "string" ? descriptors[key] : undefined;
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
      throw new TypeError("Invalid owner assignment record property.");
    }
    entries.push([key as string, descriptor.value]);
  }
  return Object.fromEntries(entries);
}
export function parseOwnerPlacementBinding(
  value: unknown,
): OwnerPlacementBinding {
  const input = assignmentRecord(value);
  let fields: readonly string[];
  if (input.placement === "worker") {
    if (Object.hasOwn(input, "kind") && input.kind !== "processor") {
      throw new TypeError("Invalid worker assignment target.");
    }
    fields = [
      ...workerFields,
      ...(input.kind === "processor"
        ? ["kind", "processorId"]
        : ["actionId", "executionId"]),
    ];
  } else if (
    input.placement === "owner-local" &&
    (input.kind === "action" || input.kind === "processor")
  ) {
    fields = [
      ...localFields,
      ...(input.kind === "processor"
        ? ["processorId", "consumerId"]
        : ["actionId", "actionRunId"]),
    ];
  } else {
    throw new TypeError("Invalid owner assignment placement or target.");
  }
  if (
    Object.keys(input).length !== fields.length ||
    fields.some((key) => !Object.hasOwn(input, key))
  ) {
    throw new TypeError("Invalid owner assignment binding.");
  }
  const copy: Record<string, unknown> = {};
  for (const key of fields) {
    const item = input[key];
    if (key === "sessionGeneration" || key === "epoch") {
      if (
        !Number.isSafeInteger(item) || Number(item) < (key === "epoch" ? 1 : 0)
      ) {
        throw new TypeError("Invalid assignment generation or epoch.");
      }
    } else identifier(item);
    copy[key] = item;
  }
  if (
    copy.placement === "owner-local" && copy.kind === "processor" &&
    copy.consumerId !== `processor:${copy.processorId}`
  ) {
    throw new TypeError("Invalid registered Processor assignment consumer.");
  }
  // PostgreSQL JSONB text adds one space after each colon and comma. Budget
  // the flat serialized form, including UTF-8 and JSON escaping, before a write.
  const encoded = `{${
    Object.entries(copy).map(([key, item]) =>
      `${JSON.stringify(key)}: ${JSON.stringify(item)}`
    ).join(", ")
  }}`;
  if (
    new TextEncoder().encode(encoded).byteLength >
      OWNER_ASSIGNMENT_BINDING_MAX_BYTES
  ) {
    throw new TypeError(
      "Owner assignment binding exceeds its encoded byte limit.",
    );
  }
  return copy as OwnerPlacementBinding;
}
