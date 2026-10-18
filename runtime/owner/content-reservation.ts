/** Private catalog-first stream opening. Catalog rows are the durable replay
 * record; physical I/O never runs inside a retriable owner SQL handler. */
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type { DurableEvent, EventDelivery } from "../events/types.ts";
import { createEventStore } from "../events/store.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import { assertJsonValue } from "../json.ts";
import { canonicalizeContentRefs } from "../content/input.ts";
import {
  capturePhysicalIdentity,
  type PhysicalBodyHead,
  type PhysicalBodyStore,
  physicalIdentifier,
  type PhysicalWriterIdentity,
} from "../content/physical-body-store.ts";
import {
  createOperationCatalogTables,
  createOwnerOperationCatalogCore,
} from "../streams/catalog.ts";
import {
  createStreamOutputDescriptor,
  isStreamOutputDescriptor,
} from "../streams/observation.ts";
import type {
  ContentStreamOpenInput,
  StreamOutputDescriptor,
} from "../streams/types.ts";
import {
  assertOwnerAttemptCaller,
  type OwnerAttemptAuthority,
  ownerAttemptIsLive,
  ownerAttemptToken,
  ownerEventCommitForAttempt,
} from "./attempt-authority.ts";
import {
  type OwnerPlacementBinding,
  parseOwnerPlacementBinding,
} from "./placement-binding.ts";
import type {
  OwnerCaller,
  OwnerCheckpointHandler,
  OwnerCommand,
  OwnerCommandBoundary,
  OwnerJson,
} from "./boundary.ts";

export const OWNER_STREAM_RESERVE = "content.stream.reserve";
export const OWNER_STREAM_CONFIRM = "content.stream.confirm";
export const OWNER_STREAM_OPENED_EVENT = "copilotz.stream.opened";
/** Full canonical binding and already-authorized current records, supplied only
 * by the host's existing Action/Processor live resolver. No request is authority. */
export type OwnerStreamScope = Readonly<{
  binding: OwnerPlacementBinding;
  delivery: EventDelivery;
  source: DurableEvent;
}>;
type Context = Parameters<OwnerCheckpointHandler>[1];
type OpenInput =
  & ContentStreamOpenInput
  & Readonly<{ id: string; kind: NonNullable<ContentStreamOpenInput["kind"]> }>;
