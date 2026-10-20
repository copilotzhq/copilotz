import {
  createSchemaCommandRunner,
  schemaCommandContext,
} from "../engine/commands.ts";
import { createCoreTableNames } from "./schema.ts";
import { afterSqlCommit, type SqlExecutor } from "./session.ts";
import type { DurableEvent } from "./types.ts";

export type OwnerPushPosition = Readonly<{
  namespace: string;
  operationId: string;
  streamId: string;
  committedOffset: number;
}>;
export type OwnerChange = Readonly<{
  selectionKeys: readonly string[];
  namespace: string;
  operationId: string;
  kind: "event" | "operation" | "stream" | "stream-offset" | "retirement";
  seq: string;
  streamId?: string;
  committedOffset?: number;
  event?: DurableEvent;
}>;
export type OwnerPushFrame =
  | Readonly<
    { kind: "change"; change: OwnerChange; headSeq: string; revision: number }
  >
  | Readonly<
    {
      kind: "checkpoint";
      headSeq: string;
      bodyRevision?: number;
      sequenced?: boolean;
    }
  >
  | Readonly<
    {
      kind: "heartbeat";
      headSeq: string;
      positions: readonly OwnerPushPosition[];
      bodyRevision?: number;
    }
  >
  | Readonly<{ kind: "reset"; headSeq: string; reason: string }>;
