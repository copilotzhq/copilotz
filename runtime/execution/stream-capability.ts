/** Invocation-owned physical append acknowledgements and bounded checkpoints.
 * This is not the legacy lease-bearing progressive writer or a content owner. */
import type {
  ContentStreamAbortInput,
  ContentStreamOpenInput,
  ContentStreamRuntime,
  ContentStreamWriter,
} from "../streams/types.ts";
import type { OwnerCommandExecuteOptions } from "../owner/boundary.ts";
import { assertJsonValue } from "../json.ts";
import {
  isRegisteredInvocationUnknown,
  registeredInvocationErrorCode,
  type RegisteredInvocationLifetime,
} from "./registered-invocation.ts";

export const OWNER_STREAM_EXECUTION_CHUNK_BYTES = 256 * 1024;
export const OWNER_STREAM_CHECKPOINT_INTERVAL_MS = 1000;
export type RegisteredStreamPort = Readonly<{
  open(
    input: ContentStreamOpenInput & { id: string },
    options: OwnerCommandExecuteOptions,
  ): Promise<{ id: string }>;
  append(
    input: {
      id: string;
      expectedOffset: number;
      appendId: string;
      bytes: Uint8Array;
    },
    options: OwnerCommandExecuteOptions,
  ): Promise<{ startOffset: number; endOffset: number }>;
  checkpoint(
    input: { id: string; startOffset: number; endOffset: number },
    options: OwnerCommandExecuteOptions,
  ): Promise<{ committedOffset: number }>;
  /** Cleanup keeps narrow settlement authority after invocation failure. */
  abort(
    input: ContentStreamAbortInput & { id: string },
    options: OwnerCommandExecuteOptions,
  ): Promise<void>;
}>;
/** Capture trusted methods once. Cleanup has a separate authority check because
 * a failed invocation still has to retire its already-open resources. */
export function captureStreamCalls(
  supplied: RegisteredStreamPort | undefined,
  invoke: <T>(work: () => Promise<T>) => Promise<T> = (work) => work(),
  cleanup: <T>(work: () => Promise<T>) => Promise<T> = invoke,
): RegisteredStreamPort | undefined {
  if (!supplied) return undefined;
  const open = supplied.open.bind(supplied);
  const append = supplied.append.bind(supplied);
  const checkpoint = supplied.checkpoint.bind(supplied);
  const abort = supplied.abort.bind(supplied);
  return Object.freeze({
    open: (input, options) => invoke(() => open(input, options)),
    append: (input, options) => invoke(() => append(input, options)),
    checkpoint: (input, options) => invoke(() => checkpoint(input, options)),
    abort: (input, options) => cleanup(() => abort(input, options)),
  });
}
type Clock = Readonly<{
  now(): number;
  set(callback: () => void, delay: number): unknown;
  clear(handle: unknown): void;
}>;
const typedArrayLength = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  "byteLength",
)!.get!;
function copy<T>(value: T): T {
  assertJsonValue(value, {
    maxDepth: 32,
    maxNodes: 20_000,
    omitUndefinedProperties: true,
  });
  const encoded = JSON.stringify(value);
  if (new TextEncoder().encode(encoded).byteLength > 65_536) {
    throw new RangeError("Stream request exceeds its bound.");
  }
  return JSON.parse(encoded);
}
function identifier(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024) {
    throw new TypeError("Invalid stream identity.");
  }
}
function aborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason;
}
function offset(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new TypeError("Invalid stream offset.");
  }
}

