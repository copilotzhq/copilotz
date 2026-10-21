import { compareCodePoints } from "../runtime/collections/predicate.ts";
import type {
  CollectionQuery,
  CollectionRecord,
} from "../runtime/collections/types.ts";
import type {
  CollectionSubscription,
  SubscriptionDelta,
  SubscriptionFrame,
  SubscriptionOptions,
} from "../runtime/subscriptions/types.ts";

export type OperationResult<T = unknown> = Readonly<{ value: T; seq: string }>;
/** The device binding supplies this capability after authenticated admission. */
export type SubscriptionTransport = Readonly<{
  observe(
    collection: string,
    query: CollectionQuery,
    options: SubscriptionOptions,
  ): Promise<CollectionSubscription>;
}>;
export type LiveQueryOptions =
  & SubscriptionOptions
  & Readonly<{
    /** Persist rows and sequence together with the applied checkpoint for a new handle. */
    initial?: Readonly<
      {
        rows: readonly CollectionRecord[];
        sequence: string;
        checkpoint: string;
      }
    >;
    /** State notifications follow application; listener errors are isolated. */
    onState?(frame?: SubscriptionFrame): void;
    /** Called with the proposed state. Throwing detaches without applying it. */
    onChange?(
      rows: readonly CollectionRecord[],
      frame: SubscriptionFrame,
    ): void | Promise<void>;
  }>;
export type LiveQuery = Readonly<{
  status: "loading" | "ready" | "stale" | "denied";
  rows: readonly CollectionRecord[];
  deltas: readonly SubscriptionDelta[];
  checkpoint: string | undefined;
  sequence: string | undefined;
  optimisticLayers: ReadonlyMap<string, unknown>;
  done: Promise<void>;
  optimistic(
    id: string,
    value: unknown,
    result: Promise<OperationResult>,
  ): void;
  reconnect(): Promise<void>;
  close(): void;
}>;
const sequence = (value: string) => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new TypeError("Invalid subscription sequence.");
  }
  return BigInt(value);
};

