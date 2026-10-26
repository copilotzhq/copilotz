import { sqlDatabaseIdentity } from "../events/database-identity.ts";

export type ReadOptions = Readonly<
  { signal?: AbortSignal; timeoutMs?: number }
>;

/** FIFO admission shared by every reader of a physical pool. */
export class ReadLimiter {
  readonly capacity: number;
  private active = 0;
  private queue: Array<{ start(): void; cancel(reason: unknown): void }> = [];
  private retired = false;
  private drained: Array<() => void> = [];
  constructor(poolSize: number, private timeoutMs = 2_000) {
    if (!Number.isSafeInteger(poolSize) || poolSize < 1) {
      throw new RangeError("Read pool size must be a positive integer.");
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw new RangeError("Read deadline must be nonnegative.");
    }
    // Every tenant owner on this process commits through the same pool, so
    // reads leave a third of it (at least one connection) to writers.
    const size = Math.floor(poolSize);
    this.capacity = Math.max(1, size - Math.max(1, Math.ceil(size / 3)));
  }
  async run<T>(
    operation: () => Promise<T>,
    options: ReadOptions = {},
  ): Promise<T> {
    if (
      options.timeoutMs !== undefined &&
      (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0)
    ) throw new RangeError("Read deadline must be nonnegative.");
    options.signal?.throwIfAborted();
    if (this.retired) {
      throw Object.assign(new Error("Database closed."), {
        code: "persistence_unavailable",
        retryable: true,
      });
    }
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
      };
      const item = {
        start: () => {
          cleanup();
          this.active++;
          resolve();
        },
        cancel: (reason: unknown) => {
          const index = this.queue.indexOf(item);
          if (index < 0) return;
          this.queue.splice(index, 1);
          cleanup();
          reject(reason);
        },
      };
      const abort = () => item.cancel(options.signal?.reason);
      if (this.active < this.capacity && !this.queue.length) item.start();
      else {
        this.queue.push(item);
        options.signal?.addEventListener("abort", abort, { once: true });
        timer = setTimeout(() =>
          item.cancel(Object.assign(
            new Error("Read capacity deadline exceeded."),
            {
              code: "read_capacity_timeout",
              status: 503,
              retryable: true,
              retryAfterMs: 50,
            },
          )), options.timeoutMs ?? this.timeoutMs);
      }
    });
    try {
      options.signal?.throwIfAborted();
      return await operation();
    } finally {
      this.active--;
      this.queue.shift()?.start();
      if (!this.active) this.drained.splice(0).forEach((resolve) => resolve());
    }
  }
  async close(): Promise<void> {
    this.retired = true;
    for (const item of [...this.queue]) {
      item.cancel(Object.assign(
        new Error("Database closed."),
        { code: "persistence_unavailable", retryable: true },
      ));
    }
    if (this.active) {
      await new Promise<void>((resolve) => this.drained.push(resolve));
    }
  }
}
const configurations = new WeakMap<
  object,
  {
    limiter: ReadLimiter;
    concurrent: boolean;
    poolSize: number;
    timeoutMs: number;
  }
>();
export function configureReads(
  database: object,
  options: { poolSize: number; timeoutMs?: number },
) {
  const existing = configurations.get(sqlDatabaseIdentity(database));
  if (existing) {
    if (
      existing.poolSize !== options.poolSize ||
      existing.timeoutMs !== (options.timeoutMs ?? 2_000)
    ) throw new Error("Read pool configuration is already registered.");
    return existing;
  }
  const value = {
    poolSize: options.poolSize,
    timeoutMs: options.timeoutMs ?? 2_000,
    limiter: new ReadLimiter(options.poolSize, options.timeoutMs),
    concurrent: options.poolSize > 1,
  };
  configurations.set(sqlDatabaseIdentity(database), value);
  return value;
}
export function readConfiguration(database: object) {
  return configurations.get(sqlDatabaseIdentity(database)) ??
    configureReads(database, { poolSize: 1 });
}
export function retireReads(database: object) {
  return readConfiguration(database).limiter.close();
}

export function inheritReads(target: object, source: object) {
  configurations.set(sqlDatabaseIdentity(target), readConfiguration(source));
}