export function createRegisteredStreamCapability(
  options: Readonly<{
    port?: RegisteredStreamPort;
    lifetime: RegisteredInvocationLifetime;
    /** Charges one bounded lifetime, not every physical append. */
    track<T>(start: () => Promise<T>): Promise<T>;
    fail(error: unknown): void;
    unsupported(): never;
    /** Private deterministic test clock; not an authored scheduling option. */
    clock?: Clock;
  }>,
) {
  const { lifetime, track, fail, unsupported } = options;
  // Notification may be supplied by a host adapter. It cannot replace the
  // original failure or prevent actual physical cleanup and resource drain.
  const notifyFailure = (error: unknown) => {
    try {
      fail(error);
    } catch { /* retain the original failure */ }
  };
  const check = lifetime.check, commandSignal = lifetime.commandSignal;
  const supportsFailure = typeof lifetime.fail === "function";
  const configured = options.port;
  const port = configured
    ? {
      open: configured.open.bind(configured),
      append: configured.append.bind(configured),
      checkpoint: configured.checkpoint.bind(configured),
      abort: configured.abort.bind(configured),
    }
    : undefined;
  const clock: Clock = options.clock ?? {
    now: performance.now.bind(performance),
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const writers = new Set<{ seal(): void; done: Promise<void> }>();
  let accepting = true;
  const requireOpen = () => {
    check();
    if (!accepting) throw new Error("Stream invocation is closed.");
    if (!port || !supportsFailure) unsupported();
  };
  const streams: ContentStreamRuntime = {
    async open(value, openOptions = {}) {
      requireOpen();
      aborted(openOptions.signal);
      const captured = copy(value);
      const input = { ...captured, id: captured.id ?? crypto.randomUUID() };
      const userSignal = openOptions.signal;
      identifier(input.id);
      requireOpen();
      aborted(userSignal);
      let resolveDone!: () => void, rejectDone!: (reason: unknown) => void;
      const done = new Promise<void>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
      });
      // Reserve the invocation's existing call budget before any remote work.
      void track(() => done).catch(() => undefined);
      let id: string | undefined;
      let head = 0, committed = 0;
      let closed = false, finishQueued = false;
      let timer: unknown, deadline: number | undefined;
      let checkpointQueued = false, pendingAppends = 0;
      let hasFailure = false, failure: unknown;
      let tail = Promise.resolve();
      let termination: ContentStreamAbortInput | undefined;
      const clearTimer = () => {
        if (timer !== undefined) clock.clear(timer);
        timer = undefined;
      };
      const noteFailure = (error: unknown) => {
        if (
          registeredInvocationErrorCode(error) === "owner_stream_unavailable"
        ) {
          try {
            unsupported();
          } catch (refusal) {
            error = refusal;
          }
        }
        if (!hasFailure || isRegisteredInvocationUnknown(error)) {
          failure = error;
        }
        hasFailure = true;
        closed = true;
        clearTimer();
        finish({ outcome: "failed", capture: "truncated" });
        notifyFailure(error);
      };
      const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
        const task = tail.then(work);
        tail = task.then(() => undefined, (error) => {
          noteFailure(error);
        });
        return task;
      };
      const checkpoint = async () => {
        if (
          closed || deadline === undefined || clock.now() < deadline ||
          head <= committed
        ) return;
        check();
        const startOffset = committed, endOffset = head;
        const result = await port!.checkpoint({
          id: id!,
          startOffset,
          endOffset,
        }, { signal: commandSignal });
        check();
        if (result.committedOffset !== endOffset) {
          throw new Error("Checkpoint acknowledgement changed its prefix.");
        }
        committed = endOffset;
        deadline = undefined;
        clearTimer();
      };
      const schedule = () => {
        if (closed || head <= committed) return;
        deadline ??= clock.now() + OWNER_STREAM_CHECKPOINT_INTERVAL_MS;
        if (timer !== undefined || checkpointQueued) return;
        timer = clock.set(() => {
          timer = undefined;
          if (closed) return;
          checkpointQueued = true;
          void enqueue(checkpoint).catch(() => undefined).finally(() => {
            checkpointQueued = false;
            schedule();
          });
        }, Math.max(0, deadline - clock.now()));
      };
      function finish(input: ContentStreamAbortInput) {
        if (finishQueued) return;
        finishQueued = true;
        closed = true;
        termination = copy(input);
        clearTimer();
        // This waits actual already-admitted work, including a held checkpoint.
        const finishing = tail.then(async () => {
          if (id !== undefined) await port!.abort({ ...termination, id }, {});
        });
        tail = finishing.then(() => undefined, (error) => {
          if (!hasFailure || isRegisteredInvocationUnknown(error)) {
            failure = error;
          }
          hasFailure = true;
          notifyFailure(error);
        });
        void tail.then(() => {
          if (hasFailure) rejectDone(failure);
          else resolveDone();
        });
      }
      writers.add({
        seal: () => finish({ outcome: "abandoned", capture: "truncated" }),
        done,
      });
      const signal = userSignal
        ? AbortSignal.any([commandSignal, userSignal])
        : commandSignal;
      try {
        // Publish the actual opening task before a port callback can reenter
        // finalization. Cleanup must never observe a falsely empty tail.
        const opening = Promise.resolve().then(() => {
          requireOpen();
          aborted(signal);
          return port!.open(input, { signal });
        });
        // Finish must also retain a held open, including a late physical reservation.
        tail = opening.then((result) => {
          identifier(result.id);
          id = result.id;
        }, (error) => {
          noteFailure(error);
        });
        const result = await opening;
        identifier(result.id);
        id = result.id;
        requireOpen();
        if (closed) throw failure ?? new Error("Stream writer is closed.");
        aborted(signal);
      } catch (error) {
        noteFailure(error);
        throw error;
      }
      const unsupportedWriter = (): Promise<never> => {
        try {
          return unsupported();
        } catch (error) {
          noteFailure(error);
          return Promise.reject(error);
        }
      };
      const writer: ContentStreamWriter = {
        id: id!,
        offset: () => head,
        async append(value, appendOptions = {}) {
          requireOpen();
          if (closed) throw failure ?? new Error("Stream writer is closed.");
          const userSignal = appendOptions.signal;
          const source = value.bytes, appendId = value.appendId;
          aborted(userSignal);
          identifier(appendId);
          if (!(source instanceof Uint8Array)) {
            throw new TypeError("Stream bytes must be Uint8Array.");
          }
          const length = typedArrayLength.call(source) as number;
          if (length > OWNER_STREAM_EXECUTION_CHUNK_BYTES) {
            throw new RangeError("Split stream chunks to at most 256 KiB.");
          }
          if (pendingAppends >= 2) {
            throw new RangeError(
              "Only one append and one waiting append are admitted.",
            );
          }
          const bytes = new Uint8Array(source);
          requireOpen();
          if (closed) throw failure ?? new Error("Stream writer is closed.");
          if (!length) return { startOffset: head, endOffset: head };
          const signal = userSignal
            ? AbortSignal.any([commandSignal, userSignal])
            : commandSignal;
          pendingAppends++;
          try {
            return await enqueue(async () => {
              if (hasFailure) throw failure;
              check();
              aborted(signal);
              // A due checkpoint precedes the next append, even when the timer's
              // queued job sits behind it. Appends never reset the deadline.
              await checkpoint();
              const startOffset = head;
              const result = await port!.append({
                id: id!,
                expectedOffset: startOffset,
                appendId,
                bytes,
              }, { signal });
              check();
              aborted(signal);
              offset(result.startOffset);
              offset(result.endOffset);
              if (
                result.startOffset !== startOffset ||
                result.endOffset !== startOffset + bytes.byteLength
              ) throw new Error("Append acknowledgement changed its range.");
              head = result.endOffset;
              schedule();
              return { startOffset, endOffset: head };
            });
          } finally {
            pendingAppends--;
          }
        },
        async abort(input = {}, abortOptions = {}) {
          aborted(abortOptions.signal);
          finish({
            ...copy(input),
            outcome: input.outcome ?? "failed",
            capture: input.capture ?? "truncated",
          });
          await done;
          aborted(abortOptions.signal);
        },
        close: unsupportedWriter,
        retain: unsupportedWriter,
        async [Symbol.asyncDispose]() {
          finish({ outcome: "abandoned", capture: "truncated" });
          await done;
        },
      };
      return writer;
    },
    follow() {
      return unsupported();
    },
  };
  return Object.freeze({
    streams,
    /** Synchronous: no new writer or timer may escape the pending-work snapshot. */
    seal() {
      accepting = false;
      for (const writer of writers) writer.seal();
    },
    async drain() {
      await Promise.allSettled([...writers].map((writer) => writer.done));
    },
  });
}
