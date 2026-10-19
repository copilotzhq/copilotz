import {
  createSchemaCommandRunner,
  schemaCommandContext,
} from "../engine/commands.ts";
import { createCoreTableNames } from "./schema.ts";
import {
  afterSqlCommit,
  type SqlExecutor,
  type SqlSession,
} from "./session.ts";
import type { DurableEvent } from "./types.ts";

export type OwnerPushPosition = Readonly<{
  namespace: string;
  operationId: string;
  streamId: string;
  committedOffset: number;
}>;
export type OwnerChange = Readonly<{
  namespace: string;
  operationId: string;
  selectionKeys: readonly string[];
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
  | Readonly<{ kind: "checkpoint"; headSeq: string }>
  | Readonly<
    {
      kind: "heartbeat";
      headSeq: string;
      positions: readonly OwnerPushPosition[];
    }
  >
  | Readonly<{ kind: "reset"; headSeq: string; reason: string }>;
export type OwnerPushSubscription = Readonly<{
  cursor: string;
  close(): void;
  heartbeat(): void;
  snapshot(): Readonly<
    { headSeq: string; positions: readonly OwnerPushPosition[] }
  >;
}>;
type Listener = {
  send(frame: OwnerPushFrame): void;
  namespace?: string;
  operationId?: string;
};
type Hub = {
  head: string;
  revision: number;
  positions: Map<string, OwnerPushPosition>;
  listeners: Set<Listener>;
  timer?: ReturnType<typeof setInterval>;
};
const hubs = new WeakMap<AbortSignal, Hub>();
function hubFor(signal: AbortSignal): Hub {
  let hub = hubs.get(signal);
  if (hub) return hub;
  hub = { head: "0", revision: 0, positions: new Map(), listeners: new Set() };
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
  }, { once: true });
  return hub;
}
function deliver(hub: Hub, listener: Listener, frame: OwnerPushFrame): void {
  try {
    if (
      frame.kind === "change" &&
      ((listener.namespace !== undefined &&
        listener.namespace !== frame.change.namespace) ||
        (listener.operationId !== undefined &&
          listener.operationId !== frame.change.operationId))
    ) {
      listener.send({ kind: "checkpoint", headSeq: frame.headSeq });
    } else listener.send(structuredClone(frame));
  } catch {
    hub.listeners.delete(listener);
    try {
      listener.send({
        kind: "reset",
        headSeq: hub.head,
        reason: "push_failed",
      });
    } catch { /* disconnected */ }
    if (!hub.listeners.size) {
      clearInterval(hub.timer);
      hub.timer = undefined;
    }
  }
}
function snapshot(hub: Hub, listener: Listener) {
  return {
    headSeq: hub.head,
    positions: [...hub.positions.values()].filter((position) =>
      (listener.namespace === undefined ||
        position.namespace === listener.namespace) &&
      (listener.operationId === undefined ||
        position.operationId === listener.operationId)
    ),
  };
}
function heartbeat(hub: Hub, listener: Listener): void {
  deliver(hub, listener, { kind: "heartbeat", ...snapshot(hub, listener) });
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
  const captured = structuredClone(change);
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
        hub.listeners.clear();
        clearInterval(hub.timer);
        hub.timer = undefined;
        hub.positions.clear();
        return;
      }
      hub.positions.set(
        JSON.stringify([
          position.namespace,
          position.operationId,
          position.streamId,
        ]),
        position,
      );
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
  session: SqlSession,
  schema: string,
  send: Listener["send"],
  options: Readonly<{ namespace?: string; operationId?: string }> = {},
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
        if (BigInt(cursor) > BigInt(hub.head)) hub.head = cursor;
        attachedRevision = hub.revision;
        hub.listeners.add(listener);
        hub.timer ??= setInterval(() => {
          for (const item of [...hub.listeners]) heartbeat(hub, item);
        }, 1000);
      });
      return {
        cursor,
        heartbeat: () => heartbeat(hub, listener),
        snapshot: () => ({
          headSeq: hub.head,
          positions: [...hub.positions.values()],
        }),
        close() {
          if (closed) return;
          closed = true;
          hub.listeners.delete(listener);
          if (!hub.listeners.size) {
            clearInterval(hub.timer);
            hub.timer = undefined;
            hub.positions.clear();
          }
        },
      };
    },
  );
}
