/** Process-local, scope-bound operation readers. Durable replay stays in BodyStore. */
import type {
  ApplicationOperationAttachInput,
  ApplicationOperationAttachment,
  ApplicationOperationStatus,
  ApplicationOutput,
  InternalCopilotzApplication,
} from "./types.ts";
import type { CopilotzEngineDatabaseScope } from "../engine/types.ts";
import type {
  OperationChangeDetail,
  OperationChangeSubscription,
  OperationStreamRecord,
} from "../streams/catalog.ts";
import {
  createOperationReplayCursorTracker,
  decodeOperationReplayCursor,
  encodeOperationReplayCursor,
} from "../streams/cursor.ts";
import type { StreamOutput, StreamTerminalStatus } from "../streams/types.ts";
import { createStreamOriginResolver } from "../actions/stream-origin.ts";
import {
  MAX_LOGICAL_OUTPUT_BYTES,
  OBSERVATION_FRAME_CAPACITY_CODE,
} from "../streams/limits.ts";

export type OperationReaderOptions = Readonly<{
  maxQueuedBytes?: number;
  maxQueuedOutputs?: number;
  maxActiveStreams?: number;
  bodyReadBytes?: number;
  minimumScanMs?: number;
  safetyScanMs?: number;
}>;

function failure(code: string, status: number, message: string) {
  return Object.assign(new Error(message), { code, status });
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`${label} must be non-empty.`);
  }
  return value.trim();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}

/** HWM zero makes the queue's accounting include every undelivered item. */
type ObservationQueue<T> = Readonly<{
  stream: ReadableStream<T>;
  drained: Promise<void>;
  push(value: T, bytes: number): void;
  close(): void;
  error(reason: unknown, drain?: boolean): void;
}>;

function createQueue<T>(
  reserve: (bytes: number) => boolean,
  release: (bytes: number) => void,
  cancel: (reason?: unknown) => void,
  copy: (value: T) => T = (value) => value,
): ObservationQueue<T> {
  let items: { value: T; bytes: number }[] = [];
  let wake = deferred<void>();
  let ended = false;
  let failed: unknown;
  const drained = deferred<void>();
  function clear() {
    for (const item of items) release(item.bytes);
    items = [];
  }
  function close() {
    ended = true;
    wake.resolve();
    if (!items.length) drained.resolve();
  }
  const stream = new ReadableStream<T>({
    pull: async (controller) => {
      while (!items.length && !ended) await wake.promise;
      if (failed !== undefined && !items.length) {
        controller.error(failed);
        return;
      }
      const item = items.shift();
      if (item) {
        release(item.bytes);
        controller.enqueue(copy(item.value));
        if (ended && !items.length) drained.resolve();
      } else controller.close();
    },
    cancel: (reason) => {
      clear();
      close();
      cancel(reason);
    },
  }, { highWaterMark: 0 });
  return {
    stream,
    drained: drained.promise,
    push(value, bytes) {
      if (ended || !reserve(bytes)) return;
      items.push({ value, bytes });
      const previousWake = wake;
      wake = deferred<void>();
      previousWake.resolve();
    },
    close,
    error(reason, drain = false) {
      failed = reason;
      // A planned renewal must deliver its bounded prefix before the error;
      // otherwise retained replay can renew repeatedly at the same checkpoint.
      if (!drain) clear();
      close();
    },
  };
}

type Lane = {
  record: OperationStreamRecord;
  offset: number;
  terminal: ReturnType<typeof deferred<StreamTerminalStatus>>;
  followers: Set<(bytes: Uint8Array, offset: number) => void>;
  closers: Set<(error?: unknown) => void>;
};

type Subscriber = {
  fail(reason: unknown): void;
  output(output: ApplicationOutput): void;
  finish(): void;
};

