/** Private, ephemeral result projection for owner-admitted ordinary JSON Actions.
 * References are coordinates, never read authority. Install only on
 * boundary.project with the matching authorizer and current host ingress policy.
 * No ambient session, worker report, receipt payload or new terminal record is used. */
import { createActionLifecycleLoader } from "../actions/persistence.ts";
import { PROTECTED_ACTION_LIFECYCLE_SCHEMA } from "../actions/protected-lifecycle.ts";
import { PROTECTED_VALUE_REF_SCHEMA } from "../actions/protected-value.ts";
import { actionDefinitionHasSecrets } from "../actions/secret.ts";
import type { AnyActionDefinition } from "../actions/types.ts";
import { validateAgainstJsonSchema } from "../collections/validate.ts";
import { isContentRef } from "../content/schema.ts";
import { eventDataRef } from "../events/body-store.ts";
import { createCoreTableNames } from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import { createEventStore } from "../events/store.ts";
import type { DurableEvent, EventDelivery } from "../events/types.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import { assertJsonValue } from "../json.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { createOperationCatalogTables } from "../streams/catalog.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerJson,
  OwnerProjectionHandler,
} from "./boundary.ts";

export const OWNER_ACTION_RESULT = "action.result";
export const OWNER_ACTION_HTTP_RESULT = "action.http-result";
export const OWNER_ACTION_OPERATION_RESULT = "action.operation-result";
export type OwnerActionResultPurpose = "action" | "http" | "operation";
export type OwnerActionResultReference = Readonly<{
  namespace: string;
  actionId: string;
  executionId: string;
  eventId: string;
  deliveryId: string;
}>;
/** Private transport protocol; the public ActionCaller still resolves its output. */
export type OwnerActionResult =
  | Readonly<{ status: "pending" }>
  | Readonly<{ status: "completed"; output: OwnerJson }>
  | Readonly<{
    status: "failed";
    code: "action_failed" | "action_not_completed";
  }>
  | Readonly<{ status: "cancelled"; code: "action_cancelled" }>;
export type OwnerAdmittedAction = Readonly<{
  reference: OwnerActionResultReference;
  requestId: string;
  metadata: Readonly<Record<string, OwnerJson>>;
  provenance: Readonly<Record<string, OwnerJson>>;
}>;

function unavailable(): never {
  throw Object.assign(new Error("Action result is unavailable."), {
    code: "action_result_unavailable",
  });
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) unavailable();
}
function json(value: unknown): OwnerJson {
  try {
    assertJsonValue(value, {
      maxDepth: 64,
      maxNodes: 100_000,
      rejectNegativeZero: true,
    });
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024
    ) {
      unavailable();
    }
    return structuredClone(value) as OwnerJson;
  } catch {
    unavailable();
  }
}
function object(value: unknown): Readonly<Record<string, OwnerJson>> {
  const data = json(value);
  if (!data || typeof data !== "object" || Array.isArray(data)) unavailable();
  return data as Readonly<Record<string, OwnerJson>>;
}
function ordinary(value: OwnerJson): void {
  if (!value || typeof value !== "object") return;
  const schema = !Array.isArray(value)
    ? (value as Record<string, OwnerJson>).schema
    : undefined;
  if (
    isContentRef(value) || schema === PROTECTED_ACTION_LIFECYCLE_SCHEMA ||
    schema === PROTECTED_VALUE_REF_SCHEMA
  ) unavailable();
  for (const child of Object.values(value)) ordinary(child);
}
function reference(value: unknown): OwnerActionResultReference {
  const data = object(value);
  const keys = [
    "namespace",
    "actionId",
    "executionId",
    "eventId",
    "deliveryId",
  ];
  if (
    Object.keys(data).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(data, key))
  ) unavailable();
  for (const key of keys) text(data[key]);
  return data as OwnerActionResultReference;
}
function sameReference(
  a: OwnerActionResultReference,
  b: OwnerActionResultReference,
) {
  return a.namespace === b.namespace && a.actionId === b.actionId &&
    a.executionId === b.executionId && a.eventId === b.eventId &&
    a.deliveryId === b.deliveryId;
}
function transactionStore(tx: SqlExecutor, schema: string) {
  return createEventStore({
    schema,
    session: {
      query: tx.query.bind(tx),
      transaction() {
        throw new TypeError(
          "Action result projections cannot open transactions.",
        );
      },
    },
  });
}

