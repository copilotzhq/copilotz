/** Fixed-parent content proof; neither worker metadata nor caller IDs select provenance. */
import { captureHostCommandJson } from "../application/host-command-json.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { assertCapturedContent } from "../content/capture-proof.ts";
import { contentSequenceSchema } from "../content/schema.ts";
import type { ContentInput } from "../content/types.ts";
import { eventDataRef, readEventBody } from "../events/body-store.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { readEventByDeduplicationIdOn } from "../events/store.ts";
import { createOperationCatalogTables } from "../streams/catalog.ts";
import type { ActionInvocationFrame } from "./invoker.ts";
import type { ActionWriter } from "./ownership.ts";
import { revisionPath } from "./protected-action-policy.ts";
import type { ProtectedActionSourceBinding } from "./protected-action-source.ts";
import type { ProtectedActionParentCapture } from "./protected-action-types.ts";
import { publicActionLifecycleData } from "./protected-lifecycle.ts";
import { actionSchemaHasSecrets } from "./secret.ts";
import type { ActionSchema, AnyActionDefinition } from "./types.ts";

export function captureParentCapture(
  input: ProtectedActionParentCapture,
): ProtectedActionParentCapture {
  const fixed = captureHostCommandJson(
    input,
  ) as unknown as ProtectedActionParentCapture;
  if (
    Object.keys(fixed).sort().join() !==
      "captureKey,content,origin,parentInputPath" ||
    typeof fixed.captureKey !== "string" || !fixed.captureKey ||
    fixed.captureKey.trim() !== fixed.captureKey ||
    fixed.captureKey.length > 512
  ) {
    throw new TypeError("Invalid parent capture assertion.");
  }
  revisionPath(fixed.parentInputPath);
  validateAgainstJsonSchema(
    contentSequenceSchema,
    fixed.content,
    "Parent capture references",
  );
  validateAgainstJsonSchema(
    {
      type: "object",
      additionalProperties: false,
      required: ["type", "id"],
      properties: {
        type: { type: "string", minLength: 1 },
        id: { type: "string", minLength: 1 },
      },
    },
    fixed.origin,
    "Parent capture owner",
  );
  if (
    [fixed.origin.type, fixed.origin.id].some((value) =>
      value.trim() !== value || value.length > 1024
    )
  ) {
    throw new TypeError("Invalid parent capture owner.");
  }
  return fixed;
}

/** A deliberately small validation-only subset, never a branch-selected projection. */
function validationOnlyBranch(value: unknown, selected: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const branch = value as Record<string, unknown>;
  if (
    Object.keys(branch).some((key) =>
      !["properties", "required", "title", "description", "$comment"].includes(
        key,
      )
    )
  ) return false;
  if (
    branch.required !== undefined &&
    (!Array.isArray(branch.required) ||
      !branch.required.every((key) => typeof key === "string"))
  ) return false;
  if (branch.properties === undefined) return true;
  if (
    !branch.properties || typeof branch.properties !== "object" ||
    Array.isArray(branch.properties)
  ) return false;
  return Object.entries(branch.properties).every(([key, value]) => {
    if (
      key === selected || !value || typeof value !== "object" ||
      Array.isArray(value)
    ) return false;
    const sibling = value as Record<string, unknown>;
    if (
      Object.keys(sibling).some((key) =>
        !["type", "const", "enum", "title", "description", "$comment"].includes(
          key,
        )
      )
    ) return false;
    if (
      sibling.type !== undefined &&
      !["string", "number", "integer", "boolean", "null"].includes(
        sibling.type as string,
      )
    ) return false;
    const scalar = (item: unknown) =>
      item === null || ["string", "number", "boolean"].includes(typeof item);
    return (!Object.hasOwn(sibling, "const") || scalar(sibling.const)) &&
      (sibling.enum === undefined ||
        Array.isArray(sibling.enum) && sibling.enum.every(scalar));
  });
}

function publicInputAt(
  schema: ActionSchema | undefined,
  input: unknown,
  pointer: string,
): ContentInput | readonly ContentInput[] {
  let node: unknown = schema, value = input;
  for (const part of revisionPath(pointer)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) {
      throw new Error("Parent content path is undeclared.");
    }
    const current = node as Record<string, unknown>;
    if (
      current["x-copilotz-secret"] === true ||
      [
        "$ref",
        "if",
        "then",
        "else",
        "dependentSchemas",
        "patternProperties",
        "not",
        "unevaluatedProperties",
      ].some((key) => key in current) ||
      ["allOf", "anyOf", "oneOf"].some((key) => {
        if (!(key in current)) return false;
        const branches = current[key];
        return !Array.isArray(branches) || !branches.length ||
          !branches.every((branch) => validationOnlyBranch(branch, part));
      })
    ) throw new Error("Parent content path is ambiguous or protected.");
    const properties = current.properties as
      | Record<string, unknown>
      | undefined;
    if (
      !properties || !Object.hasOwn(properties, part) || !value ||
      typeof value !== "object" || Array.isArray(value) ||
      !Object.hasOwn(value, part)
    ) throw new Error("Parent content path is unavailable.");
    node = properties[part];
    value = (value as Record<string, unknown>)[part];
  }
  if (
    !node || typeof node !== "object" || Array.isArray(node) ||
    actionSchemaHasSecrets(node as ActionSchema)
  ) throw new Error("Parent content path is protected.");
  return captureHostCommandJson(value) as unknown as
    | ContentInput
    | readonly ContentInput[];
}