export type OwnerPushSubscription = Readonly<{
  cursor: string;
  close(): void;
  heartbeat(): void;
  readTail?(offset: number): Uint8Array | undefined;
  snapshot(): Readonly<
    {
      headSeq: string;
      positions: readonly OwnerPushPosition[];
      bodyRevision?: number;
    }
  >;
}>;
type Listener = {
  send(frame: OwnerPushFrame): void;
  namespace?: string;
  operationId?: string;
  bodyId?: string;
};
type Hub = {
  head: string;
  revision: number;
  positions: Map<string, OwnerPushPosition>;
  bodies: Map<string, { revision: number; references: number }>;
  listeners: Set<Listener>;
  tails: Map<string, OwnerBodyTail>;
  timer?: ReturnType<typeof setInterval>;
};
const hubs = new WeakMap<AbortSignal, Hub>();
function hubFor(signal: AbortSignal): Hub {
  let hub = hubs.get(signal);
  if (hub) return hub;
  hub = {
    head: "0",
    revision: 0,
    positions: new Map(),
    bodies: new Map(),
    listeners: new Set(),
    tails: new Map(),
  };
  hubs.set(signal, hub);
  const captured = hub;
  signal.addEventListener("abort", () => {
    clearInterval(captured.timer);
    for (const listener of captured.listeners) {
      deliver(captured, listener, {
        kind: "reset",
        headSeq: captured.head,
        reason: "owner_lost",
      });
    }
    captured.listeners.clear();
    captured.positions.clear();
    captured.bodies.clear();
    for (const tail of captured.tails.values()) tail.close();
  }, { once: true });
  return hub;
}
function detach(hub: Hub, listener: Listener): void {
  if (!hub.listeners.delete(listener)) return;
  if (listener.bodyId !== undefined) {
    const body = hub.bodies.get(listener.bodyId);
    if (body && --body.references === 0) hub.bodies.delete(listener.bodyId);
  }
  if (!hub.listeners.size) {
    clearInterval(hub.timer);
    hub.timer = undefined;
    hub.positions.clear();
  }
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function deliver(hub: Hub, listener: Listener, frame: OwnerPushFrame): void {
  try {
    if (listener.bodyId !== undefined && frame.kind === "change") return;
    if (
      frame.kind === "change" &&
      ((listener.namespace !== undefined &&
        listener.namespace !== frame.change.namespace) ||
        (listener.operationId !== undefined &&
          listener.operationId !== frame.change.operationId))
    ) {
      listener.send({
        kind: "checkpoint",
        headSeq: frame.headSeq,
        sequenced: !!frame.change.event,
      });
    } else listener.send(immutable(frame));
  } catch {
    detach(hub, listener);
    try {
      listener.send({
        kind: "reset",
        headSeq: hub.head,
        reason: "push_failed",
      });
    } catch { /* disconnected */ }
  }
}
function snapshot(hub: Hub, listener: Listener) {
  return {
    headSeq: hub.head,
    ...(listener.bodyId === undefined
      ? {}
      : { bodyRevision: hub.bodies.get(listener.bodyId)?.revision ?? 0 }),
    positions: listener.bodyId === undefined
      ? [...hub.positions.values()].filter((position) =>
        (listener.namespace === undefined ||
          position.namespace === listener.namespace) &&
        (listener.operationId === undefined ||
          position.operationId === listener.operationId)
      )
      : [],
  };
}
function heartbeat(hub: Hub, listener: Listener): void {
  deliver(hub, listener, { kind: "heartbeat", ...snapshot(hub, listener) });
}
/** Owner-local tentative bytes. The catalog checkpoint is their only durable receipt. */
export type OwnerBodyTail = {
  append(offset: number, bytes: Uint8Array): void;
  read(offset: number): Uint8Array | undefined;
  committed(offset: number): void;
  bytes(): Uint8Array;
  close(): void;
};
export function openOwnerBodyTail(
  signal: AbortSignal,
  bodyId: string,
): OwnerBodyTail {
  signal.throwIfAborted();
  const hub = hubFor(signal);
  if (hub.tails.has(bodyId) || hub.tails.size >= 4096) {
    throw new Error("Owner stream tail capacity or identity conflict.");
  }
  let chunks: { offset: number; bytes: Uint8Array }[] = [];
  let byteLength = 0;
  const tail: OwnerBodyTail = {
    append(offset, bytes) {
      signal.throwIfAborted();
      if (hub.tails.get(bodyId) !== tail) {
        throw new Error("Stream tail was revoked.");
      }
      const last = chunks.at(-1);
      if (
        byteLength + bytes.length > 1024 * 1024 ||
        last && last.offset + last.bytes.length !== offset
      ) {
        throw new Error("Stream tail exceeds its bounded contiguous prefix.");
      }
      chunks.push({ offset, bytes: bytes.slice() });
      byteLength += bytes.length;
      notifyOwnerBodyChange(signal, bodyId);
    },
    read(offset) {
      if (signal.aborted) return undefined;
      const chunk = chunks.find((part) =>
        part.offset <= offset && part.offset + part.bytes.length > offset
      );
      return chunk?.bytes.slice(offset - chunk.offset);
    },
    bytes() {
      signal.throwIfAborted();
      const bytes = new Uint8Array(byteLength);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk.bytes, offset);
        offset += chunk.bytes.length;
      }
      return bytes;
    },
    committed(offset) {
      chunks = chunks.filter((part) => {
        if (part.offset + part.bytes.length > offset) return true;
        byteLength -= part.bytes.length;
        return false;
      });
    },
    close() {
      chunks = [];
      byteLength = 0;
      if (hub.tails.get(bodyId) === tail) hub.tails.delete(bodyId);
    },
  };
  hub.tails.set(bodyId, tail);
  return tail;
}
export function discardOwnerBodyTail(
  signal: AbortSignal,
  bodyId: string,
): void {
  hubs.get(signal)?.tails.get(bodyId)?.close();
}

