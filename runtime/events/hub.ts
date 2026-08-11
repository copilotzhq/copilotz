import type { CopilotzEvent } from "./types.ts";

export type CopilotzEventFilter = Readonly<{
  namespace?: string;
  threadId?: string;
  correlationId?: string;
  causationId?: string;
  types?: readonly string[];
  durable?: boolean;
  subject?: Readonly<{ type?: string; id?: string }>;
  metadata?: Readonly<Record<string, unknown>>;
  /** Durable database position must be strictly greater than this cursor. */
  afterPosition?: string;
}>;

export type CopilotzEventHub = Readonly<{
  publish(event: CopilotzEvent): Promise<void>;
  subscribe(filter?: CopilotzEventFilter): ReadableStream<CopilotzEvent>;
  close(reason?: unknown): void;
}>;

export type WaitForCopilotzEventOptions = Readonly<{
  hub: CopilotzEventHub;
  filter?: CopilotzEventFilter;
  loadDurable?: () => Promise<readonly CopilotzEvent[]>;
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length &&
      expected.every((item, index) => contains(actual[index], item));
  }
  const expectedRecord = record(expected);
  if (expectedRecord) {
    const actualRecord = record(actual);
    return Boolean(
      actualRecord &&
        Object.entries(expectedRecord).every(([key, value]) =>
          Object.prototype.hasOwnProperty.call(actualRecord, key) &&
          contains(actualRecord[key], value)
        ),
    );
  }
  return Object.is(actual, expected);
}

/** Pure matching shared by live subscriptions and durable replay. */
export function matchesCopilotzEvent(
  event: CopilotzEvent,
  filter: CopilotzEventFilter = {},
): boolean {
  if (filter.namespace !== undefined && event.namespace !== filter.namespace) {
    return false;
  }
  if (filter.threadId !== undefined && event.threadId !== filter.threadId) {
    return false;
  }
  if (
    filter.correlationId !== undefined &&
    event.correlationId !== filter.correlationId
  ) return false;
  if (
    filter.causationId !== undefined && event.causationId !== filter.causationId
  ) {
    return false;
  }
  if (filter.durable !== undefined && event.durable !== filter.durable) {
    return false;
  }
  if (filter.afterPosition !== undefined) {
    if (!event.durable) return false;
    try {
      if (BigInt(event.position) <= BigInt(filter.afterPosition)) return false;
    } catch {
      if (event.position.localeCompare(filter.afterPosition) <= 0) return false;
    }
  }
  if (filter.types?.length && !filter.types.includes(event.type)) return false;
  if (filter.subject) {
    if (!event.durable || !event.subject) return false;
    if (
      filter.subject.type !== undefined &&
      event.subject.type !== filter.subject.type
    ) return false;
    if (
      filter.subject.id !== undefined && event.subject.id !== filter.subject.id
    ) return false;
  }
  return filter.metadata === undefined ||
    contains(event.metadata, filter.metadata);
}

/** Creates an in-memory fan-out point for semantic and ephemeral events. */
export function createCopilotzEventHub(): CopilotzEventHub {
  let nextId = 0;
  let closed = false;
  let closeReason: unknown;
  const subscribers = new Map<
    number,
    ReadableStreamDefaultController<CopilotzEvent>
  >();
  const filters = new Map<number, CopilotzEventFilter>();

  return Object.freeze({
    publish(event) {
      if (closed) return Promise.resolve();
      for (const [id, controller] of subscribers) {
        if (!matchesCopilotzEvent(event, filters.get(id))) continue;
        try {
          controller.enqueue(event);
        } catch {
          subscribers.delete(id);
          filters.delete(id);
        }
      }
      return Promise.resolve();
    },
    subscribe(filter = {}) {
      const id = ++nextId;
      return new ReadableStream<CopilotzEvent>({
        start(controller) {
          if (closed) {
            if (closeReason instanceof Error) controller.error(closeReason);
            else controller.close();
            return;
          }
          subscribers.set(id, controller);
          filters.set(id, Object.freeze({ ...filter }));
        },
        cancel() {
          subscribers.delete(id);
          filters.delete(id);
        },
      }, { highWaterMark: 256 });
    },
    close(reason) {
      if (closed) return;
      closed = true;
      closeReason = reason;
      for (const controller of subscribers.values()) {
        try {
          if (reason instanceof Error) controller.error(reason);
          else controller.close();
        } catch {
          // Closing one abandoned subscription must not affect the others.
        }
      }
      subscribers.clear();
      filters.clear();
    },
  });
}

function positiveDuration(
  value: number | undefined,
  fallback: number,
  name: string,
): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw new TypeError(`${name} must be a positive number.`);
  }
  return resolved;
}

/** Waits across live fan-out and durable replay without a subscribe/query race. */
export async function waitForCopilotzEvent(
  options: WaitForCopilotzEventOptions,
): Promise<CopilotzEvent> {
  const filter = options.filter ?? {};
  const pollIntervalMs = positiveDuration(
    options.pollIntervalMs,
    25,
    "Event poll interval",
  );
  const timeoutMs = options.timeoutMs === undefined
    ? undefined
    : positiveDuration(options.timeoutMs, 1, "Event wait timeout");
  const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs;
  const reader = options.hub.subscribe(filter).getReader();
  let live = reader.read();
  const abortError = () => {
    const reason = options.signal?.reason;
    return reason instanceof Error
      ? reason
      : new Error(String(reason ?? "Event wait cancelled."));
  };
  let abortListener: (() => void) | undefined;
  const aborted = options.signal
    ? new Promise<{ kind: "abort" }>((resolve) => {
      abortListener = () => resolve({ kind: "abort" });
      options.signal!.addEventListener("abort", abortListener, { once: true });
    })
    : undefined;

  try {
    while (true) {
      if (options.signal?.aborted) throw abortError();
      if (deadline !== undefined && Date.now() >= deadline) {
        throw new Error(`Timed out waiting for event after ${timeoutMs}ms.`);
      }
      const replay = await options.loadDurable?.() ?? [];
      const existing = replay.find((event) =>
        matchesCopilotzEvent(event, filter)
      );
      if (existing) return existing;

      const remaining = deadline === undefined
        ? pollIntervalMs
        : Math.max(1, Math.min(pollIntervalMs, deadline - Date.now()));
      const outcome = await Promise.race([
        live.then((result) => ({ kind: "live" as const, result })),
        new Promise<{ kind: "poll" }>((resolve) =>
          setTimeout(() => resolve({ kind: "poll" }), remaining)
        ),
        ...(aborted ? [aborted] : []),
      ]);
      if (outcome.kind === "abort") throw abortError();
      if (outcome.kind === "poll") continue;
      if (outcome.result.done) {
        throw new Error("Event hub closed while waiting for an event.");
      }
      if (matchesCopilotzEvent(outcome.result.value, filter)) {
        return outcome.result.value;
      }
      live = reader.read();
    }
  } finally {
    if (abortListener) {
      options.signal?.removeEventListener("abort", abortListener);
    }
    await reader.cancel().catch(() => undefined);
  }
}
