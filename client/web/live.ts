import type { CollectionContentOptions } from "../../runtime/collections/read-options.ts";
/** Minimal F6 §6 port. A transport must emit only authorized, bounded reads. */
export type Row = Readonly<{ id: string; [field: string]: unknown }>;
export type ReadRequest = Readonly<{
  collection: string;
  content?: CollectionContentOptions;
  id?: string;
  query?: Readonly<Record<string, unknown>>;
}>;
export type OrderedRow = Readonly<{ row: Row; order: string | number }>;
export type LiveFrame =
  | Readonly<
    {
      kind: "snapshot";
      rows: readonly OrderedRow[];
      seq: number;
      checkpoint: string;
    }
  >
  | Readonly<
    {
      kind: "delta";
      from: number;
      to: number;
      upserts: readonly OrderedRow[];
      removes: readonly string[];
      checkpoint: string;
    }
  >
  | Readonly<{ kind: "stale" | "reset" | "revoked" }>;
export interface LiveReadPort {
  /** Returning cleanup is mandatory, including when delivery is synchronous.
   * Handler errors detach; never adopt a checkpoint for a failed handler. */
  subscribe(read: ReadRequest, receive: (frame: LiveFrame) => void, options: {
    signal: AbortSignal;
    checkpoint?: string;
  }): () => void;
}
export function readKey(read: ReadRequest): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map((
          [key, value],
        ) => [key, canonical(value)]),
      );
    }
    return value;
  };
  return JSON.stringify(canonical(read));
}
/** Deterministic transport for tests and embedded hosts; no timers or polling. */
export class MemoryLiveReads implements LiveReadPort {
  private listeners = new Map<string, Set<(frame: LiveFrame) => void>>();
  private snapshots = new Map<
    string,
    Extract<LiveFrame, { kind: "snapshot" }>
  >();
  subscribe(
    read: ReadRequest,
    receive: (frame: LiveFrame) => void,
    options: { signal: AbortSignal },
  ): () => void {
    options.signal.throwIfAborted();
    const key = readKey(read);
    const listeners = this.listeners.get(key) ?? new Set();
    this.listeners.set(key, listeners);
    listeners.add(receive);
    const close = () => {
      listeners.delete(receive);
      options.signal.removeEventListener("abort", close);
    };
    options.signal.addEventListener("abort", close, { once: true });
    try {
      const snapshot = this.snapshots.get(key);
      if (snapshot) receive(snapshot);
    } catch (error) {
      close();
      throw error;
    }
    return close;
  }
  publish(read: ReadRequest, frame: LiveFrame): void {
    const key = readKey(read);
    if (frame.kind === "snapshot") {
      this.snapshots.set(key, structuredClone(frame));
    } else if (frame.kind === "reset" || frame.kind === "revoked") {
      this.snapshots.delete(key);
    } else if (frame.kind === "delta") {
      const previous = this.snapshots.get(key);
      if (previous && previous.seq === frame.from) {
        const rows = new Map(
          previous.rows.map((entry) => [entry.row.id, entry]),
        );
        for (const id of frame.removes) rows.delete(id);
        for (const entry of frame.upserts) rows.set(entry.row.id, entry);
        this.snapshots.set(key, {
          kind: "snapshot",
          rows: [...rows.values()],
          seq: frame.to,
          checkpoint: frame.checkpoint,
        });
      }
    }
    const errors: unknown[] = [];
    for (const receive of [...this.listeners.get(key) ?? []]) {
      try {
        receive(structuredClone(frame));
      } catch (error) {
        this.listeners.get(key)?.delete(receive);
        errors.push(error);
      }
    }
    if (errors.length) {
      throw new AggregateError(errors, "Live read delivery failed");
    }
  }
  get subscriptions(): number {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}