/** Authorization belongs to the caller and must run before attach. */
export function createSharedOperationReaders(
  application: InternalCopilotzApplication,
  options: OperationReaderOptions = {},
) {
  const limits = {
    maxQueuedBytes: options.maxQueuedBytes ?? 1024 * 1024,
    maxQueuedOutputs: options.maxQueuedOutputs ?? 256,
    maxActiveStreams: options.maxActiveStreams ?? 256,
    bodyReadBytes: options.bodyReadBytes ?? 64 * 1024,
    minimumScanMs: options.minimumScanMs ?? 250,
    safetyScanMs: options.safetyScanMs ?? 5_000,
  };
  for (const [name, value] of Object.entries(limits)) {
    if (
      !Number.isSafeInteger(value) || value < (name === "minimumScanMs" ? 0 : 1)
    ) {
      throw new TypeError(`Invalid operation reader option: ${name}.`);
    }
  }
  type Hub = ReturnType<typeof createHub>;
  const hubs = new Map<string, Promise<Hub>>();
  const pendingRenewals = new Set<(reason: string) => void>();
  let closing = false;
  const assertOpen = () => {
    if (closing) {
      throw failure(
        "application_closed",
        503,
        "Application observation readers are closed.",
      );
    }
  };

  function createHub(
    key: string,
    input: Required<Omit<ApplicationOperationAttachInput, "cursor">>,
    runtime: CopilotzEngineDatabaseScope | InternalCopilotzApplication,
    changes: OperationChangeSubscription,
  ) {
    const subscribers = new Set<Subscriber>();
    const lanes = new Map<string, Lane>();
    const abort = new AbortController();
    let eventOrdinal: string | undefined;
    let streamOrdinal: string | undefined;
    let terminal: ApplicationOutput | undefined;
    let running = false;
    let stopped = false;
    let lastReconciledAt = performance.now();
    let reconcileRequested = false;
    let dirtyTopology = true;
    let dirtyEvents = true;
    let dirtyStatus = true;
    let lastSafetyScan = performance.now();
    let cachedStatus: ApplicationOperationStatus | null = null;
    let finalizing = false;
    const hintedLanes = new Set<string>();
    let removeHint: (() => void) | undefined;
    const originReads = new Map<string, Promise<StreamOutput>>();
    const origin = createStreamOriginResolver(
      runtime,
      input.namespace,
      abort.signal,
    );
    function release(subscriber: Subscriber) {
      subscribers.delete(subscriber);
      if (!subscribers.size) stop();
    }
    function hint(detail: OperationChangeDetail) {
      if (detail.namespace !== input.namespace) return;
      if (
        detail.kind === "stream-offset" && detail.streamId &&
        Number.isSafeInteger(detail.committedOffset) &&
        detail.committedOffset! >= 0
      ) {
        const lane = lanes.get(detail.streamId);
        if (lane) {
          lane.record = {
            ...lane.record,
            committedOffset: Math.max(
              lane.record.committedOffset,
              detail.committedOffset!,
            ),
          };
          hintedLanes.add(detail.streamId);
          return;
        }
      }
      if (detail.kind === "event") {
        dirtyEvents = true;
        dirtyStatus = true;
      } else if (detail.kind === "stream") {
        dirtyTopology = true;
        dirtyStatus = true;
      } else {
        dirtyTopology = true;
        dirtyEvents = true;
        dirtyStatus = true;
        if (detail.kind === "operation") reconcileRequested = true;
      }
    }
    async function resolveOrigin(output: StreamOutput): Promise<StreamOutput> {
      const run = output.metadata.sourceActionRunId;
      if (typeof run !== "string" || !run.trim()) return output;
      let pending = originReads.get(run);
      if (!pending) {
        if (originReads.size >= 256) {
          originReads.delete(originReads.keys().next().value!);
        }
        pending = origin(input.operationId, output);
        originReads.set(run, pending);
      }
      const resolved = await pending;
      return resolved.metadata.sourceAction
        ? {
          ...output,
          metadata: {
            ...output.metadata,
            sourceAction: resolved.metadata.sourceAction,
          },
        }
        : output;
    }
    function stop(reason?: unknown) {
      if (stopped) return;
      stopped = true;
      abort.abort(reason);
      changes.close();
      removeHint?.();
      for (const lane of lanes.values()) {
        lane.terminal.reject(reason ?? new Error("Observation detached."));
        for (const close of lane.closers) close(reason);
      }
      lanes.clear();
      hubs.delete(key);
    }
    function start() {
      if (running || stopped) return;
      running = true;
      void run();
    }
    async function waitForChange(milliseconds: number) {
      const timeoutMs = Math.min(
        60_000,
        Math.max(100, Math.ceil(milliseconds)),
      );
      if (milliseconds >= 100) {
        return await changes.wait({
          timeoutMs,
          signal: abort.signal,
        });
      }
      // Catalog wait accepts 100ms..60s; a short cadence uses cancellation, retaining hints.
      const deadline = new AbortController();
      const aborted = () => deadline.abort(abort.signal.reason);
      abort.signal.addEventListener("abort", aborted, { once: true });
      if (abort.signal.aborted) aborted();
      const timer = setTimeout(() => deadline.abort(), milliseconds);
      try {
        return await changes.wait({ timeoutMs, signal: deadline.signal });
      } finally {
        clearTimeout(timer);
        abort.signal.removeEventListener("abort", aborted);
      }
    }
    async function run() {
      let started = 0;
      try {
        while (!abort.signal.aborted) {
          let delay = Math.max(
            0,
            limits.minimumScanMs - (performance.now() - started),
          );
          // Byte hints bypass the topology/status cadence. One scoped watch services all lanes.
          if (delay) await refreshHintedLanes();
          while (delay > 0 && !abort.signal.aborted) {
            const changed = await waitForChange(delay);
            if (changed) await refreshHintedLanes();
            delay = Math.max(
              0,
              limits.minimumScanMs - (performance.now() - started),
            );
          }
          if (abort.signal.aborted) return;
          started = performance.now();
          if (started - lastSafetyScan >= limits.safetyScanMs) {
            dirtyTopology = true;
            dirtyEvents = true;
            dirtyStatus = true;
            lastSafetyScan = started;
          }
          await refreshHintedLanes();
          const advanced = await scan();
          if (abort.signal.aborted) return;
          if (dirtyStatus || reconcileRequested) {
            dirtyStatus = false;
            const record = await runtime.operations.get(
              input.namespace,
              input.operationId,
            );
            if (!record) {
              throw failure(
                "operation_replay_expired",
                410,
                "Operation replay metadata has expired.",
              );
            }
            let status: ApplicationOperationStatus | null = record;
            if (
              reconcileRequested ||
              performance.now() - lastReconciledAt >=
                limits.safetyScanMs ||
              (!lanes.size && advanced &&
                !["completed", "failed", "cancelled"].includes(record.state))
            ) {
              status = await application.operationStatus(input);
              lastReconciledAt = performance.now();
              reconcileRequested = false;
            }
            cachedStatus = status;
          }
          const status = cachedStatus;
          if (
            status &&
            ["completed", "failed", "cancelled"].includes(status.state)
          ) {
            if (!finalizing) {
              finalizing = true;
              dirtyTopology = true;
              dirtyEvents = true;
              dirtyStatus = true;
              continue;
            }
            // A final no-progress pass includes lanes/events racing settlement.
            if (!advanced && !lanes.size) {
              terminal = terminalOutput(status);
              for (const subscriber of [...subscribers]) {
                subscriber.output(terminal);
                subscriber.finish();
              }
              return;
            }
            dirtyTopology = true;
            dirtyEvents = true;
            dirtyStatus = true;
            continue;
          }
          await waitForChange(limits.safetyScanMs);
        }
      } catch (error) {
        if (abort.signal.aborted) return;
        for (const subscriber of [...subscribers]) subscriber.fail(error);
        stop(error);
      }
    }
    async function scan() {
      let advanced = false;
      const topology = dirtyTopology;
      dirtyTopology = false;
      while (topology && !abort.signal.aborted) {
        const streams = await runtime.operations.listStreams({
          ...input,
          ...(streamOrdinal ? { afterStreamOrdinal: streamOrdinal } : {}),
          limit: 250,
        });
        for (const record of streams) {
          if (abort.signal.aborted) return advanced;
          streamOrdinal = record.streamOrdinal;
          if (lanes.size >= limits.maxActiveStreams) {
            throw failure(
              "observation_renewal_required",
              409,
              "Too many active observation streams; renew from the processed checkpoint.",
            );
          }
          const lane: Lane = {
            record,
            offset: 0,
            terminal: deferred<StreamTerminalStatus>(),
            followers: new Set(),
            closers: new Set(),
          };
          lanes.set(record.streamId, lane);
          const output = await resolveOrigin({
            ...record.descriptor,
            streamOrdinal: record.streamOrdinal,
            // Subscribers replace this placeholder with an independent reader.
            payload: new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            terminal: lane.terminal.promise,
          });
          // Retain the generic attribution in the existing descriptor, never viewer attributes.
          lane.record = { ...record, descriptor: output };
          for (const subscriber of [...subscribers]) {
            subscriber.output(output);
          }
          if (record.state === "terminal") await readLane(lane, record);
          advanced = true;
        }
        if (streams.length < 250) break;
      }
      const events = dirtyEvents;
      dirtyEvents = false;
      while (events && !abort.signal.aborted) {
        const indexed = await runtime.operations.listOperationEventIds({
          ...input,
          ...(eventOrdinal ? { afterEventOrdinal: eventOrdinal } : {}),
          limit: 250,
        });
        for (const entry of indexed) {
          const event = await runtime.events.resolve(
            input.namespace,
            entry.eventId,
          );
          eventOrdinal = entry.eventOrdinal;
          if (event) {
            const output = { ...event, replayPosition: entry.eventOrdinal };
            for (const subscriber of [...subscribers]) {
              subscriber.output(output);
            }
          }
          advanced = true;
        }
        if (indexed.length < 250) break;
      }
      if (topology) await refreshLanes();
      return advanced;
    }
    async function refreshHintedLanes() {
      const streams = [...hintedLanes];
      hintedLanes.clear();
      for (const streamId of streams) {
        const lane = lanes.get(streamId);
        if (lane && !abort.signal.aborted) {
          await readLane(lane, lane.record);
        }
      }
    }
    async function refreshLanes() {
      // One catalog refresh and committed Body read per live lane, regardless of viewers.
      for (const lane of [...lanes.values()]) {
        if (abort.signal.aborted) break;
        const current = await runtime.operations.getStream(
          input.namespace,
          input.operationId,
          lane.record.streamId,
        );
        if (!current) {
          throw failure(
            "operation_replay_expired",
            410,
            "Operation stream replay metadata has expired.",
          );
        }
        await readLane(lane, current);
      }
    }
    async function readLane(lane: Lane, current: OperationStreamRecord) {
      lane.record = { ...current, descriptor: lane.record.descriptor };
      if (
        current.state === "terminal" && current.availability !== "retained"
      ) {
        endLane(lane);
        return;
      }
      // Nobody needs these bytes live; a later subscriber replays to this frontier from BodyStore.
      if (!lane.followers.size) lane.offset = current.committedOffset;
      while (
        lane.offset < current.committedOffset && !abort.signal.aborted
      ) {
        const end = Math.min(
          current.committedOffset,
          lane.offset + limits.bodyReadBytes,
        );
        const bytes = await runtime.streams.readCommittedRange({
          bodyId: current.bodyId,
          offset: lane.offset,
          end,
        });
        if (bytes === null) break;
        if (bytes.byteLength !== end - lane.offset) {
          throw failure(
            "operation_stream_unavailable",
            503,
            "Committed operation stream bytes are unavailable.",
          );
        }
        const offset = lane.offset;
        lane.offset = end;
        for (const follow of [...lane.followers]) follow(bytes, offset);
      }
      if (
        current.state === "terminal" &&
        lane.offset === current.committedOffset
      ) endLane(lane);
    }
    function endLane(lane: Lane) {
      reconcileRequested = true;
      dirtyStatus = true;
      const record = lane.record;
      lane.terminal.resolve({
        outcome: record.outcome ?? "completed",
        availability: record.availability,
        capture: record.capture ?? "complete",
        offset: record.committedOffset,
        terminalAt: record.terminalAt ?? record.updatedAt,
      });
      for (const close of [...lane.closers]) close();
      lanes.delete(record.streamId);
    }
    return {
      key,
      input,
      runtime,
      changes,
      subscribers,
      lanes,
      abort,
      get eventOrdinal() {
        return eventOrdinal;
      },
      get streamOrdinal() {
        return streamOrdinal;
      },
      get terminal() {
        return terminal;
      },
      get removeHint() {
        return removeHint;
      },
      set removeHint(value: (() => void) | undefined) {
        removeHint = value;
      },
      release,
      hint,
      resolveOrigin,
      stop,
      start,
    };
  }

  async function attach(
    input: ApplicationOperationAttachInput,
  ): Promise<ApplicationOperationAttachment> {
    assertOpen();
    const operationId = requiredText(input.operationId, "Operation id");
    const namespace = requiredText(
      input.namespace ?? application.config.namespace,
      "Operation namespace",
    );
    const databaseSchema = requiredText(
      input.databaseSchema ?? application.config.databaseSchema,
      "Operation database schema",
    );
    const normalized = {
      namespace,
      databaseSchema,
      operationId: operationId,
    };
    const position = decodeOperationReplayCursor(input.cursor);
    const tracker = createOperationReplayCursorTracker(position);
    const key = JSON.stringify([databaseSchema, namespace, operationId]);
    let promise = hubs.get(key);
    if (!promise) {
      promise = (async () => {
        const runtime = databaseSchema === application.config.databaseSchema
          ? application
          : await application.databaseScope(databaseSchema);
        assertOpen();
        const status = await application.operationStatus(normalized);
        assertOpen();
        if (!status) {
          throw failure("operation_not_found", 404, "Operation was not found.");
        }
        const changes = await runtime.operations.watch(operationId, {
          namespace,
        });
        if (closing) {
          changes.close();
          assertOpen();
        }
        const hub = createHub(key, normalized, runtime, changes);
        try {
          hub.removeHint = await runtime.operations.onChange(
            (changedId, detail) => {
              if (changedId === operationId) hub.hint(detail);
            },
            { namespace },
          );
          if (closing) {
            hub.stop();
            assertOpen();
          }
          return hub;
        } catch (error) {
          hub.stop(error);
          throw error;
        }
      })();
      hubs.set(key, promise);
      void promise.catch(() => {
        if (hubs.get(key) === promise) hubs.delete(key);
      });
    }
    const hub = await promise;
    if (closing) {
      hub.stop();
      throw failure(
        "application_closed",
        503,
        "Application observation readers are closed.",
      );
    }
    let detached = false;
    let detachedError: unknown;
    let renewing = false;
    let renewalQueues: ObservationQueue<Uint8Array>[] = [];
    let catchingUp = true;
    let finished = false;
    let queuedBytes = 0;
    let queuedItems = 0;
    let eventOrdinal = position.operationEventPositions?.[operationId] ??
      position.eventPosition;
    let streamOrdinal = 0n;
    const eventCutoff = hub.eventOrdinal;
    const streamCutoff = hub.streamOrdinal;
    const completion = deferred<void>();
    const drained = deferred<void>();
    const payloadQueues = new Set<ObservationQueue<Uint8Array>>();
    const payloadDetachers = new Set<() => void>();
    const pending: { output: ApplicationOutput; bytes: number }[] = [];
    const prepared = new WeakSet<object>();
    const reserve = (bytes: number, logicalOutput = false) => {
      if (detached) return false;
      // One legal logical output may exceed the ordinary backlog budget.
      // It occupies an otherwise empty queue; binary queues keep their byte limit.
      const singleLargeOutput = logicalOutput && queuedItems === 0 &&
        bytes <= MAX_LOGICAL_OUTPUT_BYTES;
      if (
        (queuedBytes + bytes > limits.maxQueuedBytes && !singleLargeOutput) ||
        queuedItems + 1 > limits.maxQueuedOutputs
      ) {
        subscriber.fail(
          failure(
            "observation_renewal_required",
            409,
            "Observation fell behind; renew from the processed checkpoint.",
          ),
        );
        return false;
      }
      queuedBytes += bytes;
      queuedItems++;
      return true;
    };
    const release = (bytes: number) => {
      queuedBytes -= bytes;
      queuedItems--;
    };
    const stopRenewal = (reason: string) => {
      renewing = false;
      const error = new Error(reason);
      outputs.error(error);
      for (const queue of renewalQueues) queue.error(error);
      renewalQueues = [];
      pendingRenewals.delete(stopRenewal);
    };
    const cleanup = () => {
      if (detached) return;
      detached = true;
      const queues = [outputs, ...payloadQueues];
      for (const detach of [...payloadDetachers]) detach();
      for (const item of pending.splice(0)) release(item.bytes);
      hub.release(subscriber);
      void Promise.all(queues.map((queue) => queue.drained)).then(() =>
        drained.resolve()
      );
    };
    const outputs = createQueue<ApplicationOutput>(
      (bytes) => reserve(bytes, true),
      release,
      () => {
        cleanup();
        completion.resolve();
      },
    );
    const maybeRelease = () => {
      if (finished && !payloadDetachers.size) cleanup();
    };

    const payload = (
      record: OperationStreamRecord,
      fromOffset: number,
      lane?: Lane,
    ) => {
      if (payloadDetachers.size >= limits.maxActiveStreams) {
        throw failure(
          "observation_renewal_required",
          409,
          "Too many undrained observation streams; renew from the processed checkpoint.",
        );
      }
      const cutoff = lane?.offset ?? record.committedOffset;
      let offset = fromOffset;
      let removed = false;
      const queue = createQueue<Uint8Array>(
        reserve,
        release,
        () => remove(),
        (bytes) => bytes.slice(),
      );
      payloadQueues.add(queue);
      const follow = (bytes: Uint8Array, start: number) => {
        const skip = Math.max(0, fromOffset - start);
        if (skip < bytes.length) {
          queue.push(skip ? bytes.subarray(skip) : bytes, bytes.length);
        }
      };
      const close = (error?: unknown) => {
        if (error !== undefined) queue.error(error);
        else queue.close();
      };
      const remove = () => {
        if (removed) return;
        removed = true;
        lane?.followers.delete(follow);
        lane?.closers.delete(close);
        payloadQueues.delete(queue);
        payloadDetachers.delete(remove);
        maybeRelease();
      };
      payloadDetachers.add(remove);
      if (lane) {
        lane.followers.add(follow);
        lane.closers.add(close);
      } else queue.close();
      // Registration precedes finite catch-up: writes during the Body read are queued once.
      const liveReader = queue.stream.getReader();
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            if (detached && !renewing) {
              if (detachedError !== undefined) controller.error(detachedError);
              else controller.close();
              remove();
              return;
            }
            if (
              !detached && offset < cutoff &&
              !(record.state === "terminal" &&
                record.availability !== "retained")
            ) {
              const end = Math.min(cutoff, offset + limits.bodyReadBytes);
              const bytes = await hub.runtime.streams.readCommittedRange({
                bodyId: record.bodyId,
                offset,
                end,
              });
              if (bytes === null || bytes.byteLength !== end - offset) {
                throw failure(
                  "operation_stream_unavailable",
                  503,
                  "Committed operation stream bytes are unavailable.",
                );
              }
              offset = end;
              controller.enqueue(bytes);
              return;
            }
            const next = await liveReader.read();
            if (next.done) {
              controller.close();
              remove();
            } else controller.enqueue(next.value);
          } catch (error) {
            remove();
            controller.error(error);
            subscriber.fail(error);
          }
        },
        async cancel(reason) {
          remove();
          await liveReader.cancel(reason);
        },
      }, { highWaterMark: 0 });
    };

    const emit = (output: ApplicationOutput) => {
      if (detached) return;
      if (output.type === "stream.output") {
        const stream = output as StreamOutput;
        const ordinal = BigInt(stream.streamOrdinal!);
        if (ordinal <= streamOrdinal) return;
        streamOrdinal = ordinal;
        const checkpoint = tracker.streamPosition({
          operationId: operationId,
          streamOrdinal: stream.streamOrdinal!,
        });
        if (checkpoint.consumed) return;
        if (!prepared.has(stream)) {
          const lane = hub.lanes.get(stream.streamId);
          const record = lane?.record;
          if (!record) {
            throw failure(
              "observation_renewal_required",
              409,
              "Observation replay boundary advanced; renew from the processed checkpoint.",
            );
          }
          if (checkpoint.offset > record.committedOffset) {
            throw failure(
              "replay_cursor_ahead",
              409,
              "Replay cursor is ahead of the durable stream.",
            );
          }
          output = {
            ...stream,
            payload: payload(record, checkpoint.offset, lane),
          };
        }
      } else {
        const replay =
          (output as ApplicationOutput & { replayPosition?: string })
            .replayPosition;
        if (replay) {
          if (eventOrdinal && BigInt(replay) <= BigInt(eventOrdinal)) return;
          eventOrdinal = replay;
        }
      }
      outputs.push(output, outputBytes(output));
    };
    const subscriber: Subscriber = {
      fail(error) {
        if (detached) return;
        detachedError = error;
        renewing = (error as { code?: unknown } | null)?.code ===
          "observation_renewal_required";
        // Detach upstream immediately, while allowing the finite accepted
        // logical/byte prefix to reach the client checkpoint before renewal.
        if (renewing && error instanceof Error) {
          Object.assign(error, { drainObservationPrefix: true });
        }
        if (renewing) {
          renewalQueues = [...payloadQueues];
          pendingRenewals.add(stopRenewal);
          void drained.promise.then(() => pendingRenewals.delete(stopRenewal));
        }
        outputs.error(error, renewing);
        for (const queue of payloadQueues) queue.error(error, renewing);
        cleanup();
        completion.reject(error);
      },
      output(output) {
        try {
          if (detached) return;
          if (output.type === "stream.output") {
            const stream = output as StreamOutput;
            const checkpoint = tracker.streamPosition({
              operationId: operationId,
              streamOrdinal: stream.streamOrdinal!,
            });
            // Subscribe now, before async catch-up: even a lane ending during catch-up is retained in this bounded queue.
            if (
              checkpoint.consumed ||
              (streamCutoff &&
                BigInt(stream.streamOrdinal!) <= BigInt(streamCutoff))
            ) return;
            const lane = hub.lanes.get(stream.streamId)!;
            if (checkpoint.offset > lane.record.committedOffset) {
              throw failure(
                "replay_cursor_ahead",
                409,
                "Replay cursor is ahead of the durable stream.",
              );
            }
            output = {
              ...stream,
              payload: payload(lane.record, checkpoint.offset, lane),
            };
            prepared.add(output);
          }
          if (catchingUp) {
            const bytes = outputBytes(output);
            if (reserve(bytes, true)) pending.push({ output, bytes });
          } else emit(output);
        } catch (error) {
          subscriber.fail(error);
        }
      },
      finish() {
        if (catchingUp) {
          finished = true;
          return;
        }
        finished = true;
        outputs.close();
        completion.resolve();
        maybeRelease();
      },
    };
    hub.subscribers.add(subscriber);
    void (async () => {
      try {
        // Historic lanes are independently replayed only to the captured catalog boundary.
        let after: string | undefined;
        while (streamCutoff && !detached) {
          const records = await hub.runtime.operations.listStreams({
            ...normalized,
            ...(after ? { afterStreamOrdinal: after } : {}),
            limit: 250,
          });
          for (const listed of records) {
            if (detached) return;
            let record = listed;
            if (BigInt(record.streamOrdinal) > BigInt(streamCutoff)) break;
            after = record.streamOrdinal;
            streamOrdinal = BigInt(record.streamOrdinal);
            const checkpoint = tracker.streamPosition({
              operationId: operationId,
              streamOrdinal: record.streamOrdinal,
            });
            if (checkpoint.consumed) continue;
            if (checkpoint.offset > record.committedOffset) {
              throw failure(
                "replay_cursor_ahead",
                409,
                "Replay cursor is ahead of the durable stream.",
              );
            }
            const lane = hub.lanes.get(record.streamId);
            if (!lane && record.state !== "terminal") {
              const current = await hub.runtime.operations.getStream(
                namespace,
                operationId,
                record.streamId,
              );
              if (!current) {
                throw failure(
                  "operation_replay_expired",
                  410,
                  "Operation stream replay metadata has expired.",
                );
              }
              if (current.state !== "terminal") {
                throw failure(
                  "observation_renewal_required",
                  409,
                  "Observation replay boundary advanced; renew from the processed checkpoint.",
                );
              }
              record = current;
            }
            const stream = await hub.resolveOrigin({
              ...(lane?.record.descriptor ?? record.descriptor),
              streamOrdinal: record.streamOrdinal,
              payload: payload(record, checkpoint.offset, lane),
              terminal: lane?.terminal.promise ?? Promise.resolve({
                outcome: record.outcome ?? "completed",
                availability: record.availability,
                capture: record.capture ?? "complete",
                offset: record.committedOffset,
                terminalAt: record.terminalAt ?? record.updatedAt,
              }),
            });
            outputs.push(stream, outputBytes(stream));
          }
          if (
            records.length < 250 || !after ||
            BigInt(after) >= BigInt(streamCutoff)
          ) break;
        }
        while (
          eventCutoff && !detached &&
          (!eventOrdinal || BigInt(eventOrdinal) < BigInt(eventCutoff))
        ) {
          const indexed = await hub.runtime.operations.listOperationEventIds({
            ...normalized,
            ...(eventOrdinal ? { afterEventOrdinal: eventOrdinal } : {}),
            limit: 250,
          });
          if (!indexed.length) break;
          for (const entry of indexed) {
            if (detached) return;
            if (BigInt(entry.eventOrdinal) > BigInt(eventCutoff)) break;
            const event = await hub.runtime.events.resolve(
              namespace,
              entry.eventId,
            );
            eventOrdinal = entry.eventOrdinal;
            if (event) {
              const output = { ...event, replayPosition: entry.eventOrdinal };
              outputs.push(output, outputBytes(event));
            }
          }
        }
        catchingUp = false;
        for (const item of pending.splice(0)) {
          release(item.bytes);
          emit(item.output);
        }
        if (hub.terminal && !finished) {
          emit(hub.terminal);
          finished = true;
        }
        if (finished) subscriber.finish();
      } catch (error) {
        subscriber.fail(error);
      }
    })();
    hub.start();
    return {
      operationId: operationId,
      replayCursor: encodeOperationReplayCursor(position),
      outputs: outputs.stream,
      done: completion.promise,
      drained: drained.promise,
      detach(reason = "observation_detached") {
        if (reason === "observation_renewal_draining") {
          if (!detached) {
            subscriber.fail(failure(
              "observation_renewal_required",
              409,
              "Observation requires renewal after its queued prefix.",
            ));
          }
          return Promise.resolve();
        }
        if (detached && !renewing) return Promise.resolve();
        if (renewing) stopRenewal(reason);
        renewing = false;
        const error = new Error(reason);
        outputs.error(error);
        for (const queue of renewalQueues) queue.error(error);
        renewalQueues = [];
        for (const queue of payloadQueues) queue.error(error);
        cleanup();
        completion.resolve();
        return Promise.resolve();
      },
    };
  }
  return {
    attach,
    async close(reason = "application_shutdown") {
      closing = true;
      for (const stop of [...pendingRenewals]) stop(reason);
      const error = new Error(reason);
      await Promise.allSettled([...hubs.values()].map(async (pending) => {
        const hub = await pending;
        for (const subscriber of [...hub.subscribers]) subscriber.fail(error);
        hub.stop(error);
      }));
    },
  };
}

function outputBytes(output: ApplicationOutput) {
  const value = output.type === "stream.output"
    ? { ...output, payload: undefined, terminal: undefined }
    : output;
  const size = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  if (size > MAX_LOGICAL_OUTPUT_BYTES) {
    throw failure(
      OBSERVATION_FRAME_CAPACITY_CODE,
      409,
      `Logical observation output exceeds its ${MAX_LOGICAL_OUTPUT_BYTES} byte capacity.`,
    );
  }
  return size;
}

function terminalOutput(status: ApplicationOperationStatus): ApplicationOutput {
  const state = status.state as "completed" | "failed" | "cancelled";
  return {
    durable: false,
    type: `operation.${state}`,
    namespace: status.namespace,
    correlationId: status.correlationId,
    payload: { status: state },
    data: { status: state },
    metadata: { operationId: status.operationId, status: state },
    createdAt: status.completedAt ?? status.updatedAt,
    operationId: status.operationId,
    state,
  } as ApplicationOutput;
}
