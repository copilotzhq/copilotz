import { ownerTableNames } from "./schema.ts";
/** Private catalog-first stream opening. Catalog rows are the durable replay
 * record; physical I/O never runs inside a retriable owner SQL handler. */
import type { SqlExecutor, SqlSession } from "../events/session.ts";
import type { DurableEvent, EventDelivery } from "../events/types.ts";
import { createEventStore } from "../events/store.ts";
import { deriveWorkflowId } from "../events/workflow-id.ts";
import { assertJsonValue } from "../json.ts";
import { canonicalizeContentRefs } from "../content/input.ts";
import {
  capturePhysicalAppendData,
  capturePhysicalIdentity,
  digestPhysicalPrefix,
  type PhysicalBodyHead,
  type PhysicalBodyStore,
  physicalIdentifier,
  PhysicalPrefixUnavailableError,
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
  ContentStreamAbortInput,
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
export const OWNER_STREAM_WRITER = "content.stream.writer";
export const OWNER_STREAM_APPEND_ACK = "content.stream.append-ack";
export const OWNER_STREAM_CHECKPOINT = "content.stream.checkpoint";
export const OWNER_STREAM_SEAL_INTENT = "content.stream.seal-intent";
export const OWNER_STREAM_RENEW = "content.stream.renew";
export const OWNER_STREAM_SCAN = "content.stream.scan";
export const OWNER_STREAM_CLEANUP_SCAN = "content.stream.cleanup-scan";
export type OwnerStreamCleanupCursor =
  & OwnerStreamTarget
  & Readonly<{ deadline: string }>;
export const OWNER_STREAM_WORK_BATCH = 16;
export function ownerStreamAlarm(ownerId: string): string {
  return JSON.stringify([OWNER_STREAM_SCAN, ownerId, "content"]);
}
export const OWNER_STREAM_ABORT_TARGET = "content.stream.abort-target";
export const OWNER_STREAM_REVOKE = "content.stream.revoke";
export const OWNER_STREAM_REVOKED = "content.stream.revoked";
export type OwnerStreamTarget = Readonly<
  { namespace: string; operationId: string; streamId: string }
>;
export const OWNER_STREAM_OPENED_EVENT = "copilotz.stream.opened";
/** Full canonical binding and already-authorized current records, supplied only
 * by the host's existing Action/Processor live resolver. No request is authority. */
export type OwnerStreamScope = Readonly<{
  binding: OwnerPlacementBinding;
  delivery: EventDelivery;
  source: Pick<DurableEvent, "id" | "ownerId" | "namespace" | "correlationId">;
}>;
type Context = Parameters<OwnerCheckpointHandler>[1];
type OpenInput =
  & ContentStreamOpenInput
  & Readonly<{ id: string; kind: NonNullable<ContentStreamOpenInput["kind"]> }>;
type OpeningAuthorized = Readonly<{
  mode: "opening";
  scope: OwnerStreamScope;
  authority: OwnerAttemptAuthority;
  input: OpenInput;
  writer: PhysicalWriterIdentity;
  descriptor: StreamOutputDescriptor;
  streamId: string;
}>;
type WriterAuthorized = Readonly<{
  mode: "writer";
  cleanup: boolean;
  scope: OwnerStreamScope;
  authority: OwnerAttemptAuthority;
  streamId: string;
  writer: PhysicalWriterIdentity;
  committedOffset: number;
}>;
type ControlAuthorized = Readonly<{
  mode: "control";
  target: OwnerStreamTarget;
  writer: PhysicalWriterIdentity;
  descriptor: StreamOutputDescriptor;
  sealDigest: string | null;
  state: Row["state"];
  revocation: Row["revocation_state"];
  committedOffset: number;
}>;
type RenewalAuthorized = Readonly<{
  mode: "renewal";
  target: OwnerStreamTarget;
  binding: OwnerPlacementBinding;
  ordinal: number;
  deadline: string;
  writer: PhysicalWriterIdentity;
  isCurrent(): boolean;
}>;
type Authorized =
  | OpeningAuthorized
  | WriterAuthorized
  | ControlAuthorized
  | RenewalAuthorized
  | Readonly<{ mode: "scan" }>
  | Readonly<
    {
      mode: "cleanup-scan";
      after: OwnerStreamCleanupCursor | null;
      closing: boolean;
    }
  >;
type RenewalRow = {
  binding: unknown;
  ordinal: string;
  deadline: string;
  protected: boolean;
  state: string;
  revocation: string;
  body_id: string;
  reservation_id: string;
  generation: string;
  media_type: string;
};
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
function safeOffset(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("Invalid stream offset.");
  }
  return value;
}
function offsets(input: Record<string, unknown>) {
  const startOffset = safeOffset(input.startOffset),
    endOffset = safeOffset(input.endOffset);
  if (endOffset < startOffset) {
    throw new TypeError("Invalid stream offset interval.");
  }
  return { startOffset, endOffset };
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

function cleanupCursor(value: unknown): OwnerStreamCleanupCursor {
  const row = record(value, [
    "namespace",
    "operationId",
    "streamId",
    "deadline",
  ]);
  if (
    typeof row.deadline !== "string" || row.deadline.length > 128 ||
    !Number.isFinite(Date.parse(row.deadline))
  ) refuse();
  return {
    namespace: physicalIdentifier(row.namespace),
    operationId: physicalIdentifier(row.operationId),
    streamId: physicalIdentifier(row.streamId),
    deadline: row.deadline,
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
    now?: () => string;
    /** Bound includes hidden and revoking writers; only confirmed fences free it. */
    maxUnresolved: number;
    /** Genuine host control token, checked again before COMMIT. Never a worker grant. */
    isControlCurrent?(caller: OwnerCaller): boolean;
    isRenewalCurrent?(caller: OwnerCaller): boolean;
    resolveReserved?(
      tx: SqlExecutor,
      caller: OwnerCaller,
      binding: OwnerPlacementBinding,
      ordinal: number,
      time: string,
    ): Promise<
      Readonly<{ delivery: EventDelivery; isCurrent(): boolean }> | undefined
    >;
    /** Nonblocking hint; the alarm itself is committed in the same owner transaction. */
    onWork?(dueAt: string | null): void;
    onRevoked?(target: OwnerStreamTarget): void | Promise<void>;
    /** Host-owned cleanup after a known reservation fails before returning a writer. */
    cleanupOrphan?(target: OwnerStreamTarget): Promise<void>;
    resolve(
      tx: SqlExecutor,
      caller: OwnerCaller,
      time: string,
    ): OwnerStreamScope | undefined | Promise<OwnerStreamScope | undefined>;
    /** Narrow original-parent settlement facts, without failed invocation signal. */
    resolveSettlement?(
      tx: SqlExecutor,
      caller: OwnerCaller,
      time: string,
    ): OwnerStreamScope | undefined | Promise<OwnerStreamScope | undefined>;
    isCurrentSettlement?(
      caller: OwnerCaller,
      binding: OwnerPlacementBinding,
    ): boolean;
    /** Genuine current private local/Started lifetime, including host readiness. */
    isCurrent(caller: OwnerCaller, binding: OwnerPlacementBinding): boolean;
    publish?(descriptor: StreamOutputDescriptor): void | Promise<void>;
  }>,
) {
  const ownerId = physicalIdentifier(options.ownerId);
  const backendId = physicalIdentifier(options.backendId);
  const { schema, session, protectionMs, maxUnresolved } = options;
  const readClock = options.now ?? (() => new Date().toISOString());
  if (typeof readClock !== "function") {
    throw new TypeError("Invalid owner content clock.");
  }
  function clockTime(): string {
    const value = readClock();
    if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
      refuse("Owner content clock is unavailable.");
    }
    return value;
  }
  if (
    !Number.isSafeInteger(maxUnresolved) || maxUnresolved < 1 ||
    maxUnresolved > 10_000
  ) {
    throw new RangeError("Invalid unresolved writer bound.");
  }
  const isRenewalCurrent = options.isRenewalCurrent,
    resolveReserved = options.resolveReserved,
    onWork = options.onWork;
  const isControlCurrent = options.isControlCurrent,
    onRevoked = options.onRevoked,
    cleanupOrphan = options.cleanupOrphan;
  if (
    !Number.isSafeInteger(protectionMs) || protectionMs < 1 ||
    protectionMs > 3_600_000
  ) throw new RangeError("Invalid stream protection period.");
  const resolveSettlement = options.resolveSettlement,
    isCurrentSettlement = options.isCurrentSettlement;
  const resolve = options.resolve,
    isCurrent = options.isCurrent,
    publish = options.publish;
  const provider = options.physical;
  const physical = {
    reserve: provider.reserve.bind(provider),
    append: provider.append.bind(provider),
    head: provider.head.bind(provider),
    fence: provider.fence.bind(provider),
    readRange: provider.readRange.bind(provider),
  };
  const catalog = createOwnerOperationCatalogCore(session, schema);
  const tables = createOperationCatalogTables(schema);
  const alarmTable = ownerTableNames(schema).alarms;
  const alarm = ownerStreamAlarm(ownerId);
  // Command-local scratch only. The boundary supplies a distinct scoped tx for
  // each command, including grouped commands; nothing here grants durable authority.
  const authorized = new WeakMap<SqlExecutor, Authorized>();
  function privateCurrent(
    caller: OwnerCaller,
    binding: OwnerPlacementBinding,
    cleanup = false,
  ) {
    let answer: unknown;
    try {
      const check = cleanup ? isCurrentSettlement : isCurrent;
      answer = check?.(structuredClone(caller), structuredClone(binding));
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
    if (value.mode === "cleanup-scan") {
      requireControl(caller);
      if (authorized.get(tx) !== value) refuse();
      return value;
    }
    if (value.mode === "scan" || value.mode === "renewal") {
      requireControl(caller, true);
      if (value.mode === "renewal") {
        const currentTime = clockTime();
        let valid: unknown;
        try {
          valid = value.isCurrent();
          if (valid instanceof Promise) {
            Promise.prototype.then.call(valid, undefined, () => undefined);
          }
        } catch {
          refuse();
        }
        if (
          valid !== true ||
          Date.parse(currentTime) >= Date.parse(value.deadline)
        ) {
          refuse("Original stream protection expired during renewal.");
        }
      }
      if (authorized.get(tx) !== value) refuse();
      return value;
    }
    if (value.mode === "control") {
      requireControl(caller);
      if (authorized.get(tx) !== value) refuse();
      return value;
    }
    privateCurrent(
      caller,
      value.scope.binding,
      value.mode === "writer" && value.cleanup,
    );
    if (authorized.get(tx) !== value) refuse();
    assertOwnerAttemptCaller(caller, value.authority, ownerId);
    return value;
  }
  function requireControl(caller: OwnerCaller, renewal = false) {
    const validate = renewal ? isRenewalCurrent : isControlCurrent;
    if (
      caller.principal.kind !== "owner-control" ||
      caller.principal.ownerId !== ownerId ||
      caller.ownerEpoch !== caller.principal.epoch || !validate
    ) {
      refuse("Current owner cleanup authority is required.");
    }
    let current: unknown;
    try {
      current = validate!(structuredClone(caller));
      if (current instanceof Promise) {
        Promise.prototype.then.call(current, undefined, () => undefined);
      }
    } catch {
      refuse("Current owner cleanup authority is required.");
    }
    if (current !== true) {
      refuse("Current owner cleanup authority is required.");
    }
  }
  function controlling(
    tx: SqlExecutor,
    caller: OwnerCaller,
  ): ControlAuthorized {
    const value = current(tx, caller);
    if (value.mode !== "control") refuse();
    return value;
  }
  function opening(tx: SqlExecutor, caller: OwnerCaller): OpeningAuthorized {
    const a = current(tx, caller);
    if (a.mode !== "opening") refuse();
    return a;
  }
  function writing(tx: SqlExecutor, caller: OwnerCaller): WriterAuthorized {
    const a = current(tx, caller);
    if (a.mode !== "writer") refuse();
    return a;
  }
  async function authenticate(
    tx: SqlExecutor,
    caller: OwnerCaller,
    time: string,
    cleanup = false,
  ) {
    const selected = cleanup ? resolveSettlement : resolve;
    const returned = await selected?.(tx, structuredClone(caller), time);
    if (!returned) refuse();
    const captured = structuredClone(returned);
    const scope = {
      ...captured,
      binding: parseOwnerPlacementBinding(captured.binding),
    };
    const authority = identity(scope, ownerId);
    assertOwnerAttemptCaller(caller, authority, ownerId);
    const { binding, delivery, source } = scope;
    privateCurrent(caller, binding, cleanup);
    if (
      source.ownerId !== ownerId || delivery.databaseSchema !== schema ||
      source.namespace !== binding.namespace ||
      source.id !== binding.sourceEventId ||
      delivery.eventId !== source.id || delivery.id !== binding.deliveryId ||
      !ownerAttemptIsLive(delivery, authority) ||
      !Number.isSafeInteger(delivery.attempts) || delivery.attempts < 1
    ) refuse();
    await catalog.assertFormat(tx);
    return { scope, authority };
  }
  function target(value: unknown): OwnerStreamTarget {
    const input = record(value, ["namespace", "operationId", "streamId"]);
    return {
      namespace: physicalIdentifier(input.namespace),
      operationId: physicalIdentifier(input.operationId),
      streamId: physicalIdentifier(input.streamId),
    };
  }
  async function lockLiveScope(tx: SqlExecutor, selected: OwnerStreamTarget) {
    const row = await tx.query(
      `SELECT operation_id FROM ${tables.operations}
      WHERE namespace=$1 AND operation_id=$2 AND state IN ('accepted','running')
        AND cancellation_requested_at IS NULL FOR UPDATE`,
      [selected.namespace, selected.operationId],
    );
    if (row.rows.length !== 1) refuse("Stream scope is no longer renewable.");
  }
  async function readRenewal(
    tx: SqlExecutor,
    selected: OwnerStreamTarget,
    caller: OwnerCaller,
    time: string,
    lock: boolean,
  ) {
    return (await tx.query<RenewalRow>(
      `SELECT
      CASE WHEN octet_length(placement_binding::text)<=32768 THEN placement_binding ELSE NULL END AS binding,
      delivery_attempt::text AS ordinal,protection_deadline::text AS deadline,
      protection_deadline>$6::timestamptz AS protected,state,revocation_state AS revocation,
      CASE WHEN char_length(body_id) BETWEEN 1 AND 1024 THEN body_id END AS body_id,
      CASE WHEN char_length(reservation_id) BETWEEN 1 AND 1024 THEN reservation_id END AS reservation_id,
      writer_generation::text AS generation,
      CASE WHEN jsonb_typeof(descriptor->'mediaType')='string' AND char_length(descriptor->>'mediaType') BETWEEN 1 AND 1024 THEN descriptor->>'mediaType' END AS media_type
      FROM ${tables.operationStreams} WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3
        AND owner_id=$4 AND opening_owner_epoch=$5 AND physical_backend_id=$7 ${
        lock ? "FOR UPDATE" : ""
      }`,
      [
        selected.namespace,
        selected.operationId,
        selected.streamId,
        ownerId,
        caller.ownerEpoch,
        time,
        backendId,
      ],
    )).rows[0];
  }
  async function authorizeRenewal(
    tx: SqlExecutor,
    caller: OwnerCaller,
    value: OwnerJson,
    time: string,
  ) {
    requireControl(caller, true);
    if (!resolveReserved) refuse("Reserved renewal resolution is unavailable.");
    await catalog.assertFormat(tx);
    const selected = target(value);
    await lockLiveScope(tx, selected);
    const before = await readRenewal(tx, selected, caller, time, false);
    if (
      !before || !before.protected || before.revocation !== "active" ||
      !["reserving", "open"].includes(before.state)
    ) refuse("Expired or revoked writers cannot renew.");
    const writer = capturePhysicalIdentity({
      bodyId: before.body_id,
      reservationId: before.reservation_id,
      generation: Number(before.generation),
      mediaType: before.media_type,
    });
    if (
      writer.generation !== 1 ||
      writer.bodyId !==
        await deriveWorkflowId("stream-body", selected.streamId) ||
      writer.reservationId !==
        await deriveWorkflowId("stream-reservation", selected.streamId)
    ) refuse("Reserved writer identity is inconsistent.");
    const binding = parseOwnerPlacementBinding(before.binding),
      ordinal = safeOffset(Number(before.ordinal));
    if (ordinal < 1 || binding.namespace !== selected.namespace) refuse();
    const proof = await resolveReserved!(
      tx,
      structuredClone(caller),
      structuredClone(binding),
      ordinal,
      time,
    );
    const check = proof?.isCurrent;
    if (!proof || typeof check !== "function") {
      refuse("Original stream attempt is no longer current.");
    }
    const delivery = structuredClone(proof.delivery);
    const authority = binding.placement === "owner-local" ? binding : {
      placement: "worker" as const,
      ownerId,
      workerId: binding.workerId,
      assignmentId: binding.assignmentId,
      sessionId: binding.sessionId,
      dispatchAttemptId: binding.dispatchAttemptId,
      deliveryId: binding.deliveryId,
    };
    if (
      !ownerAttemptIsLive(delivery, authority) ||
      delivery.databaseSchema !== schema ||
      delivery.attempts !== ordinal ||
      delivery.eventId !== binding.sourceEventId ||
      delivery.settlementScopeId !== selected.operationId
    ) refuse();
    await lockLiveScope(tx, selected);
    const after = await readRenewal(tx, selected, caller, time, true);
    if (
      !after || !after.protected || after.revocation !== "active" ||
      after.state !== before.state ||
      after.ordinal !== before.ordinal || after.deadline !== before.deadline ||
      after.body_id !== before.body_id ||
      after.reservation_id !== before.reservation_id ||
      after.generation !== before.generation ||
      after.media_type !== before.media_type ||
      JSON.stringify(parseOwnerPlacementBinding(after.binding)) !==
        JSON.stringify(binding)
    ) refuse("Stream renewal facts changed during authorization.");
    authorized.set(tx, {
      mode: "renewal",
      target: selected,
      binding,
      ordinal,
      deadline: after.deadline,
      writer,
      isCurrent: check!.bind(proof),
    });
    current(tx, caller);
  }
  async function rearm(context: Context) {
    const armed = await context.tx.query<{ due_at: string }>(
      `INSERT INTO ${alarmTable}(owner,name,due_at)
      SELECT $1,$2,MIN(CASE WHEN revocation_state='revoking' THEN $3::timestamptz + $4 * interval '1 millisecond'
        ELSE protection_deadline - $4 * interval '1 millisecond' END)
      FROM ${tables.operationStreams} WHERE owner_id=$1 AND revocation_state<>'revoked' HAVING COUNT(*)>0
      ON CONFLICT(owner,name) DO UPDATE SET due_at=EXCLUDED.due_at RETURNING due_at::text`,
      [
        ownerId,
        alarm,
        context.commandTime,
        Math.max(1, Math.floor(protectionMs / 2)),
      ],
    );
    if (armed.rows.length === 0) {
      await context.tx.query(
        `DELETE FROM ${alarmTable} WHERE owner=$1 AND name=$2
      AND NOT EXISTS(SELECT 1 FROM ${tables.operationStreams} WHERE owner_id=$1 AND revocation_state<>'revoked')`,
        [ownerId, alarm],
      );
    }
    const dueAt = armed.rows[0]?.due_at ?? null;
    context.afterCommit(() => onWork?.(dueAt));
  }
  async function authorize(
    tx: SqlExecutor,
    caller: OwnerCaller,
    command: OwnerCommand,
    time: string,
  ) {
    authorized.delete(tx);
    if (command.kind === OWNER_STREAM_CLEANUP_SCAN) {
      requireControl(caller);
      const value = record(command.intent, ["after", "closing"]);
      if (typeof value.closing !== "boolean") refuse();
      const after = value.after === null ? null : cleanupCursor(value.after);
      await catalog.assertFormat(tx);
      authorized.set(tx, {
        mode: "cleanup-scan",
        after,
        closing: value.closing,
      });
      current(tx, caller);
      return;
    }
    if (command.kind === OWNER_STREAM_SCAN) {
      requireControl(caller, true);
      if (command.intent !== null) refuse();
      await catalog.assertFormat(tx);
      authorized.set(tx, { mode: "scan" });
      current(tx, caller);
      return;
    }
    if (command.kind === OWNER_STREAM_RENEW) {
      return await authorizeRenewal(tx, caller, command.intent, time);
    }
    if ([OWNER_STREAM_REVOKE, OWNER_STREAM_REVOKED].includes(command.kind)) {
      requireControl(caller);
      await catalog.assertFormat(tx);
      const input = record(
        command.intent,
        command.kind === OWNER_STREAM_REVOKE
          ? ["namespace", "operationId", "streamId", "outcome", "capture"]
          : ["namespace", "operationId", "streamId", "head", "verifiedDigest"],
      );
      const target = {
        namespace: physicalIdentifier(input.namespace),
        operationId: physicalIdentifier(input.operationId),
        streamId: physicalIdentifier(input.streamId),
      };
      const row = (await tx.query<
        {
          descriptor: StreamOutputDescriptor;
          digest: string | null;
          outcome: string | null;
          state: Row["state"];
          revocation_state: Row["revocation_state"];
          body_id: string;
          reservation_id: string;
          writer_generation: string;
          media_type: string;
          committed_offset: string;
        }
      >(
        `SELECT state,revocation_state,body_id,reservation_id,writer_generation::text,
          CASE WHEN outcome='completed' AND octet_length(descriptor::text)<=131072 THEN descriptor ELSE NULL END AS descriptor,
          CASE WHEN char_length(digest)=71 THEN digest ELSE NULL END AS digest,outcome,
          CASE WHEN char_length(descriptor->>'mediaType') BETWEEN 1 AND 1024 THEN descriptor->>'mediaType' ELSE NULL END AS media_type,committed_offset::text
         FROM ${tables.operationStreams} WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3
         AND owner_id=$4 AND physical_backend_id=$5 AND opening_owner_epoch=$6 FOR UPDATE`,
        [
          target.namespace,
          target.operationId,
          target.streamId,
          ownerId,
          backendId,
          caller.ownerEpoch,
        ],
      )).rows[0];
      if (!row) refuse("Owner cleanup target is unavailable.");
      if (
        row.outcome === "completed" &&
        (typeof row.digest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(row.digest))
      ) {
        refuse("Completed intent has no valid digest.");
      }
      if (
        row.outcome === "completed" && !isStreamOutputDescriptor(row.descriptor)
      ) {
        refuse("Seal descriptor is unavailable or exceeds its bound.");
      }
      const writer = capturePhysicalIdentity({
        bodyId: row.body_id,
        mediaType: row.media_type,
        reservationId: row.reservation_id,
        generation: Number(row.writer_generation),
      });
      if (
        writer.generation !== 1 ||
        writer.bodyId !==
          await deriveWorkflowId("stream-body", target.streamId) ||
        writer.reservationId !==
          await deriveWorkflowId("stream-reservation", target.streamId)
      ) {
        refuse("Owner cleanup physical identity is inconsistent.");
      }
      authorized.set(tx, {
        mode: "control",
        target,
        writer,
        descriptor: row.descriptor,
        sealDigest: row.outcome === "completed" ? row.digest : null,
        state: row.state,
        revocation: row.revocation_state,
        committedOffset: safeOffset(Number(row.committed_offset)),
      });
      current(tx, caller);
      return;
    }
    if (
      ![
        OWNER_STREAM_RESERVE,
        OWNER_STREAM_ABORT_TARGET,
        OWNER_STREAM_CONFIRM,
        OWNER_STREAM_WRITER,
        OWNER_STREAM_APPEND_ACK,
        OWNER_STREAM_CHECKPOINT,
        OWNER_STREAM_SEAL_INTENT,
      ].includes(command.kind)
    ) refuse();
    if (
      [
        OWNER_STREAM_WRITER,
        OWNER_STREAM_APPEND_ACK,
        OWNER_STREAM_CHECKPOINT,
        OWNER_STREAM_ABORT_TARGET,
        OWNER_STREAM_SEAL_INTENT,
      ]
        .includes(command.kind)
    ) {
      const input = record(
        command.intent,
        [OWNER_STREAM_WRITER, OWNER_STREAM_ABORT_TARGET].includes(command.kind)
          ? ["streamId"]
          : command.kind === OWNER_STREAM_SEAL_INTENT
          ? ["streamId", "length", "digest"]
          : command.kind === OWNER_STREAM_APPEND_ACK
          ? ["streamId", "startOffset", "endOffset"]
          : ["streamId", "startOffset", "endOffset", "head"],
      );
      const streamId = physicalIdentifier(input.streamId);
      const cleanup = command.kind === OWNER_STREAM_ABORT_TARGET;
      if (
        ![OWNER_STREAM_WRITER, OWNER_STREAM_SEAL_INTENT].includes(
          command.kind,
        ) && !cleanup
      ) offsets(input);
      const { scope, authority } = await authenticate(
        tx,
        caller,
        time,
        cleanup,
      );
      await lockOperation(tx, { scope }, cleanup);
      const bodyId = await deriveWorkflowId("stream-body", streamId);
      const reservationId = await deriveWorkflowId(
        "stream-reservation",
        streamId,
      );
      const found = (await tx.query<
        { media_type: string | null; committed_offset: string }
      >(
        `SELECT CASE WHEN char_length(descriptor->>'mediaType') BETWEEN 1 AND 1024 THEN descriptor->>'mediaType' ELSE NULL END AS media_type,
          committed_offset::text FROM ${tables.operationStreams}
         WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3 AND owner_id=$4
           AND opening_owner_epoch=$5 AND delivery_attempt=$6 AND placement_binding=$7::jsonb
           AND physical_backend_id=$8 AND body_id=$9 AND reservation_id=$10 AND writer_generation=1
           AND (($12 AND state<>'reserving') OR (NOT $12 AND state='open' AND revocation_state='active' AND protection_deadline>$11::timestamptz)) FOR UPDATE`,
        [
          scope.binding.namespace,
          scope.delivery.settlementScopeId,
          streamId,
          ownerId,
          caller.ownerEpoch,
          scope.delivery.attempts,
          JSON.stringify(scope.binding),
          backendId,
          bodyId,
          reservationId,
          time,
          cleanup,
        ],
      )).rows[0];
      if (!found) refuse();
      const committedOffset = safeOffset(Number(found.committed_offset));
      const writer = capturePhysicalIdentity({
        bodyId,
        mediaType: found.media_type,
        reservationId,
        generation: 1,
      });
      authorized.set(tx, {
        mode: "writer",
        cleanup,
        scope,
        authority,
        streamId,
        writer,
        committedOffset,
      });
      current(tx, caller);
      return;
    }
    const envelope = command.kind === OWNER_STREAM_RESERVE
      ? { open: command.intent }
      : record(command.intent, ["open", "head"]);
    const input = openInput(envelope.open);
    const { scope, authority } = await authenticate(tx, caller, time);
    const { binding, delivery, source } = scope;
    if (
      input.correlationId !== undefined &&
      input.correlationId !== source.correlationId
    ) {
      throw new TypeError(
        "Stream correlation must match its owner-derived source.",
      );
    }
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
      mode: "opening",
      scope,
      authority,
      input,
      writer,
      descriptor,
      streamId,
    });
    current(tx, caller);
  }
  async function lockOperation(
    tx: SqlExecutor,
    a: Pick<OpeningAuthorized, "scope">,
    cleanup = false,
  ) {
    const result = await tx.query<{ next_stream_ordinal: string }>(
      `SELECT next_stream_ordinal::text FROM ${tables.operations}
       WHERE namespace=$1 AND operation_id=$2 AND state IN ('accepted','running')
       AND ($3 OR cancellation_requested_at IS NULL) FOR UPDATE`,
      [a.scope.binding.namespace, a.scope.delivery.settlementScopeId, cleanup],
    );
    if (!result.rows[0]) refuse();
    return result.rows[0];
  }
  async function row(
    tx: SqlExecutor,
    a: OpeningAuthorized,
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
  async function excludePredecessors(tx: SqlExecutor, a: OpeningAuthorized) {
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
    const a = opening(context.tx, context.caller);
    await lockOperation(context.tx, a);
    await excludePredecessors(context.tx, a);
    let stored = await row(context.tx, a, context);
    if (!stored) {
      const outstanding = await context.tx.query(
        `SELECT stream_id FROM ${tables.operationStreams} WHERE owner_id=$1 AND revocation_state<>'revoked' LIMIT $2`,
        [ownerId, maxUnresolved],
      );
      if (outstanding.rows.length >= maxUnresolved) {
        refuse("Owner unresolved stream capacity exceeded.");
      }
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
    await rearm(context);
    return json({
      target: {
        namespace: a.scope.binding.namespace,
        operationId: a.scope.delivery.settlementScopeId,
        streamId: a.streamId,
      },
      writer: a.writer,
      descriptor: stored.state === "open"
        ? published(stored, a.descriptor)
        : null,
    });
  };
  const confirm: OwnerCheckpointHandler = async (value, context) => {
    const a = opening(context.tx, context.caller);
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
  const writerAdmission: OwnerCheckpointHandler = (_input, context) => {
    const a = writing(context.tx, context.caller);
    return json({ writer: a.writer, committedOffset: a.committedOffset });
  };
  const appendAcknowledgement: OwnerCheckpointHandler = (value, context) => {
    writing(context.tx, context.caller);
    return json(
      offsets(record(value, ["streamId", "startOffset", "endOffset"])),
    );
  };
  const checkpoint: OwnerCheckpointHandler = async (value, context) => {
    const a = writing(context.tx, context.caller);
    const input = record(value, [
      "streamId",
      "startOffset",
      "endOffset",
      "head",
    ]);
    const { startOffset, endOffset } = offsets(input);
    if (a.committedOffset >= endOffset) return { committedOffset: endOffset };
    if (a.committedOffset !== startOffset) {
      refuse("Checkpoint does not start at the accepted prefix.");
    }
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
      head.byteLength !== endOffset ||
      typeof head.versionToken !== "string" || !head.versionToken ||
      head.versionToken.length > 4096 ||
      Object.entries(a.writer).some(([key, value]) => head[key] !== value)
    ) refuse("Checkpoint physical head does not match.");
    await context.tx.query(
      `UPDATE ${tables.operationStreams} SET committed_offset=$4,updated_at=$5
      WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3`,
      [
        a.scope.binding.namespace,
        a.scope.delivery.settlementScopeId,
        a.streamId,
        endOffset,
        context.commandTime,
      ],
    );
    return { committedOffset: endOffset };
  };
  // Existing terminating/completed fields and digest are the durable seal
  // intent. No second physical ready state or per-body writer is introduced.
  const sealIntent: OwnerCheckpointHandler = async (value, context) => {
    const a = writing(context.tx, context.caller);
    const input = record(value, ["streamId", "length", "digest"]);
    if (
      safeOffset(input.length) !== a.committedOffset ||
      typeof input.digest !== "string" ||
      !/^sha256:[0-9a-f]{64}$/.test(input.digest)
    ) {
      refuse("Seal intent must match the accepted prefix.");
    }
    await context.tx.query(
      `UPDATE ${tables.operationStreams} SET state='terminating',outcome='completed',capture='complete',
       revocation_state='revoking',digest=$4,updated_at=$5
       WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3`,
      [
        a.scope.binding.namespace,
        a.scope.delivery.settlementScopeId,
        a.streamId,
        input.digest,
        context.commandTime,
      ],
    );
    await rearm(context);
    return {
      namespace: a.scope.binding.namespace,
      operationId: a.scope.delivery.settlementScopeId,
      streamId: a.streamId,
    };
  };
  const beginRevocation: OwnerCheckpointHandler = async (value, context) => {
    const a = controlling(context.tx, context.caller);
    const input = record(value, [
      "namespace",
      "operationId",
      "streamId",
      "outcome",
      "capture",
    ]);
    if (
      !["failed", "cancelled", "superseded", "abandoned"].includes(
        String(input.outcome),
      ) ||
      !["complete", "truncated"].includes(String(input.capture))
    ) throw new TypeError("Invalid stream termination.");
    if (a.revocation === "active") {
      await context.tx.query(
        `UPDATE ${tables.operationStreams} SET revocation_state='revoking',
          state=CASE WHEN state='reserving' THEN state ELSE 'terminating' END,
          outcome=CASE WHEN state='reserving' THEN NULL ELSE $4 END,
          capture=CASE WHEN state='reserving' THEN NULL ELSE $5 END,updated_at=$6
         WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3 AND opening_owner_epoch=$7`,
        [
          a.target.namespace,
          a.target.operationId,
          a.target.streamId,
          input.outcome,
          input.capture,
          context.commandTime,
          context.caller.ownerEpoch,
        ],
      );
    }
    await rearm(context);
    // The first revocation freezes the published terminal intent and C.
    return json({
      writer: a.writer,
      revoked: a.revocation === "revoked",
      sealDigest: a.sealDigest,
      committedOffset: a.committedOffset,
    });
  };
  const confirmRevocation: OwnerCheckpointHandler = async (value, context) => {
    const a = controlling(context.tx, context.caller);
    if (a.revocation === "active") {
      refuse("Stream must begin revocation before physical fencing.");
    }
    const input = record(value, [
      "namespace",
      "operationId",
      "streamId",
      "head",
      "verifiedDigest",
    ]);
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
      head.format !== "owner-physical-v1" || head.state !== "fenced" ||
      head.bodyId !== a.writer.bodyId ||
      head.mediaType !== a.writer.mediaType ||
      head.reservationId !== a.writer.reservationId ||
      head.generation !== a.writer.generation + 1 ||
      typeof head.versionToken !== "string" || !head.versionToken ||
      head.versionToken.length > 4096
    ) {
      refuse("Physical fence does not match the original writer.");
    }
    // null is a verifier-owned missing/short observation after the fence;
    // undefined means ordinary abort cleanup, not a content verification result.
    const available = safeOffset(head.byteLength) >= a.committedOffset &&
      input.verifiedDigest !== null;
    if (a.revocation !== "revoked") {
      const sealing = a.sealDigest !== null;
      if (!sealing && input.verifiedDigest !== undefined) refuse();
      if (
        sealing && input.verifiedDigest !== null &&
        (typeof input.verifiedDigest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(input.verifiedDigest))
      ) refuse();
      const accepted = sealing && available &&
        input.verifiedDigest === a.sealDigest;
      if (accepted) {
        if (!isStreamOutputDescriptor(a.descriptor)) {
          refuse("Seal descriptor is unavailable.");
        }
        const logicalBodyId = await deriveWorkflowId(
          "logical-body",
          a.target.streamId,
        );
        const pendingRef = await deriveWorkflowId(
          "pending-content",
          a.target.streamId,
        );
        const d = a.descriptor;
        const descriptor = json({
          kind: d.kind,
          role: d.role,
          mediaType: d.mediaType,
          name: d.name,
          alt: d.alt,
          language: d.language,
          disposition: d.disposition,
          metadata: d.metadata,
        });
        await context.tx.query(
          `INSERT INTO ${tables.logicalBodies}
          (namespace,logical_body_id,owner_id,producer_operation_id,producer_stream_id,
           media_type,byte_length,digest,current_copy,pending_ref,pending_descriptor,protected_until,created_at,updated_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11::jsonb,$12::timestamptz + $13 * interval '1 millisecond',$12,$12)`,
          [
            a.target.namespace,
            logicalBodyId,
            ownerId,
            a.target.operationId,
            a.target.streamId,
            a.writer.mediaType,
            a.committedOffset,
            a.sealDigest,
            JSON.stringify({
              backendId,
              key: a.writer.bodyId,
              reservationId: a.writer.reservationId,
              generation: head.generation,
              versionToken: head.versionToken,
            }),
            pendingRef,
            JSON.stringify(descriptor),
            context.commandTime,
            protectionMs,
          ],
        );
      }
      if (sealing && !accepted) {
        await context.tx.query(
          `UPDATE ${tables.operationStreams} SET outcome='failed',capture='truncated',digest=NULL
           WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3`,
          [a.target.namespace, a.target.operationId, a.target.streamId],
        );
      }
      await context.tx.query(
        `UPDATE ${tables.operationStreams} SET revocation_state='revoked',
          state=CASE WHEN state='reserving' THEN state ELSE 'terminal' END,
          terminal_at=CASE WHEN state='reserving' THEN NULL ELSE $4::timestamptz END,
          availability=CASE WHEN state='reserving' OR $5 THEN 'retained' ELSE 'missing' END,
          updated_at=$4 WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3 AND opening_owner_epoch=$6`,
        [
          a.target.namespace,
          a.target.operationId,
          a.target.streamId,
          context.commandTime,
          available,
          context.caller.ownerEpoch,
        ],
      );
      await rearm(context);
      context.afterCommit(() => onRevoked?.(structuredClone(a.target)));
    }
    return null;
  };
  const renew: OwnerCheckpointHandler = async (_input, context) => {
    const a = current(context.tx, context.caller);
    if (a.mode !== "renewal") refuse();
    const renewalTime = clockTime();
    if (Date.parse(renewalTime) >= Date.parse(a.deadline)) {
      refuse("Expired writers cannot renew.");
    }
    const changed = await context.tx.query(
      `UPDATE ${tables.operationStreams}
      SET protection_deadline=$4::timestamptz + $5 * interval '1 millisecond',updated_at=$4
      WHERE namespace=$1 AND operation_id=$2 AND stream_id=$3 AND owner_id=$6 AND opening_owner_epoch=$7
        AND revocation_state='active' AND state IN ('reserving','open') AND protection_deadline=$8::timestamptz
        AND protection_deadline>$4::timestamptz AND placement_binding=$9::jsonb AND delivery_attempt=$10
        AND body_id=$11 AND reservation_id=$12 AND writer_generation=$13
        AND descriptor->>'mediaType'=$14 AND physical_backend_id=$15 RETURNING stream_id`,
      [
        a.target.namespace,
        a.target.operationId,
        a.target.streamId,
        renewalTime,
        protectionMs,
        ownerId,
        context.caller.ownerEpoch,
        a.deadline,
        JSON.stringify(a.binding),
        a.ordinal,
        a.writer.bodyId,
        a.writer.reservationId,
        a.writer.generation,
        a.writer.mediaType,
        backendId,
      ],
    );
    if (changed.rows.length !== 1) {
      refuse("Stream deadline renewal lost its original attempt.");
    }
    await rearm(context);
    return null;
  };
  const scan: OwnerCheckpointHandler = async (_input, context) => {
    if (current(context.tx, context.caller).mode !== "scan") refuse();
    const rows = await context.tx.query<
      {
        namespace: string;
        operation_id: string;
        stream_id: string;
        epoch: string;
      }
    >(
      `SELECT CASE WHEN char_length(namespace)<=1024 THEN namespace END AS namespace,
        CASE WHEN char_length(operation_id)<=1024 THEN operation_id END AS operation_id,
        CASE WHEN char_length(stream_id)<=1024 THEN stream_id END AS stream_id,opening_owner_epoch::text AS epoch
       FROM ${tables.operationStreams} WHERE owner_id=$1 AND revocation_state='active'
         AND protection_deadline <= $2::timestamptz + $3 * interval '1 millisecond'
       ORDER BY protection_deadline,namespace,operation_id,stream_id LIMIT $4`,
      [
        ownerId,
        context.commandTime,
        Math.max(1, Math.floor(protectionMs / 2)),
        OWNER_STREAM_WORK_BATCH + 1,
      ],
    );
    const active = rows.rows.slice(0, OWNER_STREAM_WORK_BATCH).map((row) => {
      if (Number(row.epoch) !== context.caller.ownerEpoch) {
        refuse("Retained content requires separate recovery.");
      }
      return {
        namespace: physicalIdentifier(row.namespace),
        operationId: physicalIdentifier(row.operation_id),
        streamId: physicalIdentifier(row.stream_id),
      };
    });
    await rearm(context);
    return json({
      active,
      moreActive: rows.rows.length > OWNER_STREAM_WORK_BATCH,
    });
  };
  const scanCleanup: OwnerCheckpointHandler = async (_input, context) => {
    const a = current(context.tx, context.caller);
    if (a.mode !== "cleanup-scan") refuse();
    const after = a.after;
    const rows = await context.tx.query<
      {
        namespace: string;
        operation_id: string;
        stream_id: string;
        deadline: string;
        epoch: string;
      }
    >(
      `SELECT CASE WHEN char_length(namespace)<=1024 THEN namespace END AS namespace,
        CASE WHEN char_length(operation_id)<=1024 THEN operation_id END AS operation_id,
        CASE WHEN char_length(stream_id)<=1024 THEN stream_id END AS stream_id,
        protection_deadline::text AS deadline,opening_owner_epoch::text AS epoch
       FROM ${tables.operationStreams} WHERE owner_id=$1
         AND (revocation_state='revoking' OR ($2 AND revocation_state='active'))
         AND ($3::timestamptz IS NULL OR (protection_deadline,namespace,operation_id,stream_id)>($3::timestamptz,$4,$5,$6))
       ORDER BY protection_deadline,namespace,operation_id,stream_id LIMIT $7`,
      [
        ownerId,
        a.closing,
        after?.deadline ?? null,
        after?.namespace ?? null,
        after?.operationId ?? null,
        after?.streamId ?? null,
        OWNER_STREAM_WORK_BATCH + 1,
      ],
    );
    const targets = rows.rows.slice(0, OWNER_STREAM_WORK_BATCH).map((row) => {
      if (Number(row.epoch) !== context.caller.ownerEpoch) {
        refuse("Retained content requires separate recovery.");
      }
      return cleanupCursor({
        namespace: row.namespace,
        operationId: row.operation_id,
        streamId: row.stream_id,
        deadline: row.deadline,
      });
    });
    return json({ targets, more: rows.rows.length > OWNER_STREAM_WORK_BATCH });
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
      [OWNER_STREAM_RENEW]: renew,
      [OWNER_STREAM_SCAN]: scan,
      [OWNER_STREAM_CLEANUP_SCAN]: scanCleanup,
      [OWNER_STREAM_RESERVE]: reserve,
      [OWNER_STREAM_CONFIRM]: confirm,
      [OWNER_STREAM_WRITER]: writerAdmission,
      [OWNER_STREAM_APPEND_ACK]: appendAcknowledgement,
      [OWNER_STREAM_CHECKPOINT]: checkpoint,
      [OWNER_STREAM_SEAL_INTENT]: sealIntent,
      [OWNER_STREAM_ABORT_TARGET]: (_input: OwnerJson, context: Context) => {
        const a = writing(context.tx, context.caller);
        if (!a.cleanup) refuse();
        return {
          namespace: a.scope.binding.namespace,
          operationId: a.scope.delivery.settlementScopeId,
          streamId: a.streamId,
        };
      },
      [OWNER_STREAM_REVOKE]: beginRevocation,
      [OWNER_STREAM_REVOKED]: confirmRevocation,
    },
    async renew(
      boundary: OwnerCommandBoundary,
      caller: OwnerCaller,
      selected: OwnerStreamTarget,
    ): Promise<void> {
      await boundary.checkpoint(
        structuredClone(caller),
        OWNER_STREAM_RENEW,
        target(selected),
      );
    },
    async scanCleanup(
      boundary: OwnerCommandBoundary,
      caller: OwnerCaller,
      after: OwnerStreamCleanupCursor | null = null,
      closing = false,
    ): Promise<{ targets: OwnerStreamCleanupCursor[]; more: boolean }> {
      const result = record(
        await boundary.checkpoint(
          structuredClone(caller),
          OWNER_STREAM_CLEANUP_SCAN,
          json({
            after: after === null ? null : cleanupCursor(after),
            closing,
          }),
        ),
        ["targets", "more"],
      );
      if (
        !Array.isArray(result.targets) ||
        result.targets.length > OWNER_STREAM_WORK_BATCH ||
        typeof result.more !== "boolean"
      ) refuse();
      return { targets: result.targets.map(cleanupCursor), more: result.more };
    },
    async scan(
      boundary: OwnerCommandBoundary,
      caller: OwnerCaller,
    ): Promise<
      {
        active: OwnerStreamTarget[];
        moreActive: boolean;
      }
    > {
      const result = await boundary.checkpoint(
        structuredClone(caller),
        OWNER_STREAM_SCAN,
        null,
      ) as unknown as {
        active: unknown[];
        moreActive: unknown;
      };
      if (
        !result || typeof result.moreActive !== "boolean" ||
        !Array.isArray(result.active) ||
        result.active.length > OWNER_STREAM_WORK_BATCH
      ) refuse();
      return {
        moreActive: result.moreActive as boolean,
        active: result.active.map(target),
      };
    },
    async abortTarget(
      boundary: OwnerCommandBoundary,
      caller: OwnerCaller,
      streamId: string,
    ): Promise<OwnerStreamTarget> {
      const result = record(
        await boundary.checkpoint(
          structuredClone(caller),
          OWNER_STREAM_ABORT_TARGET,
          { streamId: physicalIdentifier(streamId) },
        ),
        ["namespace", "operationId", "streamId"],
      );
      return {
        namespace: physicalIdentifier(result.namespace),
        operationId: physicalIdentifier(result.operationId),
        streamId: physicalIdentifier(result.streamId),
      };
    },
    async beginSeal(
      boundary: OwnerCommandBoundary,
      caller: OwnerCaller,
      streamIdInput: string,
      length: number,
      signal?: AbortSignal,
    ): Promise<OwnerStreamTarget> {
      const captured = structuredClone(caller),
        streamId = physicalIdentifier(streamIdInput);
      const accepted = safeOffset(length);
      const admission = record(
        await boundary.checkpoint(captured, OWNER_STREAM_WRITER, { streamId }, {
          signal,
        }),
        ["writer", "committedOffset"],
      );
      if (safeOffset(admission.committedOffset) !== accepted) {
        refuse("Seal requires a final accepted checkpoint.");
      }
      const proof = await digestPhysicalPrefix(
        physical,
        capturePhysicalIdentity(admission.writer),
        accepted,
        "open",
        signal,
      );
      return target(
        await boundary.checkpoint(captured, OWNER_STREAM_SEAL_INTENT, {
          streamId,
          length: accepted,
          digest: proof.digest,
        }, { signal }),
      );
    },
    async beginRevocation(
      boundary: OwnerCommandBoundary,
      caller: OwnerCaller,
      selected: OwnerStreamTarget,
      input: ContentStreamAbortInput = {},
    ): Promise<void> {
      await boundary.checkpoint(structuredClone(caller), OWNER_STREAM_REVOKE, {
        ...target(selected),
        outcome: input.outcome ?? "abandoned",
        capture: input.capture ?? "truncated",
      });
    },
    /** Owner-control cleanup remains possible after the producing caller is gone.
     * A held/unknown fence leaves the durable row revoking and its prefix intact. */
    async revoke(
      boundary: OwnerCommandBoundary,
      caller: OwnerCaller,
      target: OwnerStreamTarget,
      input: ContentStreamAbortInput = {},
    ): Promise<void> {
      const captured = structuredClone(caller);
      const request = {
        namespace: physicalIdentifier(target.namespace),
        operationId: physicalIdentifier(target.operationId),
        streamId: physicalIdentifier(target.streamId),
      };
      const result = record(
        await boundary.checkpoint(captured, OWNER_STREAM_REVOKE, {
          ...request,
          outcome: input.outcome ?? "abandoned",
          capture: input.capture ?? "truncated",
        }),
        ["writer", "revoked", "sealDigest", "committedOffset"],
      );
      if (result.revoked === true) return;
      if (result.revoked !== false) refuse();
      const writer = capturePhysicalIdentity(result.writer);
      let head: PhysicalBodyHead;
      try {
        head = await physical.fence(writer);
      } catch (error) {
        throw Object.assign(
          new Error("Physical stream fence outcome is unknown.", {
            cause: error,
          }),
          {
            code: "content_fence_unknown",
            indeterminate: true,
          },
        );
      }
      let verifiedDigest: string | null | undefined;
      if (result.sealDigest !== null) {
        if (
          typeof result.sealDigest !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(result.sealDigest)
        ) refuse();
        try {
          const proof = await digestPhysicalPrefix(
            physical,
            writer,
            safeOffset(result.committedOffset),
            "fenced",
          );
          verifiedDigest = proof.digest;
          head = proof.head;
        } catch (error) {
          // A known missing/short copy cannot complete a seal. Unknown I/O must
          // retain the intent for another owner-controlled recovery attempt.
          if (error instanceof PhysicalPrefixUnavailableError) {
            verifiedDigest = null;
          } else {
            throw Object.assign(
              new Error("Seal verification outcome is unresolved.", {
                cause: error,
              }),
              { code: "content_seal_unknown", indeterminate: true },
            );
          }
        }
      }
      await boundary.checkpoint(
        captured,
        OWNER_STREAM_REVOKED,
        json({ ...request, head, verifiedDigest }),
      );
    },
    async append(
      boundary: OwnerCommandBoundary,
      caller: OwnerCaller,
      streamIdInput: string,
      appendInput: Parameters<typeof capturePhysicalAppendData>[0],
      signal?: AbortSignal,
    ) {
      const capturedCaller = structuredClone(caller),
        streamId = physicalIdentifier(streamIdInput);
      const append = capturePhysicalAppendData(appendInput);
      const admission = record(
        await boundary.checkpoint(capturedCaller, OWNER_STREAM_WRITER, {
          streamId,
        }, { signal }),
        ["writer", "committedOffset"],
      );
      if (signal?.aborted) throw signal.reason;
      const writer = capturePhysicalIdentity(admission.writer);
      const result = await physical.append({ writer, ...append });
      if (signal?.aborted) throw signal.reason;
      const observed = record(result, [
        "startOffset",
        "endOffset",
        "versionToken",
      ]);
      if (
        observed.startOffset !== append.expectedOffset ||
        safeOffset(observed.endOffset) <
          append.expectedOffset + append.bytes.byteLength ||
        typeof observed.versionToken !== "string" || !observed.versionToken ||
        observed.versionToken.length > 4096
      ) refuse("Physical append acknowledgement does not match.");
      const answer = record(
        await boundary.checkpoint(capturedCaller, OWNER_STREAM_APPEND_ACK, {
          streamId,
          startOffset: append.expectedOffset,
          endOffset: append.expectedOffset + append.bytes.byteLength,
        }, { signal }),
        ["startOffset", "endOffset"],
      );
      if (signal?.aborted) throw signal.reason;
      return offsets(answer);
    },
    async checkpoint(
      boundary: OwnerCommandBoundary,
      caller: OwnerCaller,
      streamIdInput: string,
      startInput: number,
      endInput: number,
      signal?: AbortSignal,
    ) {
      const capturedCaller = structuredClone(caller),
        streamId = physicalIdentifier(streamIdInput);
      const { startOffset, endOffset } = offsets({
        startOffset: startInput,
        endOffset: endInput,
      });
      const admission = record(
        await boundary.checkpoint(capturedCaller, OWNER_STREAM_WRITER, {
          streamId,
        }, { signal }),
        ["writer", "committedOffset"],
      );
      if (signal?.aborted) throw signal.reason;
      const committed = safeOffset(admission.committedOffset);
      if (committed >= endOffset) return { committedOffset: endOffset };
      if (committed !== startOffset) {
        refuse("Checkpoint does not start at the accepted prefix.");
      }
      const writer = capturePhysicalIdentity(admission.writer);
      const head = await physical.head(writer.bodyId);
      if (signal?.aborted) throw signal.reason;
      if (!head) refuse("Checkpoint physical body is missing.");
      const result = record(
        await boundary.checkpoint(
          capturedCaller,
          OWNER_STREAM_CHECKPOINT,
          json({ streamId, startOffset, endOffset, head }),
          { signal },
        ),
        ["committedOffset"],
      );
      if (signal?.aborted) throw signal.reason;
      if (safeOffset(result.committedOffset) !== endOffset) refuse();
      return { committedOffset: endOffset };
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
        ["writer", "descriptor", "target"],
      );
      const orphan = target(reserved.target);
      try {
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
      } catch (error) {
        if (cleanupOrphan) {
          try {
            await cleanupOrphan(orphan);
          } catch (cleanup) {
            throw Object.assign(
              new AggregateError(
                [error, cleanup],
                "Stream opening failed and owner cleanup is unresolved.",
              ),
              {
                code: "content_open_cleanup_unknown",
                indeterminate: true,
              },
            );
          }
        }
        throw error;
      }
    },
  };
}
