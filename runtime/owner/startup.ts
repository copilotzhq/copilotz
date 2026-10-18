/** Private bounded pending/terminal restart proof. A repair receipt is historical
 * progress only: readiness requires the independent, receipt-free current proof.
 * Lost/retried execution, open Actions, local attempts, content storage and streams
 * stay blocked. Ordinary graph compatibility requires explicit namespace coverage;
 * it proves current structure only, never historical authority or content safety. */
import { assertJsonValue } from "../json.ts";
import { OWNER_CHILD_ACTION_PREPARATION } from "../execution/preparation-call.ts";
import {
  type OwnerClosedActionHistory,
  type OwnerPreparedHistoryRegistration,
  validateClosedPreparedHistories,
} from "./startup-prepared.ts";
import { parseActionLifecycleEvent } from "../actions/event.ts";
import { actionSchemaHasSecrets } from "../actions/secret.ts";
import { PROTECTED_VALUE_NODE_TYPE } from "../actions/protected-value.ts";
import { actionDefinitionHasSecrets } from "../actions/protected-lifecycle.ts";
import { encodeEventBody, eventDataRef } from "../events/body-store.ts";
import {
  createCoreTableNames,
  quoteEventIdentifier,
  validateCopilotzSchema,
} from "../events/schema.ts";
import type { SqlExecutor } from "../events/session.ts";
import {
  captureOwnerGraphCollections,
  validateOwnerCollectionGraph,
} from "./startup-graph.ts";
import { validateOwnerGraphSchema } from "./startup-graph-schema.ts";
import { ownerClaimKey } from "../execution/owner-port.ts";
import { readExecutionClaim } from "../execution/recovery.ts";
import { ownerProcessorClaimKey } from "../execution/registered-processor.ts";
import type { PluginRegistry } from "../plugins/registry.ts";
import { matchDataFromPayload, matchProcessor } from "../plugins/match.ts";
import type { Processor } from "../plugins/processor.ts";
import {
  createOperationCatalogTables,
  type OperationSettlementScope,
  readOperationSettlement,
} from "../streams/catalog.ts";
import { validateOwnerContentCatalog } from "../streams/owner-catalog-schema.ts";
import { createOwnerAssignmentStorage } from "./assignment-storage.ts";
import {
  type OwnerStoredAssignment,
  parseOwnerStoredAssignment,
  validateOwnerAssignments,
} from "./assignments.ts";
import type {
  OwnerCaller,
  OwnerCommand,
  OwnerCommandHandler,
  OwnerCommitContext,
  OwnerProjectionHandler,
} from "./boundary.ts";
import { readOwnerEffectInventory } from "./effects.ts";
import { ownerPrincipalIdentity } from "./principal.ts";
import { assertOwnerOrdinaryValue } from "./ordinary-value.ts";
import { OWNER_PREPARATION_METADATA } from "./preparation-capture.ts";
import {
  ownerReconciliationAlarm,
  type OwnerReconciliationTarget,
} from "./reconciliation.ts";
import { ownerTableNames, validateOwnerCommandSchema } from "./schema.ts";
import {
  OWNER_OPERATION_SETTLEMENT,
  ownerOperationSettlementAlarm,
} from "./settlement.ts";

export const OWNER_STARTUP_REPAIR = "startup.repair";
export const OWNER_STARTUP_PROOF = "startup.proof";
type Blocker = OwnerReconciliationTarget & Readonly<{ reason: string }>;
type Plan = {
  epoch: number;
  blockers: Blocker[];
  settlements: OperationSettlementScope[];
  retirements: OwnerStoredAssignment[];
  put: Map<string, string>;
  remove: Set<string>;
  deliveries: number;
  operations: number;
};
type Row = Record<string, unknown>;
type Authorized = {
  kind: string;
  commit: OwnerCommitContext;
  plan: Plan;
};
function refuse(message = "Owner startup proof refused."): never {
  throw Object.assign(new Error(message), { code: "owner_startup_refused" });
}
function text(value: unknown): asserts value is string {
  if (
    typeof value !== "string" || !value.trim() || value !== value.trim() ||
    value.length > 1024
  ) throw new TypeError("Invalid startup identity.");
}
function object(value: unknown, keys: readonly string[]): Row {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...keys].sort().join(",")
  ) throw new TypeError("Invalid startup fields.");
  return value as Row;
}
function timestamp(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) refuse("Invalid startup timestamp.");
  return date.toISOString();
}
function ordinary(value: unknown): boolean {
  try {
    // Shared leaf guard: depth 32 / 20,000 nodes per value, plus this scan's
    // aggregate pre-hydration byte budget. Reserved protocol keys deliberately
    // exclude otherwise innocent business JSON with the same spelling.
    assertOwnerOrdinaryValue(value);
    return true;
  } catch (error) {
    if ((error as { code?: unknown })?.code === "ordinary_value_unsupported") {
      return false;
    }
    throw error;
  }
}
function targetKey(value: OwnerReconciliationTarget): string {
  return JSON.stringify([value.kind, value.namespace, value.id]);
}
function parseTarget(value: unknown): OwnerReconciliationTarget {
  const row = object(value, ["kind", "namespace", "id"]);
  if (
    typeof row.kind !== "string" ||
    ![
      "delivery",
      "assignment",
      "action",
      "operation",
      "stream",
      "effect",
      "claim",
      "alarm",
      "blocker",
    ].includes(row.kind)
  ) throw new TypeError("Invalid startup alarm target.");
  if (row.namespace !== null) text(row.namespace);
  text(row.id);
  return row as OwnerReconciliationTarget;
}
export function ownerStartupRepairKey(
  ownerId: string,
  epoch: number,
  occurrence: string,
): string {
  return JSON.stringify([OWNER_STARTUP_REPAIR, ownerId, epoch, occurrence]);
}