export async function assertProtectedParentCapture(
  options: Readonly<{
    transaction: SqlExecutor;
    databaseSchema: string;
    namespace: string;
    source: ProtectedActionSourceBinding;
    frame: Pick<
      ActionInvocationFrame,
      "actionId" | "actionRunId" | "parentActionRunId"
    >;
    parentId: string | undefined;
    actions: Readonly<Record<string, AnyActionDefinition>>;
    writer?: ActionWriter;
    assertion: ProtectedActionParentCapture;
    registeredOrigins: readonly string[];
    streamBodyPrefix: string;
  }>,
): Promise<(transaction: SqlExecutor) => Promise<void>> {
  const { transaction, databaseSchema, namespace, source, frame, assertion } =
    options;
  const refused = (): never => {
    throw new Error("Parent content invocation is unavailable.");
  };
  if (!options.registeredOrigins.includes(assertion.origin.type)) refused();
  if (!options.parentId || !frame.parentActionRunId || !source.operationId) {
    refused();
  }
  const parentAction = Object.values(options.actions).find((action) =>
    action.id === options.parentId
  );
  if (!parentAction) refused();
  const tables = createCoreTableNames(databaseSchema);
  const operations = createOperationCatalogTables(databaseSchema);
  const parent = await readEventByDeduplicationIdOn(
    transaction,
    tables,
    namespace,
    `${frame.parentActionRunId}:action:invoked`,
  );
  if (!parent) refused();
  const data = publicActionLifecycleData(
    await readEventBody(
      { transaction, tables },
      namespace,
      eventDataRef(parent!.payload),
    ),
  ) as Record<string, unknown>;
  if (
    !data || data.status !== "invoked" || data.actionId !== options.parentId ||
    data.actionRunId !== frame.parentActionRunId ||
    parent!.subject?.id !== frame.parentActionRunId ||
    parent!.subject?.type !== options.parentId
  ) refused();
  // Parent identity/linkage has already passed the private first-capture or retained-child guard.
  // Check its owner-maintained operation index as well, never action metadata claims.
  const indexed = await transaction.query(
    `SELECT e.event_id FROM ${operations.operationEvents} e JOIN ${operations.operations} o ON o.namespace=e.namespace AND o.operation_id=e.operation_id WHERE e.namespace=$1 AND e.operation_id=$2 AND e.event_id=$3`,
    [namespace, source.operationId, parent!.id],
  );
  if (indexed.rows.length !== 1) refused();
  const child = await readEventByDeduplicationIdOn(
    transaction,
    tables,
    namespace,
    `${frame.actionRunId}:action:invoked`,
  );
  const deliveryId = child?.metadata.sourceDeliveryId ??
    (options.writer?.kind === "delivery"
      ? options.writer.deliveryId
      : undefined);
  if (typeof deliveryId !== "string") refused();
  const delivery = await transaction.query(
    `SELECT d.id FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id WHERE d.id=$1 AND e.namespace=$2 AND e.id=$3 AND d.settlement_scope_id=$4`,
    [deliveryId, namespace, source.eventId, source.operationId],
  );
  if (
    delivery.rows.length !== 1 ||
    child && child.metadata.sourceEventId !== source.eventId
  ) refused();
  const ordinary = `${frame.parentActionRunId}/action:${frame.actionId}:`;
  const resumed = `${frame.parentActionRunId}/resume/action:${frame.actionId}:`;
  const parentKey = frame.actionRunId.startsWith(ordinary)
    ? frame.parentActionRunId
    : frame.actionRunId.startsWith(resumed)
    ? `${frame.parentActionRunId}/resume`
    : refused();
  const original = publicInputAt(
    parentAction!.inputSchema,
    data.input,
    assertion.parentInputPath,
  );
  return await assertCapturedContent({
    transaction,
    databaseSchema,
    namespace,
    producer: source.operationId!,
    deliveryId: deliveryId as string,
    parentOperationKey: parentKey!,
    captureKey: assertion.captureKey,
    streamBodyPrefix: options.streamBodyPrefix,
    original,
    content: assertion.content,
    origin: assertion.origin,
  });
}