type Authorized = Readonly<{
  scope: OwnerStreamScope;
  authority: OwnerAttemptAuthority;
  input: OpenInput;
  writer: PhysicalWriterIdentity;
  descriptor: StreamOutputDescriptor;
  streamId: string;
}>;
type Row = {
  stream_id: string;
  state: "reserving" | "open" | "terminating" | "terminal";
  revocation_state: "active" | "revoking" | "revoked";
  replay_key: string;
  stream_ordinal: string | null;
  committed_offset: string;
  matches: boolean;
  protected: boolean;
};
function refuse(
  message = "Stream attempt or reservation is unavailable.",
): never {
  throw Object.assign(new Error(message), {
    name: "ActionOwnershipLost",
    code: "ActionOwnershipLost",
  });
}
function json(value: unknown): OwnerJson {
  assertJsonValue(value, {
    maxDepth: 32,
    maxNodes: 20_000,
    omitUndefinedProperties: true,
  });
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).length > 65_536) {
    throw new RangeError("Stream opening exceeds its byte limit.");
  }
  return JSON.parse(encoded);
}
function record(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  const captured = json(value);
  if (
    !captured || typeof captured !== "object" || Array.isArray(captured) ||
    Object.keys(captured).some((key) => !allowed.includes(key))
  ) {
    throw new TypeError("Invalid stream opening request.");
  }
  return captured as Record<string, unknown>;
}
function openInput(value: unknown): OpenInput {
  const input = record(value, [
    "id",
    "mediaType",
    "kind",
    "role",
    "name",
    "alt",
    "language",
    "disposition",
    "metadata",
    "correlationId",
  ]);
  for (const key of ["name", "alt", "language", "correlationId"]) {
    if (Object.hasOwn(input, key)) physicalIdentifier(input[key]);
  }
  if (
    Object.hasOwn(input, "disposition") && input.disposition !== "inline" &&
    input.disposition !== "attachment"
  ) {
    throw new TypeError("Invalid stream disposition.");
  }
  if (
    Object.hasOwn(input, "metadata") &&
    (!input.metadata || typeof input.metadata !== "object" ||
      Array.isArray(input.metadata))
  ) {
    throw new TypeError("Stream metadata must be a plain object.");
  }
  const id = physicalIdentifier(input.id);
  const mediaType = physicalIdentifier(input.mediaType);
  const role = physicalIdentifier(input.role);
  const lower = mediaType.toLowerCase();
  const kind = input.kind ??
    (lower === "application/json" || lower.endsWith("+json")
      ? "json"
      : lower.startsWith("text/")
      ? "text"
      : lower.startsWith("image/")
      ? "image"
      : lower.startsWith("audio/")
      ? "audio"
      : lower.startsWith("video/")
      ? "video"
      : "file");
  const result = {
    ...input,
    id,
    mediaType,
    role,
    kind,
    metadata: input.metadata ?? {},
  } as OpenInput;
  const descriptor = createStreamOutputDescriptor({
    ...result,
    semanticId: id,
    metadata: result.metadata!,
  }, { namespace: "validation" });
  if (!isStreamOutputDescriptor(descriptor)) {
    throw new TypeError("Invalid stream descriptor.");
  }
  // The shared Action context also injects these legacy fields. They are never
  // authority on this route: discard all of them, then derive the complete set
  // from the current host binding. Processor streams cannot inherit a forged run.
  const reserved = new Set([
    "sourceDeliveryId",
    "sourceConsumerId",
    "sourceActionRunId",
    "sourceActionScopeId",
  ]);
  return {
    ...result,
    metadata: Object.fromEntries(
      Object.entries(result.metadata!).filter(([key]) => !reserved.has(key)),
    ),
  };
}
function identity(
  scope: OwnerStreamScope,
  ownerId: string,
): OwnerAttemptAuthority {
  const b = scope.binding;
  return b.placement === "owner-local" ? b : {
    placement: "worker",
    ownerId,
    workerId: b.workerId,
    assignmentId: b.assignmentId,
    sessionId: b.sessionId,
    dispatchAttemptId: b.dispatchAttemptId,
    deliveryId: b.deliveryId,
  };
}
function published(
  row: Row,
  descriptor: StreamOutputDescriptor,
): StreamOutputDescriptor {
  if (
    !row.stream_ordinal || !/^[1-9][0-9]*$/.test(row.stream_ordinal) ||
    !isStreamOutputDescriptor(descriptor)
  ) refuse();
  return {
    ...descriptor,
    replayKey: row.replay_key,
    streamOrdinal: row.stream_ordinal,
  };
}

