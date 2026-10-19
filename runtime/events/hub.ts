import type { CopilotzEvent } from "./types.ts";

export type CopilotzEventFilter = Readonly<{
  namespace?: string;
  correlationId?: string;
  causationId?: string;
  types?: readonly string[];
  durable?: boolean;
  subject?: Readonly<{ type?: string; id?: string }>;
  metadata?: Readonly<Record<string, unknown>>;
  /** Durable database position must be strictly greater than this cursor. */
  afterPosition?: string;
  /** Owner-scoped consumed sequence, independent of database row positions. */
  afterSeq?: string;
}>;

export type CopilotzEventHub = Readonly<{
  publish(event: CopilotzEvent): Promise<void>;
  subscribe(filter?: CopilotzEventFilter): ReadableStream<CopilotzEvent>;
  /** Reject current observers while allowing a new cursor-based attachment. */
  reset(reason: Error): void;
  close(reason?: unknown): void;
}>;

export type WaitForCopilotzEventOptions = Readonly<{
  hub: CopilotzEventHub;
  filter?: CopilotzEventFilter;
  loadDurable?: () => Promise<readonly CopilotzEvent[]>;
  /** Required with durable replay; attachment must precede the initial read. */
  attachDurable?: () => Promise<
    Readonly<{ wait(): Promise<void>; close(): void }>
  >;
  signal?: AbortSignal;
  timeoutMs?: number;
}>;

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function contains(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) &&
      expected.every((item) => actual.some((value) => contains(value, item)));
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
  if (filter.afterSeq !== undefined) {
    if (!event.durable || !/^(0|[1-9][0-9]*)$/.test(filter.afterSeq)) {
      return false;
    }
    if (BigInt(event.seq) <= BigInt(filter.afterSeq)) return false;
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

  return ({
    publish(event) {
      if (closed) return Promise.resolve();
      for (const [id, controller] of subscribers) {
        if (!matchesCopilotzEvent(event, filters.get(id))) continue;
        try {
          if ((controller.desiredSize ?? 0) <= 0) {
            throw Object.assign(
              new Error(
                "Owner push overflow; replay from the applied checkpoint.",
              ),
              { code: "observation_reset_required" },
            );
          }
          controller.enqueue(structuredClone(event));
        } catch (error) {
          subscribers.delete(id);
          filters.delete(id);
          try {
            controller.error(error);
          } catch { /* detached */ }
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
          filters.set(id, structuredClone(filter));
        },
        cancel() {
          subscribers.delete(id);
          filters.delete(id);
        },
      }, { highWaterMark: 256 });
    },
    reset(reason) {
      for (const controller of subscribers.values()) {
        try {
          controller.error(reason);
        } catch { /* detached */ }
      }
      subscribers.clear();
      filters.clear();
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
  } as const);
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
  if (Boolean(options.loadDurable) !== Boolean(options.attachDurable)) {
    throw new TypeError("Durable replay requires an attached repair source.");
  }
  const timeoutMs = options.timeoutMs === undefined
    ? undefined
    : positiveDuration(options.timeoutMs, 1, "Event wait timeout");
  let reader = options.hub.subscribe(filter).getReader();
  const readLive = () =>
    reader.read().then(
      (result) => ({ kind: "live" as const, result }),
      (error: unknown) => ({ kind: "reset" as const, error }),
    );
  let live = readLive();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    if (timeoutMs !== undefined) {
      timer = setTimeout(() =>
        reject(
          new Error(`Timed out waiting for event after ${timeoutMs}ms.`),
        ), timeoutMs);
    }
  });
  const abortError = () =>
    options.signal?.reason ?? new Error("Event wait cancelled.");
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    if (!options.signal) return;
    abortListener = () => reject(abortError());
    options.signal.addEventListener("abort", abortListener, { once: true });
    if (options.signal.aborted) abortListener();
  });
  let durable:
    | Awaited<ReturnType<NonNullable<typeof options.attachDurable>>>
    | undefined;
  const cancelled = Promise.race([timeout, aborted]);
  // Always observe rejection, including while an attachment is still pending.
  cancelled.catch(() => undefined);
  try {
    if (options.signal?.aborted) throw abortError();
    if (options.attachDurable) {
      const attachment = options.attachDurable();
      try {
        durable = await Promise.race([attachment, cancelled]);
      } catch (error) {
        void attachment.then((watch) => watch.close(), () => {});
        throw error;
      }
    }
    const waitRepair = () =>
      durable?.wait().then(
        () => ({ kind: "repair" as const }),
        (error: unknown) => ({ kind: "failure" as const, error }),
      );
    let repair = waitRepair();
    while (true) {
      const replay = await Promise.race([
        options.loadDurable?.() ?? [],
        cancelled,
      ]);
      const existing = replay.find((event) =>
        matchesCopilotzEvent(event, filter)
      );
      if (existing) return existing;
      const outcome = await Promise.race([
        live,
        cancelled,
        ...(repair ? [repair] : []),
      ]);
      if (outcome.kind === "repair") {
        repair = waitRepair();
      } else if (outcome.kind === "failure") {
        throw outcome.error;
      } else if (outcome.kind === "reset") {
        if (
          !durable ||
          (outcome.error as { code?: string })?.code !==
            "observation_reset_required"
        ) throw outcome.error;
        await reader.cancel().catch(() => undefined);
        reader = options.hub.subscribe(filter).getReader();
        live = readLive();
      } else {
        if (outcome.result.done) {
          throw new Error("Event hub closed while waiting for an event.");
        }
        if (matchesCopilotzEvent(outcome.result.value, filter)) {
          return outcome.result.value;
        }
        live = readLive();
      }
    }
  } finally {
    clearTimeout(timer);
    if (abortListener) {
      options.signal?.removeEventListener("abort", abortListener);
    }
    durable?.close();
    await reader.cancel().catch(() => undefined);
  }
}
