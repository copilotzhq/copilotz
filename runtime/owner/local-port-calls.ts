/** Shared raw-call accounting for the private local Action and Processor ports.
 * It owns no execution authority, persistence, scheduling or retry policy. */
import type { OwnerCommandExecuteOptions } from "./boundary.ts";

function unknownOutcome(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value: Record<string, unknown> = {};
  for (const key of ["indeterminate", "outcome", "execution", "code"]) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(error, key);
    } catch {
      return true;
    }
    if (descriptor && !("value" in descriptor)) return true;
    value[key] = descriptor?.value;
  }
  return value.indeterminate === true || value.outcome === "unknown" ||
    value.execution === "indeterminate" ||
    [
      "owner_commit_unknown",
      "persistence_indeterminate",
      "effect_indeterminate",
    ]
      .includes(value.code as string);
}

export function createLocalPortCalls(
  options: Readonly<{
    current(): void;
    quarantine(error: unknown): unknown;
    failure(code: string, cause?: unknown): Error;
    snapshot<T>(value: T): T;
    signal: AbortSignal;
    maxPendingCalls: number;
  }>,
) {
  const {
    current,
    quarantine,
    failure,
    snapshot: copy,
    signal,
    maxPendingCalls: limit,
  } = options;
  const pending = new Set<
    Readonly<{ settled: Promise<void>; release(): void }>
  >();
  const run = <T>(
    run: (options: OwnerCommandExecuteOptions) => Promise<T>,
    callOptions: OwnerCommandExecuteOptions = {},
  ): Promise<T> => {
    current();
    if (pending.size >= limit) throw failure("owner_admission_refused");
    if (Object.keys(callOptions).some((key) => key !== "signal")) {
      throw failure("owner_local_port_options_invalid");
    }
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = { settled, release };
    // Publish occupancy before invoking the actual raw boundary method. A
    // synchronous reentrant drain must observe this call, too.
    pending.add(entry);
    const finish = () => {
      pending.delete(entry);
      release();
    };
    let result: Promise<T>;
    try {
      result = run({
        signal: callOptions.signal
          ? AbortSignal.any([signal, callOptions.signal])
          : signal,
      });
    } catch (error) {
      finish();
      if (unknownOutcome(error)) return Promise.reject(quarantine(error));
      current();
      return Promise.reject(error);
    }
    return Promise.resolve(result).then((value) => {
      finish();
      return value;
    }, (error) => {
      finish();
      if (unknownOutcome(error)) throw quarantine(error);
      current();
      throw error;
    });
  };
  const observeHook = <T>(hook: (value: T) => void, value: T) => {
    // Reserve before invoking even a private hook: it can reenter drain and
    // accidentally return asynchronous work. Never certify quiescence early.
    let release!: () => void;
    const settled = new Promise<void>((resolve) => release = resolve);
    const entry = { settled, release };
    pending.add(entry);
    const finish = () => {
      pending.delete(entry);
      release();
    };
    let returned: unknown;
    try {
      returned = hook(copy(value));
    } catch (error) {
      finish();
      throw error;
    }
    if (returned === undefined) {
      finish();
      return;
    }
    Promise.resolve(returned).then(finish, finish);
    throw failure("owner_local_port_async_hook_refused");
  };
  return {
    run,
    observeHook,
    get size() {
      return pending.size;
    },
    async drain() {
      while (pending.size) {
        await Promise.all([...pending].map((entry) => entry.settled));
      }
    },
  };
}