/** An invalidation only: physical completion never advances the accepted offset. */
export function notifyOwnerBodyChange(
  signal: AbortSignal,
  bodyId: string,
): void {
  if (signal.aborted) return;
  const hub = hubs.get(signal), body = hub?.bodies.get(bodyId);
  if (!hub || !body) return;
  body.revision++;
  deliverBodyChange(hub, bodyId, body.revision);
}
function deliverBodyChange(
  hub: Hub,
  bodyId: string,
  bodyRevision: number,
): void {
  for (const listener of [...hub.listeners]) {
    if (listener.bodyId === bodyId) {
      deliver(hub, listener, {
        kind: "checkpoint",
        headSeq: hub.head,
        bodyRevision,
      });
    }
  }
}
/** The revision records confirmed logical changes independently of delivery. */
export function stageOwnerBodyChange(
  transaction: SqlExecutor,
  schema: string,
  bodyId: string,
): void {
  const context = schemaCommandContext(transaction, schema);
  const hub = hubFor(context.signal);
  let body: { revision: number; references: number } | undefined;
  let revision: number | undefined;
  afterSqlCommit(transaction, () => {
    body = hub.bodies.get(bodyId);
    if (body) revision = ++body.revision;
  });
  context.afterCommit(() => {
    if (revision !== undefined && hub.bodies.get(bodyId) === body) {
      deliverBodyChange(hub, bodyId, revision);
    }
  });
}
/** The committed head advances separately from delivery, so a lost final push is detectable. */
export function stageOwnerChange(
  transaction: SqlExecutor,
  schema: string,
  change: OwnerChange,
): void {
  if (
    !change.namespace.trim() || !change.operationId.trim() ||
    !/^(0|[1-9][0-9]*)$/.test(change.seq) ||
    !["event", "operation", "stream", "stream-offset", "retirement"].includes(
      change.kind,
    ) ||
    change.selectionKeys.some((key) => typeof key !== "string") ||
    (change.streamId !== undefined && !change.streamId.trim()) ||
    (change.committedOffset !== undefined &&
      (!Number.isSafeInteger(change.committedOffset) ||
        change.committedOffset < 0))
  ) throw new TypeError("Invalid owner push change.");
  const context = schemaCommandContext(transaction, schema);
  const hub = hubFor(context.signal);
  const captured = immutable(structuredClone(change));
  let revision = 0;
  afterSqlCommit(transaction, () => {
    revision = ++hub.revision;
    if (BigInt(captured.seq) > BigInt(hub.head)) hub.head = captured.seq;
    if (
      hub.listeners.size && captured.streamId &&
      captured.committedOffset !== undefined
    ) {
      const position = {
        namespace: captured.namespace,
        operationId: captured.operationId,
        streamId: captured.streamId,
        committedOffset: captured.committedOffset,
      };
      const positionKey = JSON.stringify([
        position.namespace,
        position.operationId,
        position.streamId,
      ]);
      if (!hub.positions.has(positionKey) && hub.positions.size >= 4096) {
        for (const listener of [...hub.listeners]) {
          deliver(hub, listener, {
            kind: "reset",
            headSeq: hub.head,
            reason: "push_capacity",
          });
        }
        for (const listener of [...hub.listeners]) detach(hub, listener);
        clearInterval(hub.timer);
        hub.timer = undefined;
        hub.positions.clear();
        return;
      }
      hub.positions.set(positionKey, position);
    }
    if (captured.kind === "retirement") {
      for (const [key, value] of hub.positions) {
        if (
          value.namespace === captured.namespace &&
          value.operationId === captured.operationId
        ) hub.positions.delete(key);
      }
    }
  });
  context.afterCommit(() => {
    for (const listener of [...hub.listeners]) {
      deliver(hub, listener, {
        kind: "change",
        change: captured,
        headSeq: captured.seq,
        revision,
      });
    }
  });
}
/** Register and capture the cursor at the same serialized commit boundary. */
export async function attachOwnerPush(
  session: SqlExecutor,
  schema: string,
  send: Listener["send"],
  options: Readonly<
    { namespace?: string; operationId?: string; bodyId?: string }
  > = {},
): Promise<OwnerPushSubscription> {
  return await createSchemaCommandRunner(session, schema)(
    "observation.attach",
    {},
    async (_input, context) => {
      const result = await context.transaction.query<
        { last_seq: string | number }
      >(
        `SELECT last_seq FROM ${
          createCoreTableNames(schema).owner_epochs
        } WHERE owner='schema'`,
      );
      const cursor = String(result.rows[0]?.last_seq ?? "0");
      const hub = hubFor(context.signal);
      if (
        options.bodyId !== undefined && !hub.bodies.has(options.bodyId) &&
        hub.bodies.size >= 4096
      ) {
        throw Object.assign(
          new Error("Owner body observation capacity exceeded."),
          { code: "observation_capacity" },
        );
      }
      let closed = false;
      let attachedRevision = 0;
      const listener: Listener = {
        ...options,
        send(frame) {
          if (closed) return;
          // Publications queued before attach cannot cross its captured frontier.
          if (
            frame.kind === "change" && frame.revision <= attachedRevision
          ) return;
          send(frame);
        },
      };
      afterSqlCommit(context.transaction, () => {
        if (closed || context.signal.aborted) return;
        // Multiple attaches can join one command; enforce the bound at commit too.
        if (
          listener.bodyId !== undefined && !hub.bodies.has(listener.bodyId) &&
          hub.bodies.size >= 4096
        ) {
          listener.send({
            kind: "reset",
            headSeq: hub.head,
            reason: "push_capacity",
          });
          return;
        }
        if (BigInt(cursor) > BigInt(hub.head)) hub.head = cursor;
        attachedRevision = hub.revision;
        hub.listeners.add(listener);
        if (listener.bodyId !== undefined) {
          const body = hub.bodies.get(listener.bodyId) ??
            { revision: 0, references: 0 };
          body.references++;
          hub.bodies.set(listener.bodyId, body);
        }
        hub.timer ??= setInterval(() => {
          for (const item of [...hub.listeners]) heartbeat(hub, item);
        }, 1000);
      });
      return {
        cursor,
        readTail: (offset: number) =>
          options.bodyId === undefined
            ? undefined
            : hub.tails.get(options.bodyId)?.read(offset),
        heartbeat: () => heartbeat(hub, listener),
        snapshot: () => ({
          headSeq: hub.head,
          positions: [...hub.positions.values()],
          ...(listener.bodyId === undefined
            ? {}
            : { bodyRevision: hub.bodies.get(listener.bodyId)?.revision ?? 0 }),
        }),
        close() {
          if (closed) return;
          closed = true;
          detach(hub, listener);
        },
      };
    },
  );
}