export function createOwnerActionResultProjection(
  options: Readonly<{
    /** Host-selected completion boundary, never supplied by a result caller.
     * action: own terminal; http: also own streams; operation: entire settled root. */
    purpose: OwnerActionResultPurpose;
    ownerId: string;
    schema: string;
    registry: PluginRegistry;
    /** Mandatory current authenticated host scope/ownership check. Called before
     * any event, delivery or body lookup. SQL-only; no external I/O. */
    authorizeCaller(
      tx: SqlExecutor,
      caller: OwnerCaller,
      reference: OwnerActionResultReference,
      commandTime: string,
    ): void | Promise<void>;
    /** Mandatory current ingress/operation ownership policy against immutable
     * admitted facts, not caller-supplied provenance. Called before any lifecycle
     * body lookup, including terminal replay. SQL-only; no external I/O. */
    authorizeIngress(
      tx: SqlExecutor,
      caller: OwnerCaller,
      admitted: OwnerAdmittedAction,
      commandTime: string,
    ): void | Promise<void>;
  }>,
): Readonly<{
  kind: string;
  authorize(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    commandTime: string,
  ): Promise<void>;
  handler: OwnerProjectionHandler;
}> {
  text(options.ownerId);
  const kind = options.purpose === "action"
    ? OWNER_ACTION_RESULT
    : options.purpose === "http"
    ? OWNER_ACTION_HTTP_RESULT
    : options.purpose === "operation"
    ? OWNER_ACTION_OPERATION_RESULT
    : undefined;
  if (!kind) {
    throw new TypeError(
      "Action result projection requires an explicit purpose.",
    );
  }
  if (
    typeof options.authorizeCaller !== "function" ||
    typeof options.authorizeIngress !== "function"
  ) {
    throw new TypeError(
      "Action result projections require current host authorization.",
    );
  }
  const tables = createCoreTableNames(options.schema);
  const operations = createOperationCatalogTables(options.schema);
  type Authorized = Readonly<{
    ref: OwnerActionResultReference;
    source: DurableEvent;
    delivery: EventDelivery;
    action: AnyActionDefinition;
  }>;
  const authorized = new WeakMap<SqlExecutor, Authorized>();

  const handler: OwnerProjectionHandler = async (
    input,
    context,
  ): Promise<OwnerActionResult> => {
    const state = authorized.get(context.tx);
    authorized.delete(context.tx);
    if (!state || !sameReference(reference(input), state.ref)) unavailable();
    const { ref, source, delivery, action } = state;
    const scope = (await context.tx.query<{
      root_event_id: string;
      correlation_id: string;
      state: string;
      cancellation_requested_at: unknown;
    }>(
      `SELECT root_event_id,correlation_id,state,cancellation_requested_at
       FROM ${operations.operations} WHERE namespace=$1 AND operation_id=$2 FOR UPDATE`,
      [ref.namespace, delivery.settlementScopeId],
    )).rows[0];
    if (
      !scope || scope.root_event_id !== ref.eventId ||
      scope.correlation_id !== source.correlationId ||
      !["accepted", "running", "completed", "failed", "cancelled"].includes(
        scope.state,
      )
    ) unavailable();
    // Match the catalog's retained settlement obligations without reconciling or
    // inventing a terminal record. Cancellation must drain these obligations too.
    const obligations = options.purpose === "operation" &&
      (await context.tx.query<{ pending: boolean }>(
        `SELECT EXISTS (
         SELECT 1 FROM ${tables.open_actions} WHERE namespace=$1 AND scope_id=$2
       ) OR EXISTS (
         SELECT 1 FROM ${operations.operationStreams}
         WHERE namespace=$1 AND operation_id=$2 AND state IN ('open','terminating')
       ) OR EXISTS (
         SELECT 1 FROM ${tables.event_deliveries} d JOIN ${tables.events} e ON e.id=d.event_id
         WHERE e.namespace=$1 AND d.settlement_scope_id=$2
           AND d.status IN ('pending','leased','retry_wait')
       ) AS pending`,
        [ref.namespace, delivery.settlementScopeId],
      )).rows[0];
    // A momentarily drained running scope is not settled: reconciliation may
    // admit more work during its two-phase drain. Only the existing authoritative
    // terminal transition makes the root result observable.
    if (
      options.purpose === "operation" && (!obligations ||
        obligations.pending || scope.state === "accepted" ||
        scope.state === "running")
    ) {
      return { status: "pending" } satisfies OwnerActionResult;
    }

    const store = transactionStore(context.tx, options.schema);
    const terminalId = `${ref.executionId}:action:terminal`;
    const event = await store.getEventByDeduplicationId(
      ref.namespace,
      terminalId,
    );
    if (event) {
      // Check the immutable envelope before the loader resolves its body.
      if (
        event.ownerId !== options.ownerId ||
        event.namespace !== ref.namespace ||
        event.causationId !== ref.eventId ||
        event.deduplicationId !== terminalId ||
        !["completed", "failed", "cancelled"].includes(
          String(event.metadata.actionStatus),
        ) ||
        event.type !== `${ref.actionId}.${event.metadata.actionStatus}` ||
        event.metadata.sourceDeliveryId !== ref.deliveryId ||
        event.metadata.actionId !== ref.actionId ||
        event.subject?.id !== ref.executionId ||
        event.subject.type !== ref.actionId
      ) unavailable();
    }
    let terminal;
    try {
      terminal = event && await createActionLifecycleLoader({
        // Reuse the exact checked envelope; every read is the fenced executor.
        store: {
          ...store,
          session: {
            async query<T extends Record<string, unknown>>(
              sql: string,
              params?: unknown[],
            ) {
              const rows = await context.tx.query<T>(sql, params);
              // The shared loader reads only this immutable body. Reject old
              // protected/content formats before its public-data conversion,
              // even if today's definition no longer advertises that feature.
              for (const row of rows.rows) ordinary(json(row.body));
              return rows;
            },
            transaction() {
              throw new TypeError(
                "Action result projections cannot open transactions.",
              );
            },
          },
          getEventByDeduplicationId: () => Promise.resolve(event),
        },
        // No Action resolver, Secret Adapter or content hydrator is supplied.
      })(ref.namespace, terminalId);
      if (
        terminal && (terminal.actionId !== ref.actionId ||
          terminal.actionRunId !== ref.executionId ||
          terminal.parentActionRunId !== undefined ||
          !["completed", "failed", "cancelled"].includes(terminal.status))
      ) unavailable();
    } catch {
      unavailable();
    }
    if (
      (options.purpose === "operation" &&
        (scope.cancellation_requested_at != null ||
          scope.state === "cancelled")) ||
      delivery.status === "cancelled" || terminal?.status === "cancelled"
    ) {
      return {
        status: "cancelled",
        code: "action_cancelled",
      } satisfies OwnerActionResult;
    }
    if (
      (options.purpose === "operation" && scope.state === "failed") ||
      delivery.status === "dead_letter" ||
      terminal?.status === "failed"
    ) {
      return {
        status: "failed",
        code: "action_failed",
      } satisfies OwnerActionResult;
    }
    if (
      !terminal && ["pending", "leased", "retry_wait"].includes(delivery.status)
    ) {
      return { status: "pending" } satisfies OwnerActionResult;
    }
    if (
      !terminal || terminal.status !== "completed" ||
      delivery.status !== "succeeded"
    ) {
      return {
        status: "failed",
        code: "action_not_completed",
      } satisfies OwnerActionResult;
    }
    if (options.purpose === "http") {
      const streams = await context.tx.query<{ pending: boolean }>(
        `SELECT EXISTS (
          SELECT 1 FROM ${operations.operationStreams}
          WHERE namespace=$1 AND operation_id=$2 AND state IN ('open','terminating')
            AND descriptor -> 'metadata' ->> 'sourceActionRunId' = $3
        ) AS pending`,
        [ref.namespace, delivery.settlementScopeId, ref.executionId],
      );
      if (!streams.rows[0]) unavailable();
      if (streams.rows[0].pending) {
        return { status: "pending" } satisfies OwnerActionResult;
      }
    }
    const output = json(terminal.output);
    try {
      if (action.outputSchema) {
        validateAgainstJsonSchema(action.outputSchema, output, "Action output");
      }
    } catch {
      unavailable();
    }
    return { status: "completed", output } satisfies OwnerActionResult;
  };

  return {
    kind,
    handler,
    async authorize(tx, caller, command, commandTime) {
      authorized.delete(tx);
      if (
        command.kind !== kind || command.domain !== "occurrence"
      ) unavailable();
      const ref = reference(command.intent);
      try {
        await options.authorizeCaller(
          tx,
          structuredClone(caller),
          structuredClone(ref),
          commandTime,
        );
      } catch {
        unavailable();
      }
      const actions = Object.values(options.registry.actions).filter((action) =>
        action.id === ref.actionId
      );
      if (actions.length !== 1) unavailable();
      const action = actions[0];
      const store = transactionStore(tx, options.schema);
      const source = await store.getEvent(ref.eventId);
      const delivery = await store.getDelivery(ref.deliveryId);
      if (
        !source || !delivery || source.ownerId !== options.ownerId ||
        source.namespace !== ref.namespace ||
        source.type !== "copilotz.owner.action.requested" ||
        source.deduplicationId !== ref.executionId ||
        source.correlationId !== ref.executionId ||
        source.metadata.actionId !== ref.actionId ||
        source.metadata.actionRunId !== ref.executionId ||
        delivery.eventId !== ref.eventId ||
        delivery.consumerId !== `registered:${ref.actionId}` ||
        delivery.settlementScopeId !== ref.eventId ||
        delivery.actionScopeId !== undefined
      ) unavailable();
      const requestId = source.metadata.requestId;
      text(requestId);
      if (
        await deriveWorkflowId(
          "action",
          options.ownerId,
          ref.namespace,
          requestId,
        ) !== ref.executionId
      ) unavailable();
      try {
        const body = eventDataRef(source.payload);
        if (
          body.eventBodyId !==
            await deriveWorkflowId("action-input", ref.executionId) ||
          body.schemaVersion !== 1
        ) unavailable();
        await options.authorizeIngress(tx, structuredClone(caller), {
          reference: structuredClone(ref),
          requestId,
          metadata: object(source.metadata.actionMetadata),
          provenance: object(source.metadata.ingress),
        }, commandTime);
      } catch {
        unavailable();
      }
      // Check capability after the admitted tuple and ingress policy, so a
      // guessed reference to an unsupported definition is still unavailable.
      if (
        action.content || action.resolve || actionDefinitionHasSecrets(action)
      ) {
        throw Object.assign(
          new Error(
            "Action result projection supports ordinary JSON Actions only; protected, content and deferred Actions are unsupported.",
          ),
          { code: "action_capability_unsupported" },
        );
      }
      authorized.set(tx, { ref, source, delivery, action });
    },
  };
}