/** No callback may classify obligations, repair alarms or assert readiness. */
export function createOwnerStartupProof(
  options: Readonly<{
    ownerId: string;
    schema: string;
    registry: PluginRegistry;
    /** Explicit trusted namespace coverage, never inferred from graph rows or
     * registration. Omission retains the graph-empty startup subset. */
    namespaces?: readonly string[];
    /** Explicit complete ordinary-record preparation coverage. Omission cannot
     * resolve retained prepared histories or a prior startup.prepared alarm. */
    prepared?: readonly OwnerPreparedHistoryRegistration[];
    /** Aggregate configuration, raw inventory and derived graph item budget. */
    maxItems?: number;
    /** Aggregate configuration/SQL JSON/derived graph bytes. Raw evidence is
     * preflighted before hydration. Physical catalog validation has separate
     * fixed metadata caps (1,000 rows, 8,192 bytes per expression/predicate). */
    maxBytes?: number;
    authorizeControl(
      tx: SqlExecutor,
      caller: OwnerCaller,
      commandTime: string,
    ): boolean | Promise<boolean>;
  }>,
) {
  const { ownerId, schema, authorizeControl } = options;
  text(ownerId);
  if (typeof authorizeControl !== "function") {
    throw new TypeError(
      "Startup needs explicit current control authentication.",
    );
  }
  const maxItems = options.maxItems ?? 1000;
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxItems) || maxItems < 1 || maxItems > 10_000 ||
    !Number.isSafeInteger(maxBytes) || maxBytes < 1024 ||
    maxBytes > 32 * 1024 * 1024
  ) throw new TypeError("Invalid startup inventory budget.");
  // Capture configured graph coverage and data-only declarations before any
  // await. Neither later option mutation nor callback output can widen it.
  let namespaces: readonly string[] | undefined;
  if (options.namespaces !== undefined) {
    const supplied = options.namespaces;
    if (!Array.isArray(supplied) || supplied.length > 1024) {
      throw new TypeError("Invalid startup namespace inventory.");
    }
    const descriptors = Object.getOwnPropertyDescriptors(supplied);
    if (Reflect.ownKeys(descriptors).length !== supplied.length + 1) {
      throw new TypeError("Invalid startup namespace inventory.");
    }
    const copied: string[] = [];
    for (let index = 0; index < supplied.length; index++) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new TypeError("Invalid startup namespace inventory.");
      }
      text(descriptor.value);
      if (copied.includes(descriptor.value)) {
        throw new TypeError("Ambiguous startup namespace inventory.");
      }
      copied.push(descriptor.value);
    }
    namespaces = copied;
  }
  const graphCollections = namespaces === undefined
    ? []
    : captureOwnerGraphCollections(Object.values(options.registry.collections));
  let prepared: readonly OwnerPreparedHistoryRegistration[] | undefined;
  if (options.prepared !== undefined) {
    assertJsonValue(options.prepared, { maxDepth: 6, maxNodes: maxItems });
    if (!Array.isArray(options.prepared)) {
      throw new TypeError("Invalid startup preparation inventory.");
    }
    const names = new Set<string>();
    prepared = options.prepared.map((entry) => {
      const row = object(entry, [
        "name",
        "actionId",
        "source",
        "modes",
        "resources",
      ]);
      text(row.name);
      text(row.actionId);
      if (names.has(row.name)) {
        throw new TypeError("Ambiguous startup preparation.");
      }
      names.add(row.name);
      const source = object(row.source, ["name", "kind", "selection"]);
      text(source.name);
      text(source.kind);
      if (
        source.selection !== "record" ||
        !graphCollections.some((collection) =>
          collection.name === source.kind &&
          !["asset", PROTECTED_VALUE_NODE_TYPE, "@copilotz/action-content"]
            .includes(collection.name) &&
          collection.content === undefined && collection.schema !== null &&
          typeof collection.schema === "object" &&
          !Array.isArray(collection.schema) &&
          collection.schema.type === "object" &&
          !actionSchemaHasSecrets(collection.schema)
        ) ||
        !Array.isArray(row.modes) || !row.modes.length ||
        new Set(row.modes).size !== row.modes.length ||
        !Array.isArray(row.resources) || row.resources.length > 32
      ) {
        throw new TypeError("Unsupported startup preparation registration.");
      }
      const modes = row.modes.map((value) => {
        text(value);
        return value;
      });
      const resourceKeys = new Set<string>();
      const resources = row.resources.map((value) => {
        const ref = object(value, ["namespace", "alias"]);
        text(ref.namespace);
        text(ref.alias);
        const key = JSON.stringify([ref.namespace, ref.alias]);
        if (resourceKeys.has(key)) {
          throw new TypeError("Ambiguous preparation resource.");
        }
        resourceKeys.add(key);
        return { namespace: ref.namespace, alias: ref.alias };
      });
      return {
        name: row.name,
        actionId: row.actionId,
        source: {
          name: source.name,
          kind: source.kind,
          selection: "record" as const,
        },
        modes,
        resources,
      };
    });
  }
  const configuration = namespaces === undefined && prepared === undefined
    ? null
    : {
      ...(namespaces === undefined
        ? {}
        : { namespaces, collections: graphCollections }),
      ...(prepared === undefined ? {} : { prepared }),
    };
  let configurationItems = 0;
  const pendingConfiguration: unknown[] = configuration === null
    ? []
    : [configuration];
  while (pendingConfiguration.length) {
    const value = pendingConfiguration.pop();
    if (++configurationItems > maxItems) {
      throw new TypeError(
        "Startup configuration exceeds its inventory budget.",
      );
    }
    if (value !== null && typeof value === "object") {
      pendingConfiguration.push(...Object.values(value));
    }
  }
  // Reserve four copies, as for raw SQL evidence below, including the helper's
  // detached capture during each physical/schema and graph validation pass.
  const configurationBytes = configuration === null
    ? 0
    : new TextEncoder().encode(JSON.stringify(configuration)).length * 4;
  if (configurationBytes > maxBytes) {
    throw new TypeError("Startup configuration exceeds its inventory budget.");
  }
  const core = createCoreTableNames(schema);
  const catalog = createOperationCatalogTables(schema);
  const owner = ownerTableNames(schema);
  const assignments = `${quoteEventIdentifier(schema)}."owner_assignments"`;
  const storage = createOwnerAssignmentStorage({ ownerId, schema });
  const actionCounts = new Map<string, number>();
  const actions = new Set<string>();
  const processors = new Set<string>();
  const processorDefinitions = new Map<string, Processor>();
  for (const action of Object.values(options.registry.actions)) {
    actionCounts.set(action.id, (actionCounts.get(action.id) ?? 0) + 1);
    if (
      !action.content && !action.resolve && !actionDefinitionHasSecrets(action)
    ) {
      actions.add(action.id);
    }
  }
  for (const registration of prepared ?? []) {
    if (
      !actions.has(registration.actionId) ||
      actionCounts.get(registration.actionId) !== 1
    ) {
      throw new TypeError("Unsupported startup preparation target.");
    }
  }
  for (const processor of Object.values(options.registry.processors)) {
    if (processors.has(processor.id)) {
      throw new TypeError("Ambiguous Processor startup identity.");
    }
    processors.add(processor.id);
    processorDefinitions.set(processor.id, {
      ...processor,
      on: structuredClone(processor.on),
    });
  }
  const authorized = new WeakMap<SqlExecutor, Authorized>();

  async function scan(commit: OwnerCommitContext): Promise<Plan> {
    const tx = commit.transaction;
    const plan: Plan = {
      epoch: commit.epoch,
      blockers: [],
      settlements: [],
      retirements: [],
      put: new Map(),
      remove: new Set(),
      deliveries: 0,
      operations: 0,
    };
    let remainingItems = maxItems - configurationItems,
      remainingBytes = maxBytes - configurationBytes;
    // Size before SELECT: both row count and combined retained data are bounded.
    // LIMIT bounds retention, not database query-plan cost on large histories.
    async function rows(
      table: string,
      where = "TRUE",
      lossless = false,
    ): Promise<Row[]> {
      const budget = (await tx.query<{ count: number; bytes: string }>(
        `SELECT count(*)::int AS count,COALESCE(sum(octet_length(to_jsonb(candidate)::text)),0)::text AS bytes
         FROM (SELECT * FROM ${table} WHERE ${where} LIMIT $1) candidate`,
        [remainingItems + 1],
      )).rows[0];
      // Reserve additional canonicalization/parser copies up front. Body and
      // lifecycle evidence below is read from these caches, never rehydrated
      // once per delivery. Effect/scope reads each occur at most once per group.
      const bytes = Number(budget.bytes) * 4;
      if (
        budget.count > remainingItems || !Number.isSafeInteger(bytes) ||
        bytes > remainingBytes
      ) {
        return refuse(
          "Startup inventory is incomplete: row or byte budget exceeded.",
        );
      }
      remainingItems -= budget.count;
      remainingBytes -= bytes;
      // Graph timestamps must remain SQL JSON strings: a driver's Date has
      // already discarded microseconds and cannot establish exact equality.
      const result = lossless
        ? (await tx.query<{ value: Row }>(
          `SELECT to_jsonb(candidate) AS value FROM (SELECT * FROM ${table} WHERE ${where} LIMIT $1) candidate`,
          [budget.count + 1],
        )).rows.map((row) => row.value)
        : (await tx.query<Row>(
          `SELECT * FROM ${table} WHERE ${where} LIMIT $1`,
          [budget.count + 1],
        )).rows;
      if (result.length !== budget.count) {
        refuse("Startup inventory changed during the fenced proof.");
      }
      return result;
    }
    const present = new Set<string>(), resolved = new Set<string>();
    const blocked = new Set<string>();
    function block(target: OwnerReconciliationTarget, reason: string) {
      const key = targetKey(target);
      present.add(key);
      if (!blocked.has(key)) {
        if (plan.blockers.length >= maxItems) {
          refuse("Startup blocker capacity exceeded.");
        }
        blocked.add(key);
        plan.blockers.push({ ...target, reason });
      }
    }
    function ref(
      kind: OwnerReconciliationTarget["kind"],
      namespace: unknown,
      id: unknown,
    ) {
      text(id);
      if (namespace !== null) text(namespace);
      const target = { kind, namespace, id } as OwnerReconciliationTarget;
      present.add(targetKey(target));
      return target;
    }
    const preparedTarget = ref("blocker", null, "startup.prepared");
    const graphTarget = ref("blocker", null, "startup.graph");
    const legacyGraphTargets = ["nodes", "edges"].map((name) =>
      ref("blocker", null, `startup.${name}`)
    );
    if (namespaces === undefined) {
      // Without trusted coverage, retain the original graph-empty subset.
      // An existing startup.graph alarm requires the stronger explicit catalog
      // and graph proof below, even if its rows have subsequently disappeared.
      for (const [index, table] of [core.nodes, core.edges].entries()) {
        const target = legacyGraphTargets[index];
        const found = await tx.query(`SELECT 1 FROM ${table} LIMIT 1`);
        if (found.rows.length) {
          block(target, "graph_recovery_unsupported");
        } else resolved.add(targetKey(target));
      }
    } else {
      // Read-only catalog compatibility uses separate fixed metadata bounds;
      // all configured/raw/derived graph evidence shares this scan's budget.
      await validateOwnerGraphSchema(tx, schema, graphCollections);
      const nodes = await rows(core.nodes, "TRUE", true);
      const edges = await rows(core.edges, "TRUE", true);
      const graph = validateOwnerCollectionGraph({
        ownerId,
        schema,
        namespaces,
        collections: graphCollections,
        nodes,
        edges,
        maxDerivedItems: remainingItems,
        maxDerivedBytes: remainingBytes,
        maxBlockers: Math.min(maxItems, 1000),
      });
      remainingItems -= graph.derivedItems;
      remainingBytes -= graph.derivedBytes;
      if (graph.blockers.length) {
        // Snapshot-local row references must never become durable identities.
        block(graphTarget, "graph_current_state_incompatible");
      } else {
        for (const target of [graphTarget, ...legacyGraphTargets]) {
          resolved.add(targetKey(target));
        }
      }
    }
    // Shared catalog validation already proved physical storage is separate.
    // Keep stable resolved identities so obsolete blocker alarms can be removed.
    for (const name of ["content_bodies", "content_body_parts"]) {
      resolved.add(targetKey(ref("blocker", null, `startup.${name}`)));
    }
    const events = await rows(core.events);
    const bodies = await rows(core.event_bodies);
    const deliveries = await rows(core.event_deliveries);
    const assignmentRows = await rows(assignments);
    const open = await rows(core.open_actions);
    const operations = await rows(catalog.operations);
    const indices = await rows(catalog.operationEvents);
    const streams = await rows(catalog.operationStreams);
    // Immutable bodies deliberately outlive operation pruning. Until their
    // recovery/adoption reader is connected, an ordinary-history proof cannot
    // ignore retained content just because no stream row remains.
    const logicalContentTarget = ref(
      "blocker",
      null,
      "startup.logical-content",
    );
    if (
      (await tx.query(`SELECT 1 FROM ${catalog.logicalBodies} LIMIT 1`)).rows
        .length
    ) {
      block(logicalContentTarget, "logical_body_recovery_unsupported");
    } else resolved.add(targetKey(logicalContentTarget));
    const receipts = await rows(
      owner.receipts,
      "kind IN ('execution.claim','processor.claim') OR key LIKE '[\"execution.claim\",%' OR key LIKE '[\"processor.claim\",%' OR kind LIKE 'effect.%' OR left(key,10)='[\"effect\",' OR kind='action.child-prepare' OR key LIKE '[\"action.child-prepare\",%'",
    );
    const alarms = await rows(owner.alarms);
    plan.deliveries = deliveries.length;
    plan.operations = operations.length;
    const eventMap = new Map(events.map((row) => [row.id, row]));
    const deliveryMap = new Map(deliveries.map((row) => [row.id, row]));
    const scopeMap = new Map(
      operations.map((
        row,
      ) => [JSON.stringify([row.namespace, row.operation_id]), row]),
    );
    const bodyMap = new Map(
      bodies.map((
        row,
      ) => [JSON.stringify([row.namespace, row.event_body_id]), row]),
    );
    const indexMap = new Map(indices.map((row) => [row.event_id, row]));
    const stored: OwnerStoredAssignment[] = [];
    const invalidAssignmentDeliveries = new Set<string>();
    const anyClaimDeliveries = new Set<string>();
    const claims = new Map<string, Row[]>();
    const terminalRuns = new Map<
      string,
      {
        actionId: string;
        deliveryId: string;
        invokedId: unknown;
        terminalId: unknown;
      }
    >();
    const closedActions: OwnerClosedActionHistory[] = [];
    const preparedCandidates = new Map<string, {
      namespace: string;
      runId: string;
      histories: OwnerStoredAssignment[];
    }>();
    function preparationReceipt(row: Row): boolean {
      return row.kind === OWNER_CHILD_ACTION_PREPARATION ||
        (typeof row.key === "string" &&
          row.key.startsWith('["action.child-prepare",'));
    }
    const preparationReceipts = receipts.filter(preparationReceipt);
    const allowed = new Set<string>();
    const pendingScopes = new Set<string>();
    const requiredAlarms = new Map<string, string>();
    const terminalScopes = new Set<string>();
    const terminalDeliveries = new Set<string>();
    const invalidBodies = new Set<string>();
    for (const body of bodies) {
      const key = JSON.stringify([body.namespace, body.event_body_id]);
      const target = ref(
        "blocker",
        body.namespace,
        `event-body:${body.event_body_id}`,
      );
      if (
        !ordinary(body.body) || Number(body.schema_version) !== 1 ||
        (await encodeEventBody(body.body)).digest !== body.digest
      ) {
        invalidBodies.add(key);
        block(target, "event_body_unsupported");
      } else resolved.add(targetKey(target));
    }
    function lifecycle(
      event: Row,
      actionId: string,
      status: "invoked" | "completed" | "failed" | "cancelled",
    ) {
      const dataRef = eventDataRef(event.payload);
      const key = JSON.stringify([event.namespace, dataRef.eventBodyId]);
      const body = bodyMap.get(key);
      if (
        !body || invalidBodies.has(key) ||
        Number(body.schema_version) !== dataRef.schemaVersion
      ) return null;
      return parseActionLifecycleEvent({
        durable: true,
        type: event.type,
        namespace: event.namespace,
        subject: { type: event.subject_type, id: event.subject_id },
        metadata: event.metadata,
        payload: event.payload,
        deduplicationId: event.deduplication_id,
        data: body.body,
      }, { actionId, statuses: [status] });
    }

    for (const event of events) {
      const target = ref("operation", event.namespace, event.id);
      const index = indexMap.get(event.id);
      if (
        event.owner_id !== ownerId || !index ||
        index.namespace !== event.namespace ||
        !scopeMap.has(JSON.stringify([index.namespace, index.operation_id])) ||
        String(index.event_position) !== String(event.position)
      ) block(target, "event_owner_or_catalog_link_invalid");
      if (!ordinary(event.payload) || !ordinary(event.metadata)) {
        block(target, "unsupported_event_format");
      }
      const payload = event.payload as Row;
      if (payload && typeof payload === "object" && payload.dataRef) {
        try {
          const data = eventDataRef(payload);
          const key = JSON.stringify([event.namespace, data.eventBodyId]);
          const body = bodyMap.get(key);
          if (
            !body || invalidBodies.has(key) ||
            Number(body.schema_version) !== data.schemaVersion
          ) {
            block(target, "body_missing_or_unsupported");
          }
        } catch {
          block(target, "body_missing_or_unsupported");
        }
      }
      if (event.type === "copilotz.owner.action.requested") {
        const metadata = event.metadata as Row;
        if (
          deliveries.filter((delivery) =>
            delivery.event_id === event.id &&
            delivery.consumer_id === `registered:${metadata.actionId}`
          ).length !== 1
        ) {
          block(target, "action_request_without_exact_delivery");
        }
      }
    }
    for (const index of indices) {
      if (
        !eventMap.has(index.event_id) ||
        !scopeMap.has(JSON.stringify([index.namespace, index.operation_id]))
      ) {
        block(
          ref("operation", index.namespace, index.operation_id),
          "orphan_catalog_event",
        );
      }
    }
    for (const row of open) {
      block(
        ref("action", row.namespace, row.action_run_id),
        "open_action_recovery_required",
      );
    }
    for (const row of streams) {
      block(
        ref("stream", row.namespace, row.stream_id),
        "stream_recovery_unsupported",
      );
    }
    for (const row of assignmentRows) {
      let value: OwnerStoredAssignment;
      try {
        value = parseOwnerStoredAssignment(row);
      } catch {
        invalidAssignmentDeliveries.add(String(row.delivery_id));
        block(ref("assignment", null, row.delivery_id), "assignment_malformed");
        continue;
      }
      const b = value.binding;
      const source = eventMap.get(b.sourceEventId);
      const delivery = deliveryMap.get(b.deliveryId);
      const target = ref("assignment", b.namespace, b.deliveryId);
      if (
        value.owner !== ownerId || value.epoch >= commit.epoch ||
        b.placement !== "worker" || !delivery || !source ||
        source.namespace !== b.namespace || source.owner_id !== ownerId ||
        delivery.event_id !== source.id ||
        ("kind" in b
          ? delivery.consumer_id !== `processor:${b.processorId}` ||
            !processors.has(b.processorId)
          : delivery.consumer_id !== `registered:${b.actionId}` ||
            (source.metadata as Row).actionId !== b.actionId ||
            (source.metadata as Row).actionRunId !== b.executionId ||
            source.deduplication_id !== b.executionId)
      ) {
        invalidAssignmentDeliveries.add(b.deliveryId);
        block(target, "assignment_history_incompatible");
      } else stored.push(value);
    }
    for (const row of receipts) {
      if (row.kind !== "execution.claim" && row.kind !== "processor.claim") {
        continue;
      }
      const target = ref("claim", null, row.key);
      const intent = row.intent as Row | null;
      const raw = row.result as Row | null;
      if (typeof raw?.deliveryId === "string") {
        anyClaimDeliveries.add(raw.deliveryId);
      }
      for (const item of stored) {
        const binding = item.binding;
        if (
          binding.placement === "worker" &&
          binding.assignmentId === intent?.assignmentId &&
          binding.sessionId === intent?.sessionId
        ) {
          anyClaimDeliveries.add(binding.deliveryId);
        }
      }
      let result: {
        deliveryId: string;
        dispatchAttemptId: string;
        executionId?: string;
      };
      try {
        if (row.kind === "execution.claim") {
          result = readExecutionClaim(row.result).reference;
        } else {
          const value = object(row.result, ["deliveryId", "dispatchAttemptId"]);
          text(value.deliveryId);
          text(value.dispatchAttemptId);
          result = value as typeof result;
        }
      } catch {
        block(target, "claim_malformed");
        continue;
      }
      const binding = stored.filter((item) =>
        item.binding.placement === "worker" &&
        item.binding.assignmentId === intent?.assignmentId &&
        item.binding.sessionId === intent?.sessionId &&
        item.binding.deliveryId === result.deliveryId &&
        item.binding.dispatchAttemptId === result.dispatchAttemptId
      );
      const b = binding[0]?.binding;
      if (
        row.owner !== ownerId || row.domain !== "incarnation" || !intent ||
        Object.keys(intent).sort().join(",") !== "assignmentId,sessionId" ||
        binding.length !== 1 || !b || b.placement !== "worker" ||
        row.principal_kind !== "worker" ||
        row.principal_id !==
          ownerPrincipalIdentity({ kind: "worker", workerId: b.workerId }).id ||
        row.key !==
          (row.kind === "execution.claim"
            ? ownerClaimKey
            : ownerProcessorClaimKey)(ownerId, b.assignmentId, b.sessionId) ||
        (row.kind === "execution.claim"
          ? "kind" in b || b.executionId !== result.executionId
          : !("kind" in b)) ||
        !deliveryMap.has(result.deliveryId)
      ) {
        block(target, "claim_binding_unproven");
        continue;
      }
      const group = claims.get(result.deliveryId) ?? [];
      group.push(row);
      claims.set(result.deliveryId, group);
      resolved.add(targetKey(target));
    }
    for (const row of deliveries) {
      const source = eventMap.get(row.event_id);
      const target = ref("delivery", source?.namespace ?? null, row.id);
      if (!source || source.owner_id !== ownerId) {
        block(target, "delivery_source_invalid");
        continue;
      }
      // Non-null Action scopes are deferred-group selectors. This first
      // restart proof does not implement that lifecycle, even for a terminal
      // delivery, and cannot infer it from the independent settlement scope.
      if (row.action_scope_id !== null) {
        block(target, "action_scope_recovery_unsupported");
        continue;
      }
      const namespace = source.namespace as string;
      const scopeKey = JSON.stringify([namespace, row.settlement_scope_id]);
      const scope = scopeMap.get(scopeKey);
      const root = eventMap.get(scope?.root_event_id);
      if (
        !scope || !root || root.owner_id !== ownerId ||
        root.namespace !== namespace
      ) {
        block(target, "delivery_scope_invalid");
        continue;
      }
      const consumer = String(row.consumer_id);
      const processor = consumer.startsWith("processor:");
      const metadata = source.metadata as Row;
      const actionId = metadata.actionId, runId = metadata.actionRunId;
      if (
        processor
          ? !processors.has(consumer.slice(10))
          : source.type !== "copilotz.owner.action.requested" ||
            typeof actionId !== "string" || typeof runId !== "string" ||
            !actions.has(actionId) || actionCounts.get(actionId) !== 1 ||
            consumer !== `registered:${actionId}` ||
            source.deduplication_id !== runId
      ) {
        block(target, "consumer_or_action_unsupported");
        continue;
      }
      if (!processor) {
        try {
          text(metadata.rootKey ?? runId);
          if (metadata.parentActionRunId !== undefined) {
            text(metadata.parentActionRunId);
          }
          if (
            !metadata.actionMetadata ||
            typeof metadata.actionMetadata !== "object" ||
            Array.isArray(metadata.actionMetadata) ||
            !ordinary(metadata.actionMetadata)
          ) throw new TypeError("Unsupported immutable Action metadata.");
          const data = eventDataRef(source.payload);
          const key = JSON.stringify([namespace, data.eventBodyId]);
          const body = bodyMap.get(key);
          if (
            !body || invalidBodies.has(key) ||
            Number(body.schema_version) !== data.schemaVersion
          ) throw new TypeError("Unsupported Action input reference.");
        } catch {
          block(target, "action_invocation_or_input_unsupported");
          continue;
        }
      }
      const index = indexMap.get(source.id);
      const inherited = index?.namespace === namespace &&
        index.operation_id === row.settlement_scope_id;
      const detached = processor &&
        row.settlement_scope_id === `detached:${source.id}:${consumer}` &&
        scope.visibility === "internal" && scope.root_event_id === source.id &&
        row.action_scope_id === null;
      if (!inherited && !detached) {
        block(target, "delivery_scope_association_invalid");
        continue;
      }
      if (processor && row.status === "pending") {
        const definition = processorDefinitions.get(consumer.slice(10))!;
        const payload = source.payload;
        const inline = matchDataFromPayload(payload);
        const data = inline === undefined
          ? bodyMap.get(
            JSON.stringify([
              namespace,
              (payload as Row)?.dataRef &&
              ((payload as Row).dataRef as Row).eventBodyId,
            ]),
          )?.body
          : inline;
        if (
          ((definition.settlement ?? "inherit") === "detached"
            ? !detached
            : !inherited) ||
          !matchProcessor(definition, {
            type: String(source.type),
            namespace,
            payload,
            metadata: source.metadata as Record<string, unknown>,
            ...(source.subject_id && source.subject_type
              ? {
                subject: {
                  id: String(source.subject_id),
                  type: String(source.subject_type),
                },
              }
              : {}),
          }, data)
        ) {
          block(target, "processor_subscription_or_scope_changed");
          continue;
        }
      }
      const histories = stored.filter((item) =>
        item.binding.deliveryId === row.id
      );
      if (invalidAssignmentDeliveries.has(String(row.id))) {
        block(target, "assignment_history_incompatible");
        continue;
      }
      const invoked = !processor &&
        events.find((event) =>
          event.namespace === namespace &&
          event.deduplication_id === `${runId}:action:invoked`
        );
      const terminal = !processor &&
        events.find((event) =>
          event.namespace === namespace &&
          event.deduplication_id === `${runId}:action:terminal`
        );
      const openForDelivery = open.some((entry) =>
        entry.owner_delivery_id === row.id ||
        (!processor && entry.namespace === namespace &&
          entry.action_run_id === runId)
      );
      const actionEffects = !processor &&
        receipts.some((receipt) =>
          String(receipt.key).startsWith(
            JSON.stringify(["effect", ownerId, namespace, runId]).slice(0, -1) +
              ",",
          ) ||
          ((receipt.intent as Row)?.namespace === namespace &&
            (receipt.intent as Row)?.actionRunId === runId &&
            String(receipt.kind).startsWith("effect."))
        );
      const neverClaimed = row.status === "pending" &&
        Number(row.attempts) === 0 &&
        row.lease_owner === null && row.lease_expires_at === null &&
        !anyClaimDeliveries.has(String(row.id)) &&
        !invoked && !terminal && !openForDelivery && !actionEffects;
      const isTerminal = ["succeeded", "dead_letter", "cancelled"].includes(
        String(row.status),
      ) && row.lease_owner === null && row.lease_expires_at === null &&
        !openForDelivery;
      let closed = false;
      if (isTerminal && processor) closed = true;
      else if (isTerminal && terminal && invoked) {
        try {
          const status = ({
            succeeded: "completed",
            dead_letter: "failed",
            cancelled: "cancelled",
          } as const)[row.status as "succeeded" | "dead_letter" | "cancelled"];
          const state = lifecycle(terminal, String(actionId), status);
          const invocation = lifecycle(invoked, String(actionId), "invoked");
          const metadata = terminal.metadata as Row;
          const invokedMetadata = invoked.metadata as Row;
          closed = !!state && !!invocation && ordinary(state) &&
            state.actionId === actionId && state.actionRunId === runId &&
            state.status === status &&
            invocation.actionRunId === runId &&
            terminal.owner_id === ownerId &&
            terminal.causation_id === source.id &&
            terminal.correlation_id === source.correlation_id &&
            indexMap.get(terminal.id)?.namespace === namespace &&
            indexMap.get(terminal.id)?.operation_id ===
              row.settlement_scope_id &&
            metadata.sourceDeliveryId === row.id &&
            metadata.actionId === actionId &&
            metadata.actionStatus === status &&
            terminal.subject_id === runId &&
            terminal.subject_type === actionId &&
            terminal.type === `${actionId}.${status}` &&
            invoked.owner_id === ownerId &&
            invoked.causation_id === source.id &&
            invoked.correlation_id === source.correlation_id &&
            indexMap.get(invoked.id)?.namespace === namespace &&
            indexMap.get(invoked.id)?.operation_id ===
              row.settlement_scope_id &&
            invokedMetadata.sourceDeliveryId === row.id;
          // The prepared adapter consumes only canonical body/catalog/event
          // facts, never a worker marker or a globally blocked source event.
          closed = closed &&
            [source, invoked, terminal, root].every((event) =>
              !blocked.has(
                targetKey({
                  kind: "operation",
                  namespace,
                  id: String(event.id),
                }),
              )
            );
          if (closed) {
            closedActions.push({
              namespace,
              actionId: String(actionId),
              executionId: String(runId),
              eventId: String(source.id),
              deliveryId: String(row.id),
              invokedId: String(invoked.id),
              terminalId: String(terminal.id),
              settlementScopeId: String(row.settlement_scope_id),
              rootEventId: String(root.id),
            });
            terminalRuns.set(JSON.stringify([namespace, runId]), {
              actionId: String(actionId),
              deliveryId: String(row.id),
              invokedId: invoked.id,
              terminalId: terminal.id,
            });
          }
        } catch {
          closed = false;
        }
      }
      if (Object.hasOwn(metadata, OWNER_PREPARATION_METADATA)) {
        // Pending/lost/unsupported prepared work is outside this closed-history
        // proof. Do not add dispatch/settlement authority or retire its attempt.
        if (!closed || prepared === undefined || processor) {
          block(preparedTarget, "prepared_history_incompatible");
        } else {
          preparedCandidates.set(String(row.id), {
            namespace,
            runId: String(runId),
            histories,
          });
        }
        continue;
      }
      if (!neverClaimed && !closed) {
        block(target, "execution_recovery_required");
        continue;
      }
      if (neverClaimed) {
        if (
          !["accepted", "running"].includes(String(scope.state)) ||
          scope.cancellation_requested_at !== null
        ) {
          block(target, "pending_scope_not_dispatchable");
          continue;
        }
        pendingScopes.add(scopeKey);
        requiredAlarms.set(
          JSON.stringify(["host.delivery", namespace, row.id]),
          timestamp(row.available_at),
        );
      } else terminalDeliveries.add(JSON.stringify([namespace, row.id]));
      allowed.add(String(row.id));
      resolved.add(targetKey(target));
      resolved.add(
        targetKey({ kind: "assignment", namespace, id: String(row.id) }),
      );
      if (closed && !processor) {
        resolved.add(
          targetKey({ kind: "action", namespace, id: String(runId) }),
        );
      }
      for (const history of histories) {
        if (!history.retired) plan.retirements.push(history);
      }
    }
    for (const event of events) {
      const metadata = event.metadata as Row;
      if (
        metadata.actionStatus !== undefined &&
        (typeof metadata.actionStatus !== "string" ||
          !["invoked", "completed", "failed", "cancelled"].includes(
            metadata.actionStatus,
          ))
      ) {
        block(
          ref(
            "action",
            event.namespace,
            metadata.actionRunId ?? event.subject_id,
          ),
          "unsupported_lifecycle_history",
        );
      }
      const canonical = terminalRuns.get(JSON.stringify([
        event.namespace,
        metadata.actionRunId ?? event.subject_id,
      ]));
      if (
        metadata.actionStatus !== undefined &&
        (!canonical ||
          (event.id !== canonical.invokedId &&
            event.id !== canonical.terminalId))
      ) {
        block(
          ref(
            "action",
            event.namespace,
            metadata.actionRunId ?? event.subject_id,
          ),
          "orphan_or_unfinished_lifecycle",
        );
      }
    }
    const checkedEffects = new Set<string>();
    const invalidEffectRuns = new Set<string>();
    for (const receipt of receipts) {
      if (
        receipt.kind === "execution.claim" ||
        receipt.kind === "processor.claim" ||
        preparationReceipt(receipt)
      ) continue;
      const intent = receipt.intent as Row | null;
      const intentRun = JSON.stringify([
        intent?.namespace,
        intent?.actionRunId,
      ]);
      const target = ref(
        "effect",
        typeof intent?.namespace === "string" ? intent.namespace : null,
        receipt.key,
      );
      let key: unknown;
      try {
        key = JSON.parse(String(receipt.key));
      } catch { /* blocked below */ }
      if (
        !Array.isArray(key) || key.length !== 6 || key[0] !== "effect" ||
        key[1] !== ownerId || receipt.owner !== ownerId ||
        key[2] !== intent?.namespace || key[3] !== intent?.actionRunId ||
        !terminalRuns.has(JSON.stringify([key[2], key[3]]))
      ) {
        invalidEffectRuns.add(intentRun);
        block(target, "effect_without_canonical_terminal");
        continue;
      }
      const group = JSON.stringify([key[2], key[3]]);
      try {
        if (!checkedEffects.has(group)) {
          checkedEffects.add(group);
          const effects = await readOwnerEffectInventory(tx, {
            ownerId,
            schema,
            namespace: String(key[2]),
            actionRunId: String(key[3]),
          });
          if (effects.some((effect) => effect.status === "begun")) {
            invalidEffectRuns.add(group);
            block(target, "effect_reconciliation_required");
            continue;
          }
        }
        resolved.add(targetKey(target));
      } catch {
        invalidEffectRuns.add(intentRun);
        block(target, "effect_inventory_invalid");
      }
    }
    const hasPreparedEvents = events.some((event) =>
      Object.hasOwn(event.metadata as object, OWNER_PREPARATION_METADATA)
    );
    if (prepared === undefined) {
      if (hasPreparedEvents || preparationReceipts.length) {
        block(preparedTarget, "prepared_coverage_missing");
      }
      // Omitted coverage deliberately leaves preparedTarget unresolved, so a
      // previous reconciliation alarm survives even after its rows disappear.
    } else if (!hasPreparedEvents && !preparationReceipts.length) {
      resolved.add(targetKey(preparedTarget));
    } else {
      const string = (value: unknown): string => {
        text(value);
        return value;
      };
      const nullable = (value: unknown): string | null =>
        value === null ? null : string(value);
      const proof = await validateClosedPreparedHistories({
        ownerId,
        epoch: commit.epoch,
        registrations: prepared,
        events: events.map((event) => ({
          id: string(event.id),
          ownerId: string(event.owner_id),
          namespace: string(event.namespace),
          type: string(event.type),
          metadata: event.metadata as Record<string, unknown>,
          deduplicationId: nullable(event.deduplication_id),
          causationId: nullable(event.causation_id),
          correlationId: nullable(event.correlation_id),
        })),
        deliveries: deliveries.map((row) => ({
          id: string(row.id),
          eventId: string(row.event_id),
          consumerId: string(row.consumer_id),
          settlementScopeId: nullable(row.settlement_scope_id),
          actionScopeId: nullable(row.action_scope_id),
          status: string(row.status),
          attempts: Number(row.attempts),
          leaseOwner: nullable(row.lease_owner),
          leaseExpiresAt: row.lease_expires_at === null
            ? null
            : timestamp(row.lease_expires_at),
        })),
        receipts: receipts.filter((row) =>
          row.kind === "execution.claim" || preparationReceipt(row)
        ).map((row) => ({
          owner: string(row.owner),
          principalKind: string(row.principal_kind),
          principalId: string(row.principal_id),
          domain: string(row.domain),
          // Receipt keys can legitimately exceed one alarm identity. Their
          // size is already charged by the shared SQL/derived byte budget;
          // only the stable startup.prepared target is made durable below.
          key: typeof row.key === "string"
            ? row.key
            : refuse("Invalid receipt key."),
          kind: string(row.kind),
          intent: row.intent,
          result: row.result,
        })),
        closedActions: closedActions.filter((value) => {
          const targets: OwnerReconciliationTarget[] = [
            {
              kind: "action",
              namespace: value.namespace,
              id: value.executionId,
            },
            {
              kind: "delivery",
              namespace: value.namespace,
              id: value.deliveryId,
            },
            {
              kind: "assignment",
              namespace: value.namespace,
              id: value.deliveryId,
            },
            ...[
              value.eventId,
              value.invokedId,
              value.terminalId,
              value.rootEventId,
            ]
              .map((id) => ({
                kind: "operation" as const,
                namespace: value.namespace,
                id,
              })),
          ];
          return !targets.some((target) => blocked.has(targetKey(target))) &&
            !invalidEffectRuns.has(
              JSON.stringify([value.namespace, value.executionId]),
            );
        }),
        assignments: stored,
        maxDerivedItems: remainingItems,
        maxDerivedBytes: remainingBytes,
      });
      remainingItems -= proof.derivedItems;
      remainingBytes -= proof.derivedBytes;
      if (proof.blockers.length) {
        block(preparedTarget, "prepared_history_incompatible");
      } else resolved.add(targetKey(preparedTarget));
      for (const id of proof.matchedDeliveryIds) {
        const candidate = preparedCandidates.get(id);
        if (!candidate) {
          block(preparedTarget, "prepared_history_incompatible");
          continue;
        }
        const { namespace, runId, histories } = candidate;
        allowed.add(id);
        terminalDeliveries.add(JSON.stringify([namespace, id]));
        for (
          const target of [
            { kind: "delivery" as const, namespace, id },
            { kind: "assignment" as const, namespace, id },
            { kind: "action" as const, namespace, id: runId },
          ]
        ) resolved.add(targetKey(target));
        for (const history of histories) {
          if (!history.retired) plan.retirements.push(history);
        }
      }
    }
    for (const scope of operations) {
      const target = ref("operation", scope.namespace, scope.operation_id);
      const root = eventMap.get(scope.root_event_id);
      const key = JSON.stringify([scope.namespace, scope.operation_id]);
      if (
        !root || root.owner_id !== ownerId || root.namespace !== scope.namespace
      ) {
        block(target, "operation_root_invalid");
        continue;
      }
      const associated = deliveries.filter((delivery) =>
        delivery.settlement_scope_id === scope.operation_id &&
        eventMap.get(delivery.event_id)?.namespace === scope.namespace
      );
      if (
        associated.some((delivery) => !allowed.has(String(delivery.id))) ||
        open.some((entry) =>
          entry.namespace === scope.namespace &&
          entry.scope_id === scope.operation_id
        ) ||
        streams.some((entry) =>
          entry.namespace === scope.namespace &&
          entry.operation_id === scope.operation_id
        )
      ) {
        block(target, "operation_has_unresolved_obligations");
        continue;
      }
      const snapshot = await readOperationSettlement(tx, schema, {
        namespace: String(scope.namespace),
        operationId: String(scope.operation_id),
      });
      if (!snapshot) {
        block(target, "operation_missing");
        continue;
      }
      if (["accepted", "running"].includes(String(scope.state))) {
        if (!pendingScopes.has(key)) {
          plan.settlements.push({
            namespace: String(scope.namespace),
            operationId: String(scope.operation_id),
          });
        }
        requiredAlarms.set(
          ownerOperationSettlementAlarm({
            namespace: String(scope.namespace),
            operationId: String(scope.operation_id),
          }),
          timestamp(scope.updated_at),
        );
      } else if (!snapshot.ready || snapshot.outcome !== scope.state) {
        block(target, "terminal_operation_obligations_mismatch");
        continue;
      } else terminalScopes.add(key);
      resolved.add(targetKey(target));
    }
    const existing = new Map<string, string>();
    for (const alarm of alarms) {
      text(alarm.name);
      const name = String(alarm.name);
      const target = ref("alarm", null, name);
      if (alarm.owner !== ownerId) {
        block(target, "foreign_owner_alarm");
        continue;
      }
      existing.set(name, timestamp(alarm.due_at));
      let value: unknown;
      try {
        value = JSON.parse(name);
      } catch {
        block(target, "unknown_alarm");
        continue;
      }
      if (!Array.isArray(value)) {
        block(target, "unknown_alarm");
        continue;
      }
      if (
        value[0] === "reconciliation" && value.length === 5 &&
        value[1] === ownerId
      ) {
        try {
          const selected = parseTarget({
            kind: value[2],
            namespace: value[3],
            id: value[4],
          });
          const id = targetKey(selected);
          if (
            selected.kind === "alarm" ||
            (selected.kind === "blocker" && !resolved.has(id)) ||
            blocked.has(id) || (present.has(id) && !resolved.has(id))
          ) {
            block(selected, "retained_reconciliation_obligation");
          } else plan.remove.add(name);
        } catch {
          block(target, "unknown_alarm");
        }
      } else if (value.length === 3 && value[0] === "host.delivery") {
        if (terminalDeliveries.has(JSON.stringify([value[1], value[2]]))) {
          plan.remove.add(name);
        } else if (!requiredAlarms.has(name)) {
          block(target, "delivery_alarm_target_unresolved");
        }
      } else if (
        value.length === 3 && value[0] === OWNER_OPERATION_SETTLEMENT
      ) {
        if (terminalScopes.has(JSON.stringify([value[1], value[2]]))) {
          plan.remove.add(name);
        } else if (!requiredAlarms.has(name)) {
          block(target, "settlement_alarm_target_unresolved");
        }
      } else block(target, "unknown_alarm");
    }
    for (const [name, due] of requiredAlarms) {
      if (existing.get(name) !== due) plan.put.set(name, due);
    }
    for (const blocker of plan.blockers) {
      const name = ownerReconciliationAlarm(ownerId, blocker);
      if (!existing.has(name)) plan.put.set(name, commit.commandTime);
      plan.remove.delete(name);
    }
    if (
      alarms.length + [...plan.put.keys()].filter((key) =>
            !existing.has(key)
          ).length -
          plan.remove.size > maxItems
    ) {
      refuse("Startup alarm capacity exceeded.");
    }
    return plan;
  }

  function consume(tx: SqlExecutor, kind: string): Authorized {
    const value = authorized.get(tx);
    authorized.delete(tx);
    if (!value || value.kind !== kind) refuse();
    return value;
  }
  const handler: OwnerCommandHandler = async (_input, context) => {
    const { commit, plan } = consume(context.tx, OWNER_STARTUP_REPAIR);
    if (
      context.ownerCommit.epoch !== commit.epoch ||
      context.ownerCommit.holderId !== commit.holderId
    ) refuse();
    for (const row of plan.retirements) {
      if (!await storage.retirePrior(context.ownerCommit, row)) {
        refuse("Startup reservation changed.");
      }
    }
    for (const name of plan.remove) {
      await context.tx.query(
        `DELETE FROM ${owner.alarms} WHERE owner=$1 AND name=$2`,
        [ownerId, name],
      );
    }
    for (const [name, due] of plan.put) {
      await context.tx.query(
        `INSERT INTO ${owner.alarms}(owner,name,due_at) VALUES($1,$2,$3::timestamptz)
       ON CONFLICT(owner,name) DO UPDATE SET due_at=EXCLUDED.due_at`,
        [ownerId, name, due],
      );
    }
    return {
      epoch: plan.epoch,
      blockers: plan.blockers,
      settlements: plan.settlements,
      repairs: plan.retirements.length + plan.put.size + plan.remove.size,
    };
  };
  const projection: OwnerProjectionHandler = (_input, context) => {
    const { plan } = consume(context.tx, OWNER_STARTUP_PROOF);
    if (
      plan.blockers.length || plan.settlements.length ||
      plan.retirements.length || plan.put.size || plan.remove.size
    ) {
      refuse(
        "Startup current obligations or exact alarm coverage remain unresolved.",
      );
    }
    return {
      epoch: plan.epoch,
      deliveries: plan.deliveries,
      operations: plan.operations,
    };
  };
  return {
    handlers: { [OWNER_STARTUP_REPAIR]: handler },
    projections: { [OWNER_STARTUP_PROOF]: projection },
    async authorize(
      tx: SqlExecutor,
      caller: OwnerCaller,
      command: OwnerCommand,
      commandTime: string,
    ) {
      authorized.delete(tx);
      if (
        caller.principal.kind !== "owner-control" ||
        caller.principal.ownerId !== ownerId ||
        caller.principal.epoch !== caller.ownerEpoch
      ) refuse();
      const principal = { ...caller.principal };
      if (command.kind === OWNER_STARTUP_REPAIR) {
        const data = object(command.intent, ["occurrence"]);
        text(data.occurrence);
        if (
          command.domain !== "occurrence" ||
          command.key !==
            ownerStartupRepairKey(ownerId, caller.ownerEpoch, data.occurrence)
        ) refuse();
      } else if (
        command.kind !== OWNER_STARTUP_PROOF || command.intent !== null
      ) refuse();
      if (
        await authorizeControl(tx, structuredClone(caller), commandTime) !==
          true
      ) refuse();
      await validateCopilotzSchema(tx, schema);
      await validateOwnerContentCatalog(tx, schema);
      await validateOwnerCommandSchema(tx, schema, ownerId);
      await validateOwnerAssignments(tx, schema);
      const current = (await tx.query<
        { owner: string; epoch: number | string; holder: string }
      >(`SELECT owner,epoch,holder FROM ${owner.epochs} LIMIT 2`)).rows;
      if (
        current.length !== 1 || current[0].owner !== ownerId ||
        Number(current[0].epoch) !== principal.epoch ||
        current[0].holder !== principal.holderId
      ) refuse();
      const commit: OwnerCommitContext = {
        transaction: tx,
        ownerId,
        epoch: principal.epoch,
        holderId: principal.holderId,
        commandTime,
      };
      const plan = await scan(commit);
      if (
        command.kind === OWNER_STARTUP_REPAIR &&
        (plan.retirements.length || plan.put.size || plan.remove.size)
      ) {
        const duplicate = await tx.query(
          `SELECT 1 FROM ${owner.receipts} WHERE owner=$1 AND domain='occurrence' AND key=$2`,
          [ownerId, command.key],
        );
        if (duplicate.rows.length) {
          refuse(
            "A historical startup receipt cannot skip current alarm repairs.",
          );
        }
      }
      authorized.set(tx, { kind: command.kind, commit, plan });
    },
  };
}