export function createOwnerStreamReservations(
  options: Readonly<{
    ownerId: string;
    schema: string;
    session: SqlSession;
    backendId: string;
    physical: PhysicalBodyStore;
    protectionMs: number;
    resolve(
      tx: SqlExecutor,
      caller: OwnerCaller,
      time: string,
    ): OwnerStreamScope | undefined | Promise<OwnerStreamScope | undefined>;
    /** Genuine current private local/Started lifetime, including host readiness. */
    isCurrent(caller: OwnerCaller, binding: OwnerPlacementBinding): boolean;
    publish?(descriptor: StreamOutputDescriptor): void | Promise<void>;
  }>,
) {
  const ownerId = physicalIdentifier(options.ownerId);
  const backendId = physicalIdentifier(options.backendId);
  const { schema, session, protectionMs } = options;
  if (
    !Number.isSafeInteger(protectionMs) || protectionMs < 1 ||
    protectionMs > 3_600_000
  ) throw new RangeError("Invalid stream protection period.");
  const resolve = options.resolve,
    isCurrent = options.isCurrent,
    publish = options.publish;
  const provider = options.physical;
  const physical = { reserve: provider.reserve.bind(provider) };
  const catalog = createOwnerOperationCatalogCore(session, schema);
  const tables = createOperationCatalogTables(schema);
  // Command-local scratch only. The boundary supplies a distinct scoped tx for
  // each command, including grouped commands; nothing here grants durable authority.
  const authorized = new WeakMap<SqlExecutor, Authorized>();
  function privateCurrent(caller: OwnerCaller, binding: OwnerPlacementBinding) {
    let answer: unknown;
    try {
      answer = isCurrent(structuredClone(caller), structuredClone(binding));
      if (answer instanceof Promise) {
        Promise.prototype.then.call(answer, undefined, () => undefined);
      }
    } catch {
      refuse();
    }
    if (answer !== true) refuse();
  }
  function current(tx: SqlExecutor, caller: OwnerCaller): Authorized {
    const value = authorized.get(tx);
    if (!value) refuse();
    privateCurrent(caller, value.scope.binding);
    if (authorized.get(tx) !== value) refuse();
    assertOwnerAttemptCaller(caller, value.authority, ownerId);
    return value;
  }
  async function authorize(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    time: string,
  ) {
    authorized.delete(tx);
    if (![OWNER_STREAM_RESERVE, OWNER_STREAM_CONFIRM].includes(command.kind)) {
      refuse();
    }
    const envelope = command.kind === OWNER_STREAM_RESERVE
      ? { open: command.intent }
      : record(command.intent, ["open", "head"]);
    const input = openInput(envelope.open);
    const returned = await resolve(tx, structuredClone(caller), time);
    if (!returned) refuse();
    const captured = structuredClone(returned);
    const scope = {
      ...captured,
      binding: parseOwnerPlacementBinding(captured.binding),
    };
    const authority = identity(scope, ownerId);
    assertOwnerAttemptCaller(caller, authority, ownerId);
    const { binding, delivery, source } = scope;
    if (
      input.correlationId !== undefined &&
      input.correlationId !== source.correlationId
    ) {
      throw new TypeError(
        "Stream correlation must match its owner-derived source.",
      );
    }
    privateCurrent(caller, binding);
    if (
      source.ownerId !== ownerId ||
      delivery.databaseSchema !== schema ||
      source.namespace !== binding.namespace ||
      source.id !== binding.sourceEventId || delivery.eventId !== source.id ||
      delivery.id !== binding.deliveryId ||
      !ownerAttemptIsLive(delivery, authority) ||
      !Number.isSafeInteger(delivery.attempts) || delivery.attempts < 1
    ) refuse();
    await catalog.assertFormat(tx);
    const streamId = await deriveWorkflowId(
      "stream",
      ownerId,
      String(caller.ownerEpoch),
      binding.namespace,
      delivery.settlementScopeId,
      binding.placement,
      delivery.id,
      String(delivery.attempts),
      ownerAttemptToken(authority),
      input.id,
    );
    const writer = capturePhysicalIdentity({
      bodyId: await deriveWorkflowId("stream-body", streamId),
      mediaType: input.mediaType,
      reservationId: await deriveWorkflowId("stream-reservation", streamId),
      generation: 1,
    });
    const actionRunId = binding.placement === "owner-local"
      ? binding.kind === "action" ? binding.actionRunId : undefined
      : "kind" in binding
      ? undefined
      : binding.executionId;
    const rawDescriptor = createStreamOutputDescriptor({
      ...input,
      id: streamId,
      semanticId: input.id,
      metadata: input.metadata!,
    }, {
      namespace: binding.namespace,
      causationId: source.id,
      correlationId: source.correlationId,
      metadata: {
        sourceDeliveryId: delivery.id,
        sourceConsumerId: delivery.consumerId,
        ...(actionRunId ? { sourceActionRunId: actionRunId } : {}),
        ...(delivery.actionScopeId
          ? { sourceActionScopeId: delivery.actionScopeId }
          : {}),
      },
    });
    const descriptor = json(canonicalizeContentRefs(rawDescriptor));
    if (!isStreamOutputDescriptor(descriptor)) refuse();
    authorized.set(tx, {
      scope,
      authority,
      input,
      writer,
      descriptor,
      streamId,
    });
    current(tx, caller);
  }
  async function lockOperation(tx: SqlExecutor, a: Authorized) {
    const result = await tx.query<{ next_stream_ordinal: string }>(
      `SELECT next_stream_ordinal::text FROM ${tables.operations}
       WHERE namespace=$1 AND operation_id=$2 AND state IN ('accepted','running')
       AND cancellation_requested_at IS NULL FOR UPDATE`,
      [a.scope.binding.namespace, a.scope.delivery.settlementScopeId],
    );
    if (!result.rows[0]) refuse();
    return result.rows[0];
  }
  async function row(
    tx: SqlExecutor,
    a: Authorized,
    context: Context,
  ): Promise<Row | undefined> {
    return (await tx.query<Row>(
      `SELECT stream_id,state,revocation_state,replay_key::text,stream_ordinal::text,
        committed_offset::text,
        (owner_id=$4 AND opening_owner_epoch=$5 AND delivery_attempt=$6
         AND placement_binding=$7::jsonb AND physical_backend_id=$8 AND body_id=$9
         AND reservation_id=$10 AND writer_generation=$11 AND semantic_stream_id=$12
         AND descriptor=$13::jsonb) AS matches,
        protection_deadline>$14::timestamptz AS protected
       FROM ${tables.operationStreams} WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3 FOR UPDATE`,
      [
        a.scope.binding.namespace,
        a.scope.delivery.settlementScopeId,
        a.streamId,
        ownerId,
        context.ownerCommit.epoch,
        a.scope.delivery.attempts,
        JSON.stringify(a.scope.binding),
        backendId,
        a.writer.bodyId,
        a.writer.reservationId,
        a.writer.generation,
        a.input.id,
        JSON.stringify(a.descriptor),
        context.commandTime,
      ],
    )).rows[0];
  }
  function requireActive(value: Row | undefined): asserts value is Row {
    if (
      !value || value.matches !== true || value.protected !== true ||
      value.revocation_state !== "active" ||
      !["reserving", "open"].includes(value.state)
    ) refuse();
  }
  async function excludePredecessors(tx: SqlExecutor, a: Authorized) {
    const competing = await tx.query(
      `SELECT stream_id FROM ${tables.operationStreams} WHERE namespace=$1 AND operation_id=$2
       AND semantic_stream_id=$3 AND stream_id<>$4 AND revocation_state<>'revoked' LIMIT 1`,
      [
        a.scope.binding.namespace,
        a.scope.delivery.settlementScopeId,
        a.input.id,
        a.streamId,
      ],
    );
    if (competing.rows.length) {
      refuse("A prior semantic stream writer has not been fenced.");
    }
  }
  const reserve: OwnerCheckpointHandler = async (_input, context) => {
    const a = current(context.tx, context.caller);
    await lockOperation(context.tx, a);
    await excludePredecessors(context.tx, a);
    let stored = await row(context.tx, a, context);
    if (!stored) {
      await context.tx.query(
        `INSERT INTO ${tables.operationStreams}
         (namespace,operation_id,stream_id,semantic_stream_id,body_id,descriptor,
          owner_id,opening_owner_epoch,delivery_attempt,placement_binding,physical_backend_id,
          reservation_id,writer_generation,protection_deadline,revocation_state,state,asset_retention,created_at,updated_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10::jsonb,$11,$12,$13,
          $14::timestamptz + $15 * interval '1 millisecond','active','reserving','observation',$14,$14)`,
        [
          a.scope.binding.namespace,
          a.scope.delivery.settlementScopeId,
          a.streamId,
          a.input.id,
          a.writer.bodyId,
          JSON.stringify(a.descriptor),
          ownerId,
          context.ownerCommit.epoch,
          a.scope.delivery.attempts,
          JSON.stringify(a.scope.binding),
          backendId,
          a.writer.reservationId,
          a.writer.generation,
          context.commandTime,
          protectionMs,
        ],
      );
      stored = await row(context.tx, a, context);
    }
    requireActive(stored);
    return json({
      writer: a.writer,
      descriptor: stored.state === "open"
        ? published(stored, a.descriptor)
        : null,
    });
  };
  const confirm: OwnerCheckpointHandler = async (value, context) => {
    const a = current(context.tx, context.caller);
    const input = record(value, ["open", "head"]);
    const head = record(input.head, [
      "format",
      "state",
      "bodyId",
      "mediaType",
      "reservationId",
      "generation",
      "byteLength",
      "versionToken",
    ]);
    if (
      head.format !== "owner-physical-v1" || head.state !== "open" ||
      !Number.isSafeInteger(head.byteLength) || Number(head.byteLength) < 0 ||
      typeof head.versionToken !== "string" || !head.versionToken ||
      head.versionToken.length > 4096 ||
      Object.entries(a.writer).some(([key, value]) => head[key] !== value)
    ) refuse("Physical reservation confirmation does not match.");
    const operation = await lockOperation(context.tx, a);
    await excludePredecessors(context.tx, a);
    const stored = await row(context.tx, a, context);
    requireActive(stored);
    if (stored.state === "open") return json(published(stored, a.descriptor));
    const ordinal = Number(operation.next_stream_ordinal);
    if (
      !Number.isSafeInteger(ordinal) || ordinal < 1 ||
      ordinal >= Number.MAX_SAFE_INTEGER || stored.committed_offset !== "0" ||
      head.byteLength !== 0
    ) refuse();
    await context.tx.query(
      `UPDATE ${tables.operations} SET next_stream_ordinal=next_stream_ordinal+1,updated_at=$3 WHERE namespace=$1 AND operation_id=$2`,
      [
        a.scope.binding.namespace,
        a.scope.delivery.settlementScopeId,
        context.commandTime,
      ],
    );
    await context.tx.query(
      `UPDATE ${tables.operationStreams} SET state='open',stream_ordinal=$4,updated_at=$5
      WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3`,
      [
        a.scope.binding.namespace,
        a.scope.delivery.settlementScopeId,
        a.streamId,
        ordinal,
        context.commandTime,
      ],
    );
    const descriptor = published({
      ...stored,
      state: "open",
      stream_ordinal: String(ordinal),
    }, a.descriptor);
    const store = createEventStore({
      session,
      schema,
      ownerCommit: ownerEventCommitForAttempt(context, a.authority),
      assertOperationCatalog: catalog.assertFormat,
      lockSettlementScope: catalog.lockScope,
      admitOperationEventSql: catalog.admitEventSql,
      indexOperationEvent: catalog.indexEvent,
      indexOperationEventSql: catalog.indexEventSql,
    });
    const result = await store.commitMutation({
      transaction: context.tx,
      consumers: [],
      draft: {
        type: OWNER_STREAM_OPENED_EVENT,
        namespace: a.scope.binding.namespace,
        subject: { type: "stream", id: a.streamId },
        payload: descriptor,
        causationId: a.scope.source.id,
        correlationId: a.scope.source.correlationId,
        settlementScopeId: a.scope.delivery.settlementScopeId,
        ...(a.scope.delivery.actionScopeId
          ? { actionScopeId: a.scope.delivery.actionScopeId }
          : {}),
        deliveryLease: {
          deliveryId: a.scope.delivery.id,
          owner: ownerAttemptToken(a.authority),
        },
        deduplicationId: JSON.stringify([
          OWNER_STREAM_OPENED_EVENT,
          ownerId,
          a.streamId,
        ]),
      },
    });
    if (result.deduplicated) {
      refuse("Unpublished reservation already has a publication event.");
    }
    context.afterCommit(async () => {
      store.confirmCommitted?.(result.event.id);
      await publish?.(descriptor);
    });
    return json(descriptor);
  };
  return {
    authorize,
    isCurrentAuthorization(tx: SqlExecutor, caller: OwnerCaller) {
      try {
        current(tx, caller);
        return true;
      } catch {
        return false;
      }
    },
    checkpoints: {
      [OWNER_STREAM_RESERVE]: reserve,
      [OWNER_STREAM_CONFIRM]: confirm,
    },
    /** Caller must remain bound to the same live invocation across these awaits.
     * The two SQL phases independently prove current authority. Unknown reserve
     * leaves its durable intent for owner recovery; it never deletes a row. */
    async open(
      boundary: OwnerCommandBoundary,
      caller: OwnerCaller,
      value: ContentStreamOpenInput & Readonly<{ id: string }>,
      signal?: AbortSignal,
    ): Promise<StreamOutputDescriptor> {
      const capturedCaller = structuredClone(caller);
      const input = openInput(value);
      const reserved = record(
        await boundary.checkpoint(
          capturedCaller,
          OWNER_STREAM_RESERVE,
          json(input),
          {
            signal,
          },
        ),
        ["writer", "descriptor"],
      );
      if (signal?.aborted) throw signal.reason;
      const writer = capturePhysicalIdentity(reserved.writer);
      if (reserved.descriptor !== null) {
        if (!isStreamOutputDescriptor(reserved.descriptor)) refuse();
        return reserved.descriptor;
      }
      if (signal?.aborted) throw signal.reason;
      const head: PhysicalBodyHead = await physical.reserve(writer);
      if (signal?.aborted) throw signal.reason;
      const result = await boundary.checkpoint(
        capturedCaller,
        OWNER_STREAM_CONFIRM,
        json({ open: input, head }),
        { signal },
      );
      if (signal?.aborted) throw signal.reason;
      if (!isStreamOutputDescriptor(result)) refuse();
      return result;
    },
  };
}