export type OwnerPushWatch = Readonly<{
  wait(): Promise<void>;
  close(): void;
  readTail?(offset: number): Uint8Array | undefined;
}>;

/** One coalesced invalidation, repaired from the shared owner's heartbeat. */
export async function watchOwnerPush(
  session: SqlExecutor,
  schema: string,
  options: Readonly<{
    namespace?: string;
    bodyId?: string;
    relevant?: (change: OwnerChange) => boolean;
  }> = {},
): Promise<OwnerPushWatch> {
  let changed = false, closed = false, reset = false;
  let failure: Error | undefined, head = "0", bodyRevision = 0;
  let pending: (() => void) | undefined;
  let subscription: OwnerPushSubscription | undefined;
  const wake = () => {
    changed = true;
    pending?.();
  };
  const attach = async () => {
    subscription = await attachOwnerPush(session, schema, (frame) => {
      if (frame.kind === "reset") {
        if (frame.reason === "owner_lost") {
          failure = new Error("Observation owner was lost.");
        } else reset = true;
        wake();
      } else if (options.bodyId !== undefined) {
        if (
          "bodyRevision" in frame && frame.bodyRevision !== undefined &&
          frame.bodyRevision > bodyRevision
        ) {
          bodyRevision = frame.bodyRevision;
          wake();
        }
      } else {
        const gap = BigInt(frame.headSeq) >
          BigInt(head) + ((frame.kind === "change" && frame.change.event) ||
                (frame.kind === "checkpoint" && frame.sequenced)
              ? 1n
              : 0n);
        if (BigInt(frame.headSeq) > BigInt(head)) head = frame.headSeq;
        if (
          gap ||
          (frame.kind === "change" &&
            (options.relevant?.(frame.change) ?? true))
        ) wake();
      }
    }, options);
    head = subscription.cursor;
    bodyRevision = subscription.snapshot().bodyRevision ?? 0;
    if (closed) subscription.close();
  };
  await attach();
  return {
    readTail: (offset) => subscription?.readTail?.(offset),
    async wait() {
      if (!changed && !closed) {
        await new Promise<void>((resolve) => {
          pending = resolve;
        });
      }
      pending = undefined;
      if (failure) throw failure;
      if (closed) return;
      changed = false;
      if (reset) {
        reset = false;
        subscription?.close();
        await attach();
      }
    },
    close() {
      closed = true;
      subscription?.close();
      pending?.();
    },
  };
}