/** Shared SDK state machine for device and in-process bindings. */
export function createLiveQuery(
  transport: SubscriptionTransport,
  collection: string,
  query: CollectionQuery,
  options: LiveQueryOptions = {},
): LiveQuery {
  query = structuredClone(query);
  const content = structuredClone(options.content);
  const progressOnly = options.progressOnly;
  if (
    options.checkpoint &&
    (!options.initial || options.initial.checkpoint !== options.checkpoint)
  ) {
    throw new TypeError(
      "Resume requires the rows and sequence belonging to the applied checkpoint.",
    );
  }
  let rows: readonly CollectionRecord[] = structuredClone(
      options.initial?.rows ?? [],
    ),
    deltas: readonly SubscriptionDelta[] = [];
  let checkpoint = options.initial?.checkpoint,
    applied = options.initial?.sequence;
  if (applied !== undefined) sequence(applied);
  let attached: CollectionSubscription | undefined,
    closed = false,
    running = false;
  let generation = 0, resync = false;
  const layers = new Map<string, { value: unknown; seq?: string }>();
  const abort = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, abort.signal])
    : abort.signal;
  let status: LiveQuery["status"] = options.initial ? "ready" : "loading";
  const notify = (frame?: SubscriptionFrame) => {
    try {
      options.onState?.(frame);
    } catch { /* Subscriber isolation. */ }
  };
  const deny = () => {
    status = "denied";
    rows = [];
    deltas = [];
    checkpoint = undefined;
    applied = undefined;
    layers.clear();
    closed = true;
  };
  const settle = () => {
    for (const [id, layer] of layers) {
      if (applied && layer.seq && sequence(layer.seq) <= sequence(applied)) {
        layers.delete(id);
      }
    }
  };
  const apply = async (frame: SubscriptionFrame, current: number) => {
    if (frame.t === "revoked") {
      deny();
      notify(frame);
      throw Object.assign(new Error("Subscription revoked."), {
        code: "revoked",
      });
    }
    if (frame.t === "reset") {
      rows = [];
      deltas = [];
      applied = undefined;
      checkpoint = undefined;
      status = "loading";
      notify(frame);
      return false;
    }
    if (!frame.checkpoint) {
      throw new TypeError("Subscription output has no checkpoint.");
    }
    let next: readonly CollectionRecord[];
    if (frame.t === "snapshot") {
      if (!frame.complete) throw new TypeError("Incomplete logical snapshot.");
      sequence(frame.sequence);
      next = structuredClone(frame.rows);
      if (
        !Array.isArray(next) || next.some((row) =>
          !row || typeof row.id !== "string" || !row.id
        ) || new Set(next.map((row) => row.id)).size !== next.length
      ) {
        throw new TypeError("Duplicate snapshot record.");
      }
    } else {
      if (
        applied === undefined || frame.from !== applied ||
        sequence(frame.to) <= sequence(frame.from)
      ) throw new TypeError("Subscription batch has a gap or overlap.");
      const records = new Map(rows.map((row) => [row.id, row]));
      let previous: SubscriptionDelta | undefined;
      for (const change of frame.changes) {
        if (
          sequence(change.seq) <= sequence(frame.from) ||
          sequence(change.seq) > sequence(frame.to) ||
          previous &&
            (sequence(change.seq) < sequence(previous.seq) ||
              change.seq === previous.seq &&
                compareCodePoints(change.id, previous.id) <= 0) ||
          change.record && change.record.id !== change.id
        ) throw new TypeError("Invalid subscription delta ordering.");
        if (change.record) {
          records.set(change.id, structuredClone(change.record));
        } else records.delete(change.id);
        previous = change;
      }
      next = [...records.values()].sort((a, b) =>
        (compareCodePoints(a.id, b.id)) *
        (query.order?.direction === "desc" ? -1 : 1)
      );
    }
    // Handler arguments cannot mutate the retained authoritative state.
    await options.onChange?.(structuredClone(next), structuredClone(frame));
    if (
      current !== generation || signal.aborted ||
      attached?.isActive?.() === false
    ) return true;
    rows = next;
    deltas = frame.t === "batch" ? structuredClone(frame.changes) : [];
    applied = frame.t === "snapshot" ? frame.sequence : frame.to;
    checkpoint = frame.checkpoint;
    if (frame.t === "snapshot") resync = false;
    settle();
    status = "ready";
    attached?.applied?.(checkpoint);
    notify(frame);
    return true;
  };
  const connect = async () => {
    if (closed) throw new Error("Live query is closed.");
    const current = ++generation;
    attached?.detach();
    running = true;
    try {
      for (let retries = 0; retries <= 3; retries++) {
        signal.throwIfAborted();
        let applying = false, reset = false;
        try {
          attached = await transport.observe(collection, query, {
            checkpoint: resync ? undefined : checkpoint,
            content,
            progressOnly,
            signal,
          });
          for await (const frame of attached.frames) {
            if (current !== generation) return;
            applying = true;
            const accepted = await apply(frame, current);
            applying = false;
            if (!accepted) {
              checkpoint = undefined;
              reset = true;
              break;
            }
            retries = 0;
          }
          if (!reset) return;
        } catch (error) {
          if (applying) resync = true;
          if (
            ["revoked", "forbidden"].includes(
              (error as { code?: string }).code ?? "",
            ) || (error as { status?: number }).status === 403
          ) deny();
          else status = "stale";
          notify();
          if (
            applying || signal.aborted ||
            (error as { retryable?: boolean }).retryable === false ||
            ["revoked", "forbidden"].includes(
              (error as { code?: string }).code ?? "",
            ) ||
            (error as { status?: number }).status === 403 || retries === 3
          ) throw error;
        } finally {
          attached?.detach();
        }
        if (retries === 3) {
          throw new Error("Subscription retry limit exceeded.");
        }
        if (!reset) {
          await new Promise<void>((resolve, reject) => {
            const cancelled = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            const timer = setTimeout(() => {
              signal.removeEventListener("abort", cancelled);
              resolve();
            }, 100 * 2 ** retries);
            signal.addEventListener("abort", cancelled, { once: true });
            if (signal.aborted) cancelled();
          });
        }
      }
    } finally {
      if (current === generation) running = false;
    }
  };
  let done = connect();
  void done.catch(() => undefined);
  return {
    get status() {
      return status;
    },
    get rows() {
      return structuredClone(rows);
    },
    get deltas() {
      return structuredClone(deltas);
    },
    get checkpoint() {
      return checkpoint;
    },
    get sequence() {
      return applied;
    },
    get optimisticLayers() {
      return new Map(
        [...layers].map(([id, layer]) => [id, structuredClone(layer.value)]),
      );
    },
    get done() {
      return done;
    },
    optimistic(id, value, result) {
      const layer = {
        value: structuredClone(value),
        seq: undefined as string | undefined,
      };
      if (closed || signal.aborted) return;
      layers.set(id, layer);
      notify();
      void result.then((result) => {
        sequence(result.seq);
        if (layers.get(id) !== layer) return;
        layer.seq = result.seq;
        settle();
        notify();
      }).catch(() => {
        if (layers.get(id) === layer) {
          layers.delete(id);
          notify();
        }
      });
    },
    reconnect() {
      if (running) {
        throw new Error(
          "Detach or wait for the current connection before reconnecting.",
        );
      }
      done = connect();
      void done.catch(() => undefined);
      return done;
    },
    close() {
      closed = true;
      generation++;
      abort.abort();
      attached?.detach();
      layers.clear();
    },
  };
}
