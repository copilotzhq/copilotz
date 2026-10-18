/** Registered root Action admission. Transport and current ingress policy remain
 * host-owned; installation does not imply public exposure. Public scheduling
 * remains gated on effect-aware execution/recovery; default retry policy is kept. */
import type { PluginRegistry } from "../plugins/registry.ts";
import { actionDefinitionHasSecrets } from "../actions/secret.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { digestContent } from "../content/digest.ts";
import { isContentRef } from "../content/schema.ts";
import { canonicalizeContentRefs } from "../content/input.ts";
import { createCoreTableNames } from "../events/schema.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import { createEventStore } from "../events/store.ts";
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import {
  createOperationCatalogTables,
  type OperationCatalogCore,
} from "../streams/catalog.ts";
import { assertJsonValue } from "../json.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandHandler,
  OwnerCommandInputDefinition,
  OwnerJson,
} from "./boundary.ts";

export const OWNER_ACTION_ADMISSION = "action.admit";
export type OwnerActionAdmissionValue = Readonly<{
  namespace: string;
  actionAlias: string;
  actionId: string;
  requestId: string;
  input: OwnerJson;
  metadata: Readonly<Record<string, OwnerJson>>;
  /** Opaque lossless host-normalized facts, not self-authenticating authority.
   * The trusted constraints boundary must explicitly encode absent metadata
   * keys and reject contradictory restrictions before calling admission.
   * Generic admission does not interpret or weaken those restrictions. */
  provenance: Readonly<Record<string, OwnerJson>>;
}>;
function object(value: unknown): asserts value is Record<string, OwnerJson> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Admission requires an object.");
  }
}
function rejectContent(value: OwnerJson): void {
  if (!value || typeof value !== "object") return;
  if (isContentRef(value)) {
    throw new TypeError(
      "Owner ordinary admission does not yet support nested ContentRef values.",
    );
  }
  for (const child of Object.values(value)) rejectContent(child);
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) {
    throw new TypeError(
      "Admission identifiers must be nonempty, bounded and whitespace-normalized.",
    );
  }
}
function ordered(value: OwnerJson): OwnerJson {
  if (Array.isArray(value)) return value.map(ordered);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [
        key,
        ordered((value as Record<string, OwnerJson>)[key]),
      ]),
    );
  }
  return value;
}
export function ownerActionAdmissionKey(
  ownerId: string,
  namespace: string,
  requestId: string,
): string {
  return JSON.stringify([
    OWNER_ACTION_ADMISSION,
    ownerId,
    namespace,
    requestId,
  ]);
}
/** Must run inside current host authorization, before receipt lookup. */
export function validateOwnerActionAdmissionIdentity(
  ownerId: string,
  command: OwnerCommand,
  value: OwnerJson | undefined,
): asserts value is OwnerActionAdmissionValue {
  object(value);
  text(value.namespace);
  text(value.requestId);
  if (
    command.kind !== OWNER_ACTION_ADMISSION || command.domain !== "logical" ||
    command.key !==
      ownerActionAdmissionKey(ownerId, value.namespace, value.requestId)
  ) {
    throw new TypeError(
      "Admission identity does not match its normalized scope.",
    );
  }
}
export function createOwnerActionAdmission(
  options: Readonly<{
    ownerId: string;
    schema: string;
    session: SqlSession;
    registry: PluginRegistry;
    catalog: OperationCatalogCore;
    /** Owner-schema unsettled delivery bound. Duplicates need no new slot. */
    maxPendingDeliveries?: number;
    /** Current trusted policy for new admissions, evaluated under the owner fence.
     * The host must still authorize every call before receipt lookup. Changing
     * current grouping does not change a compatible request's original capture. */
    admissionGroup?(
      tx: SqlExecutor,
      caller: OwnerCaller,
      value: OwnerActionAdmissionValue,
      commandTime: string,
    ):
      | Readonly<
        {
          key: string;
          actorId?: string;
          metadata?: Readonly<Record<string, OwnerJson>>;
        }
      >
      | undefined
      | Promise<
        | Readonly<
          {
            key: string;
            actorId?: string;
            metadata?: Readonly<Record<string, OwnerJson>>;
          }
        >
        | undefined
      >;
    /** Schedules durable references only; must not await dependent worker capacity. */
    schedule(reference: OwnerJson): void;
  }>,
) {
  const tables = createCoreTableNames(options.schema);
  const maxPendingDeliveries = options.maxPendingDeliveries ?? 128;
  if (!Number.isSafeInteger(maxPendingDeliveries) || maxPendingDeliveries < 1) {
    throw new RangeError(
      "maxPendingDeliveries must be a positive safe integer.",
    );
  }
  const inputDefinition: OwnerCommandInputDefinition = {
    async normalize(raw) {
      assertJsonValue(raw, {
        maxDepth: 64,
        maxNodes: 100_000,
        rejectNegativeZero: true,
      });
      object(raw);
      const keys = [
        "namespace",
        "actionAlias",
        "requestId",
        "input",
        "metadata",
        "provenance",
      ];
      if (
        Object.keys(raw).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(raw, key))
      ) {
        throw new TypeError(
          "Admission requires explicit input, metadata and provenance.",
        );
      }
      text(raw.namespace);
      text(raw.actionAlias);
      text(raw.requestId);
      object(raw.metadata);
      object(raw.provenance);
      const action = Object.hasOwn(options.registry.actions, raw.actionAlias)
        ? options.registry.actions[raw.actionAlias]
        : undefined;
      if (!action) throw new TypeError("Unknown registered Action.");
      if (
        action.content || action.resolve || actionDefinitionHasSecrets(action)
      ) {
        throw new TypeError(
          "Owner root admission does not yet support protected/content/deferred Actions.",
        );
      }
      if (action.inputSchema) {
        validateAgainstJsonSchema(
          action.inputSchema,
          raw.input,
          "Action input",
        );
      }
      // Shared event bodies and metadata strip hydrated ContentRef fields.
      // Until an exact ordinary-JSON path exists, refuse data that would be
      // changed instead of persisting a different original or ingress facts.
      if (
        JSON.stringify(ordered(raw)) !== JSON.stringify(ordered(
          canonicalizeContentRefs(raw) as OwnerJson,
        ))
      ) {
        throw new TypeError(
          "Owner root admission does not yet support content-shaped data that changes when persisted.",
        );
      }
      rejectContent(raw.input);
      const value = ordered({ ...raw, actionId: action.id });
      const digest = await digestContent(
        new TextEncoder().encode(JSON.stringify(value)),
      );
      return {
        intent: { encoding: "copilotz.action-admission.v1", digest },
        value,
      };
    },
  };
  const handler: OwnerCommandHandler = async (_intent, context) => {
    validateOwnerActionAdmissionIdentity(options.ownerId, {
      ...context.command,
      intent: _intent,
    }, context.input);
    const value = context.input;
    // The boundary already holds the owner fence and checked for a compatible
    // receipt. New admissions alone need capacity; the count and insertion
    // share that transaction, so concurrent callers cannot oversubscribe it.
    const pending = await context.tx.query<{ count: string | number }>(
      `SELECT COUNT(*) AS count FROM (
        SELECT 1 FROM ${tables.event_deliveries}
        WHERE status IN ('pending','leased','retry_wait') LIMIT $1
      ) AS pending`,
      [maxPendingDeliveries],
    );
    if (Number(pending.rows[0].count) >= maxPendingDeliveries) {
      throw Object.assign(
        new Error("Owner root admission is at delivery capacity."),
        {
          code: "owner_admission_refused",
        },
      );
    }
    const selectedGroup = await options.admissionGroup?.(
      context.tx,
      structuredClone(context.caller),
      structuredClone(value),
      context.commandTime,
    );
    context.signal.throwIfAborted();
    const operationMetadata: Record<string, OwnerJson> = {};
    if (selectedGroup !== undefined) {
      assertJsonValue(selectedGroup, {
        maxDepth: 32,
        maxNodes: 10_000,
        rejectNegativeZero: true,
      });
      const group = structuredClone(selectedGroup);
      if (
        Object.keys(group).some((key) =>
          !["key", "actorId", "metadata"].includes(key)
        )
      ) {
        throw new TypeError("Invalid trusted admission group.");
      }
      text(group.key);
      if (group.actorId !== undefined) text(group.actorId);
      if (group.metadata !== undefined) {
        object(group.metadata);
        assertJsonValue(group.metadata, {
          maxDepth: 32,
          maxNodes: 10_000,
          rejectNegativeZero: true,
        });
        if (
          new TextEncoder().encode(JSON.stringify(group.metadata)).byteLength >
            64 * 1024 ||
          ["httpAdmissionKey", "httpIdempotencyKey", "actorId"].some((key) =>
            Object.hasOwn(group.metadata!, key)
          )
        ) {
          throw new TypeError(
            "Trusted operation metadata is oversized or collides with reserved identity.",
          );
        }
      }
      const match = {
        httpAdmissionKey: group.key,
        ...(group.actorId === undefined ? {} : { actorId: group.actorId }),
      };
      const operations =
        createOperationCatalogTables(options.schema).operations;
      const active = await context.tx.query<{ count: string | number }>(
        `SELECT COUNT(*) AS count FROM (
          SELECT 1 FROM ${operations}
          WHERE namespace=$1 AND state IN ('accepted','running')
          AND metadata->'operationMetadata' @> $2::jsonb LIMIT 32
        ) AS active`,
        [value.namespace, JSON.stringify(match)],
      );
      if (Number(active.rows[0].count) >= 32) {
        throw Object.assign(
          new Error("Admission group has 32 active operations."),
          {
            code: "owner_admission_refused",
          },
        );
      }
      Object.assign(operationMetadata, match, {
        httpIdempotencyKey: value.requestId,
        ...group.metadata,
      });
    }
    const runId = await deriveWorkflowId(
      "action",
      options.ownerId,
      value.namespace,
      value.requestId,
    );
    const bodyId = await deriveWorkflowId("action-input", runId);
    const store = createEventStore({
      session: options.session,
      schema: options.schema,
      ownerCommit: context.ownerCommit,
      assertOperationCatalog: options.catalog.assertFormat,
      admitOperationEventSql: (input, param) =>
        options.catalog.admitEventSql(input, param),
      indexOperationEventSql: (input, param) =>
        options.catalog.indexEventSql(input, param),
      indexOperationEvent: (tx, input) => options.catalog.indexEvent(tx, input),
    });
    const result = await store.commitMutation({
      transaction: context.tx,
      draft: {
        type: "copilotz.owner.action.requested",
        namespace: value.namespace,
        payload: {
          dataRef: {
            eventBodyId: bodyId,
            schemaVersion: 1,
            mediaType: "application/json",
          },
        },
        metadata: {
          actionId: value.actionId,
          actionRunId: runId,
          requestId: value.requestId,
          actionMetadata: value.metadata,
          ingress: value.provenance,
          ...(selectedGroup === undefined ? {} : { operationMetadata }),
        },
        deduplicationId: runId,
        correlationId: runId,
      },
      body: { id: bodyId, json: value.input },
      consumers: [{
        consumerId: `registered:${value.actionId}`,
        settlement: "inherit",
      }],
    });
    const reference = {
      namespace: value.namespace,
      actionId: value.actionId,
      executionId: runId,
      eventId: result.event.id,
      deliveryId: result.deliveries[0].id,
    };
    context.afterCommit(() => options.schedule({ ...reference }));
    return reference;
  };
  return { inputDefinition, handler };
}
