/** Runtime-neutral ingress/egress lifecycle for one live channel session. @module */

import type {
  ApplicationOutput,
  ApplicationSendHandle,
  ApplicationSendInput,
  CopilotzApplication,
} from "@copilotz/copilotz/application";

/** Maps one provider input to one durable application ingress envelope. */
export type ChannelSessionIngress<TInput> = (
  input: TInput,
  signal: AbortSignal,
) => ApplicationSendInput | Promise<ApplicationSendInput>;

/** Receives resolved outputs in stream order for one live session. */
export type ChannelSessionEgress = (
  output: ApplicationOutput,
  signal: AbortSignal,
) => void | Promise<void>;

export type ChannelSessionOptions<TInput> = Readonly<{
  ingress: ChannelSessionIngress<TInput>;
  egress: ChannelSessionEgress;
}>;

export type ChannelSession<TInput> = Readonly<{
  /** Rejects with an AbortError when interrupted or superseded. */
  send(input: TInput): Promise<void>;
  /** Explicit lifecycle cancellation uses a DOMException AbortError reason. */
  interrupt(reason?: string): Promise<void>;
  /** Explicit lifecycle cancellation uses a DOMException AbortError reason. */
  close(reason?: string): Promise<void>;
}>;

type Turn = {
  readonly controller: AbortController;
  handle?: ApplicationSendHandle;
  reader?: ReadableStreamDefaultReader<ApplicationOutput>;
  cancelTask?: Promise<void>;
};

const interrupted = "Channel session interrupted.";
const closed = "Channel session closed.";
const superseded = "Channel session turn superseded.";

function abortError(reason: unknown, fallback: string): DOMException {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason.trim()
    ? reason
    : fallback;
  return new DOMException(message || fallback, "AbortError");
}

function reasonText(reason: unknown, fallback: string): string {
  if (reason instanceof Error && reason.message.trim()) return reason.message;
  if (typeof reason === "string" && reason.trim()) return reason;
  return fallback;
}

/**
 * Owns the lifecycle of one live provider conversation. The session has no
 * registry or durable event of its own: every turn maps to one `send` call.
 * A turn's controller is the lifecycle invariant: once aborted, no output is
 * delivered and its admitted operation is cancelled when a handle exists.
 */
export function createChannelSession<TInput>(
  application: Pick<CopilotzApplication, "send">,
  options: ChannelSessionOptions<TInput>,
): ChannelSession<TInput> {
  let active: Turn | undefined;
  let isClosed = false;
  let closeTask: Promise<void> | undefined;

  const cancel = (turn: Turn, reason: unknown): Promise<void> => {
    if (turn.cancelTask) return turn.cancelTask;
    if (!turn.handle) return Promise.resolve();
    const handle = turn.handle;
    const text = reasonText(reason, interrupted);
    // Close the local reader and request durable cancellation together. A
    // provider's `cancel` may wait for settlement; it must not block reader
    // cancellation or a superseding turn.
    const reader = turn.reader;
    const stopReader = reader
      ? Promise.resolve().then(() => reader.cancel(reason)).catch(() =>
        undefined
      )
      : Promise.resolve();
    const stopDurable = Promise.resolve().then(() => handle.cancel(text));
    turn.cancelTask = Promise.all([stopReader, stopDurable]).then(() =>
      undefined
    );
    void turn.cancelTask.catch(() => undefined);
    return turn.cancelTask;
  };

  const abort = (turn: Turn, reason: unknown): Promise<void> => {
    const failure = abortError(reason, interrupted);
    if (!turn.controller.signal.aborted) turn.controller.abort(failure);
    if (active === turn) active = undefined;
    return cancel(turn, failure);
  };

  const observeDone = (turn: Turn): void => {
    const handle = turn.handle!;
    // Old turns can outlive their caller. Observe rejection, and stop an open
    // output reader when durable execution fails before it reaches EOF.
    void handle.done.catch((failure) => {
      if (!turn.controller.signal.aborted) turn.controller.abort(failure);
      const reader = turn.reader;
      if (reader) void reader.cancel(failure).catch(() => undefined);
    });
  };

  const run = async (turn: Turn, input: TInput): Promise<void> => {
    const envelope = await options.ingress(input, turn.controller.signal);
    if (turn.controller.signal.aborted) throw turn.controller.signal.reason;

    let handle: ApplicationSendHandle;
    try {
      handle = await application.send(envelope);
    } catch (failure) {
      if (turn.controller.signal.aborted) throw turn.controller.signal.reason;
      throw failure;
    }
    turn.handle = handle;
    observeDone(turn);
    if (turn.controller.signal.aborted) {
      void cancel(turn, turn.controller.signal.reason).catch(() => undefined);
      throw turn.controller.signal.reason;
    }

    let reader: ReadableStreamDefaultReader<ApplicationOutput> | undefined;
    try {
      reader = handle.outputs.getReader();
      turn.reader = reader;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        // Durable failure and interruption both abort before this check. The
        // signal is checked again immediately before provider egress.
        if (turn.controller.signal.aborted) {
          throw turn.controller.signal.reason;
        }
        await options.egress(next.value, turn.controller.signal);
      }
    } catch (failure) {
      if (!turn.controller.signal.aborted) {
        turn.controller.abort(failure);
        void cancel(turn, failure).catch(() => undefined);
        throw failure;
      }
      throw turn.controller.signal.reason;
    } finally {
      try {
        reader?.releaseLock();
      } catch {
        // Reader cancellation may already have released the lock.
      }
      if (turn.reader === reader) turn.reader = undefined;
    }

    if (turn.controller.signal.aborted) {
      // A durable failure already settled `done`; detach that completed local
      // observation. For interruption/supersession, cancellation is in flight
      // and this send must reject without waiting for durable settlement.
      if (!turn.cancelTask) {
        try {
          await handle.done;
        } catch {
          // The abort reason is the operation failure exposed below.
        }
        try {
          await handle.detach("channel_session_failed");
        } catch {
          // Preserve the durable failure rather than replacing it with cleanup.
        }
      }
      throw turn.controller.signal.reason;
    }

    // EOF is only an observation boundary. Durable settlement remains the
    // authority and may reject after the output stream has closed.
    let doneFailure: unknown;
    try {
      await handle.done;
    } catch (failure) {
      doneFailure = failure;
    }
    try {
      await handle.detach("channel_session_completed");
    } catch (detachFailure) {
      if (doneFailure === undefined) throw detachFailure;
    }
    if (turn.controller.signal.aborted) throw turn.controller.signal.reason;
    if (doneFailure !== undefined) throw doneFailure;
  };

  const send = (input: TInput): Promise<void> => {
    if (isClosed) return Promise.reject(abortError(undefined, closed));
    if (active) void abort(active, superseded).catch(() => undefined);
    const turn: Turn = { controller: new AbortController() };
    active = turn;
    const task = run(turn, input).finally(() => {
      if (active === turn) active = undefined;
    });
    void task.catch(() => undefined);
    return task;
  };

  const interrupt = (reason?: string): Promise<void> => {
    if (isClosed) return closeTask ?? Promise.resolve();
    return active
      ? abort(active, reason === undefined ? interrupted : reason)
      : Promise.resolve();
  };

  const close = (reason?: string): Promise<void> => {
    if (closeTask) return closeTask;
    isClosed = true;
    closeTask = active
      ? abort(active, reason === undefined ? closed : reason)
      : Promise.resolve();
    void closeTask.catch(() => undefined);
    return closeTask;
  };

  return { send, interrupt, close };
}
