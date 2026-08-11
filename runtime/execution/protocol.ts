import type {
  WorkerWorkContext,
  WorkerWorkHandler,
  WorkerWorkResult,
} from "../../dependencies/oxian-worker.ts";
import type { WorkHandle } from "../../dependencies/oxian-work.ts";
import type { CopilotzEvent } from "../events/index.ts";

export const COPILOTZ_WORK_OUTPUT_SCHEMA = "copilotz.work.output.v1";
export const COPILOTZ_WORK_FRAME_SCHEMA = "copilotz.work.frame.v1";

const FRAME_MAGIC = 0x43;
const FRAME_VERSION = 1;
const FRAME_HEADER_BYTES = 7;
const MAX_JSON_FRAME_BYTES = 1024 * 1024;
const OUTPUT_CHUNK_BYTES = 64 * 1024;

const EVENT_FRAME = 1;
const METADATA_FRAME = 2;
const OUTPUT_FRAME = 3;

type JsonRecord = Awaited<WorkHandle["metadata"]>;

export type CopilotzWorkOutputMetadata = Readonly<{
  schema: typeof COPILOTZ_WORK_OUTPUT_SCHEMA;
  framing: typeof COPILOTZ_WORK_FRAME_SCHEMA;
  workload: string;
}>;

export type CopilotzWorkOutputRelay = Readonly<{
  publish(event: CopilotzEvent): Promise<void>;
  wrap(
    workloads: Readonly<Record<string, WorkerWorkHandler>>,
  ): Readonly<Record<string, WorkerWorkHandler>>;
}>;

export type RelayCopilotzWorkHandleOptions = Readonly<{
  onEvent?: (event: CopilotzEvent) => void | Promise<void>;
}>;

function jsonRecord(value: unknown, name: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a JSON object.`);
  }
  return value as JsonRecord;
}

function frame(kind: number, payload: Uint8Array): Uint8Array {
  const result = new Uint8Array(FRAME_HEADER_BYTES + payload.byteLength);
  result[0] = FRAME_MAGIC;
  result[1] = FRAME_VERSION;
  result[2] = kind;
  new DataView(result.buffer).setUint32(3, payload.byteLength, false);
  result.set(payload, FRAME_HEADER_BYTES);
  return result;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function jsonFrame(kind: number, value: unknown): Uint8Array {
  const payload = encoder.encode(JSON.stringify(value));
  if (payload.byteLength > MAX_JSON_FRAME_BYTES) {
    throw new TypeError(
      `Copilotz work JSON frame exceeds ${MAX_JSON_FRAME_BYTES} bytes. ` +
        "Persist large content as an asset and send its reference.",
    );
  }
  return frame(kind, payload);
}

function eventFrame(event: CopilotzEvent): Uint8Array {
  return jsonFrame(EVENT_FRAME, event);
}

function metadataFrame(metadata: JsonRecord): Uint8Array {
  return jsonFrame(METADATA_FRAME, metadata);
}

function outputFrames(bytes: Uint8Array): readonly Uint8Array[] {
  if (bytes.byteLength === 0) return Object.freeze([]);
  const frames: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < bytes.byteLength;
    offset += OUTPUT_CHUNK_BYTES
  ) {
    frames.push(
      frame(
        OUTPUT_FRAME,
        bytes.subarray(
          offset,
          Math.min(offset + OUTPUT_CHUNK_BYTES, bytes.byteLength),
        ),
      ),
    );
  }
  return Object.freeze(frames);
}

function concat(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (left.byteLength === 0) return right;
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

type DecodedFrame = Readonly<{
  kind: number;
  payload: Uint8Array;
}>;

async function* decodeFrames(
  input: ReadableStream<Uint8Array>,
): AsyncGenerator<DecodedFrame> {
  let buffered: Uint8Array<ArrayBufferLike> = new Uint8Array();
  for await (const chunk of input) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError(
        "Copilotz work output must contain Uint8Array chunks.",
      );
    }
    buffered = concat(buffered, chunk);
    while (buffered.byteLength >= FRAME_HEADER_BYTES) {
      if (buffered[0] !== FRAME_MAGIC || buffered[1] !== FRAME_VERSION) {
        throw new TypeError("Invalid Copilotz work output frame header.");
      }
      const kind = buffered[2];
      const length = new DataView(
        buffered.buffer,
        buffered.byteOffset,
        buffered.byteLength,
      ).getUint32(3, false);
      if (
        kind !== EVENT_FRAME && kind !== METADATA_FRAME &&
        kind !== OUTPUT_FRAME
      ) {
        throw new TypeError(`Unknown Copilotz work frame kind '${kind}'.`);
      }
      if (
        (kind === EVENT_FRAME || kind === METADATA_FRAME) &&
        length > MAX_JSON_FRAME_BYTES
      ) {
        throw new TypeError("Copilotz work JSON frame exceeds its byte limit.");
      }
      if (kind === OUTPUT_FRAME && length > OUTPUT_CHUNK_BYTES) {
        throw new TypeError(
          "Copilotz work output frame exceeds its byte limit.",
        );
      }
      const total = FRAME_HEADER_BYTES + length;
      if (buffered.byteLength < total) break;
      yield Object.freeze({
        kind,
        payload: buffered.slice(FRAME_HEADER_BYTES, total),
      });
      buffered = buffered.slice(total);
    }
  }
  if (buffered.byteLength !== 0) {
    throw new TypeError("Copilotz work output ended with a partial frame.");
  }
}

function parseEvent(payload: Uint8Array): CopilotzEvent {
  const value = jsonRecord(JSON.parse(decoder.decode(payload)), "Event frame");
  if (
    typeof value.durable !== "boolean" ||
    typeof value.type !== "string" || !value.type.trim() ||
    typeof value.namespace !== "string" || !value.namespace.trim() ||
    typeof value.correlationId !== "string" || !value.correlationId.trim() ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(new Date(value.createdAt).getTime()) ||
    !Object.hasOwn(value, "payload") ||
    !value.routing || typeof value.routing !== "object" ||
    !value.visibility || typeof value.visibility !== "object" ||
    !value.metadata || typeof value.metadata !== "object"
  ) {
    throw new TypeError("Copilotz work output contains an invalid event.");
  }
  if (
    value.durable &&
    (typeof value.id !== "string" || !value.id.trim() ||
      typeof value.position !== "string" || !value.position.trim() ||
      !Number.isSafeInteger(value.schemaVersion) ||
      (value.schemaVersion as number) < 1)
  ) {
    throw new TypeError(
      "Copilotz work output contains an invalid durable event.",
    );
  }
  return Object.freeze(value) as unknown as CopilotzEvent;
}

function parseMetadata(payload: Uint8Array): JsonRecord {
  return Object.freeze(
    jsonRecord(JSON.parse(decoder.decode(payload)), "Metadata frame"),
  );
}

function workSourceKey(metadata: JsonRecord): string | undefined {
  if (
    metadata.schema === "copilotz.delivery.dispatch.v1" &&
    typeof metadata.deliveryId === "string"
  ) {
    return `delivery:${metadata.deliveryId}`;
  }
  if (
    metadata.schema === "copilotz.stream.dispatch.v1" &&
    typeof metadata.streamId === "string"
  ) {
    return `stream:${metadata.streamId}`;
  }
  if (
    metadata.schema === "copilotz.live.dispatch.v1" &&
    typeof metadata.dispatchAttemptId === "string"
  ) {
    return `live:${metadata.dispatchAttemptId}`;
  }
  return undefined;
}

function eventSourceKey(event: CopilotzEvent): string | undefined {
  const metadata = event.metadata;
  if (typeof metadata.sourceDeliveryId === "string") {
    return `delivery:${metadata.sourceDeliveryId}`;
  }
  if (typeof metadata.sourceStreamId === "string") {
    return `stream:${metadata.sourceStreamId}`;
  }
  if (typeof metadata.sourceLiveDispatchId === "string") {
    return `live:${metadata.sourceLiveDispatchId}`;
  }
  return undefined;
}

type OutputChannel = Readonly<{
  write(bytes: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(error: unknown): Promise<void>;
}>;

function createOutputChannel(
  writable: WritableStream<Uint8Array>,
): OutputChannel {
  const writer = writable.getWriter();
  let pending = Promise.resolve();
  let closed = false;
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    if (closed) return Promise.reject(new Error("Work output is closed."));
    const next = pending.then(operation);
    pending = next.catch(() => undefined);
    return next;
  };
  return Object.freeze({
    write: (bytes) => enqueue(() => writer.write(bytes)),
    async close() {
      if (closed) return;
      await pending;
      closed = true;
      await writer.close();
    },
    async abort(error) {
      if (closed) return;
      await pending.catch(() => undefined);
      closed = true;
      await writer.abort(error).catch(() => undefined);
    },
  });
}

function normalizeResult(result: WorkerWorkResult): Readonly<{
  metadata?: JsonRecord;
  body?: Uint8Array | ReadableStream<Uint8Array>;
}> {
  if (result === undefined) return Object.freeze({});
  if (result instanceof Uint8Array || result instanceof ReadableStream) {
    return Object.freeze({ body: result });
  }
  const value = jsonRecord(result, "Worker result");
  const metadata = value.metadata === undefined
    ? undefined
    : jsonRecord(value.metadata, "Worker result metadata");
  const body = value.body;
  if (
    body !== undefined && body !== null &&
    !(body instanceof Uint8Array) && !(body instanceof ReadableStream)
  ) {
    throw new TypeError(
      "Worker result body must be bytes or a ReadableStream.",
    );
  }
  return Object.freeze({
    ...(metadata ? { metadata } : {}),
    ...(body ? { body } : {}),
  });
}

async function writeBody(
  body: Uint8Array | ReadableStream<Uint8Array>,
  channel: OutputChannel,
  signal: AbortSignal,
): Promise<void> {
  if (body instanceof Uint8Array) {
    for (const encoded of outputFrames(body)) await channel.write(encoded);
    return;
  }
  const reader = body.getReader();
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw new TypeError(
          "Worker output stream must yield Uint8Array chunks.",
        );
      }
      for (const encoded of outputFrames(next.value)) {
        await channel.write(encoded);
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

/**
 * Frames every Copilotz workload output and routes worker-originated semantic
 * events into the exact active Oxian operation that caused them.
 */
export function createCopilotzWorkOutputRelay(): CopilotzWorkOutputRelay {
  const channels = new Map<string, Set<OutputChannel>>();

  const add = (key: string | undefined, channel: OutputChannel): void => {
    if (!key) return;
    const active = channels.get(key) ?? new Set<OutputChannel>();
    active.add(channel);
    channels.set(key, active);
  };
  const remove = (key: string | undefined, channel: OutputChannel): void => {
    if (!key) return;
    const active = channels.get(key);
    active?.delete(channel);
    if (active?.size === 0) channels.delete(key);
  };

  const wrapOne = (
    workload: string,
    handler: WorkerWorkHandler,
  ): WorkerWorkHandler => {
    return async (context: WorkerWorkContext) => {
      const output = new TransformStream<Uint8Array, Uint8Array>();
      const channel = createOutputChannel(output.writable);
      const key = workSourceKey(context.metadata);
      add(key, channel);

      await context.sendMetadata(Object.freeze({
        schema: COPILOTZ_WORK_OUTPUT_SCHEMA,
        framing: COPILOTZ_WORK_FRAME_SCHEMA,
        workload,
      }));

      void (async () => {
        let metadataWritten = false;
        const bridgedContext: WorkerWorkContext = Object.freeze({
          ...context,
          async sendMetadata(metadata) {
            if (metadataWritten) {
              throw new TypeError("Worker response metadata was sent twice.");
            }
            metadataWritten = true;
            await channel.write(metadataFrame(metadata));
          },
        });
        try {
          context.signal.throwIfAborted();
          const result = normalizeResult(await handler(bridgedContext));
          if (result.metadata) {
            if (metadataWritten) {
              throw new TypeError(
                "Worker returned metadata after sending it explicitly.",
              );
            }
            metadataWritten = true;
            await channel.write(metadataFrame(result.metadata));
          }
          if (!metadataWritten) await channel.write(metadataFrame({}));
          if (result.body) {
            await writeBody(result.body, channel, context.signal);
          }
          context.signal.throwIfAborted();
          remove(key, channel);
          await channel.close();
        } catch (error) {
          remove(key, channel);
          await channel.abort(error);
        }
      })();

      return output.readable;
    };
  };

  return Object.freeze({
    async publish(event) {
      const key = eventSourceKey(event);
      if (!key) return;
      const active = [...(channels.get(key) ?? [])];
      await Promise.all(
        active.map((channel) => channel.write(eventFrame(event))),
      );
    },
    wrap(workloads) {
      return Object.freeze(Object.fromEntries(
        Object.entries(workloads).map(([name, handler]) => [
          name,
          wrapOne(name, handler),
        ]),
      ));
    },
  });
}

function isBridgeMetadata(
  value: JsonRecord,
): value is CopilotzWorkOutputMetadata {
  return value.schema === COPILOTZ_WORK_OUTPUT_SCHEMA &&
    value.framing === COPILOTZ_WORK_FRAME_SCHEMA &&
    typeof value.workload === "string";
}

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return Object.freeze({ promise, resolve, reject });
}

/** Decodes Copilotz frames while preserving the ordinary Oxian WorkHandle. */
export function relayCopilotzWorkHandle(
  work: WorkHandle,
  options: RelayCopilotzWorkHandleOptions = {},
): WorkHandle {
  const resultMetadata = deferred<JsonRecord>();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const writer = output.writable.getWriter();
  let cancelled = false;

  const pump = (async () => {
    try {
      const transportMetadata = jsonRecord(
        await work.metadata,
        "Oxian work metadata",
      );
      if (!isBridgeMetadata(transportMetadata)) {
        resultMetadata.resolve(transportMetadata);
        await work.output.pipeTo(
          new WritableStream<Uint8Array>({
            write: (chunk) => writer.write(chunk),
          }),
        );
        await writer.close();
        return;
      }

      let metadataReceived = false;
      for await (const decoded of decodeFrames(work.output)) {
        if (decoded.kind === EVENT_FRAME) {
          await options.onEvent?.(parseEvent(decoded.payload));
          continue;
        }
        if (decoded.kind === METADATA_FRAME) {
          if (metadataReceived) {
            throw new TypeError("Copilotz work metadata frame was repeated.");
          }
          metadataReceived = true;
          resultMetadata.resolve(parseMetadata(decoded.payload));
          continue;
        }
        if (decoded.kind === OUTPUT_FRAME) {
          await writer.write(decoded.payload);
          continue;
        }
        throw new TypeError(
          `Unknown Copilotz work frame kind '${decoded.kind}'.`,
        );
      }
      if (!metadataReceived) {
        throw new TypeError("Copilotz work output omitted its metadata frame.");
      }
      await writer.close();
    } catch (error) {
      if (cancelled) {
        await writer.abort(error).catch(() => undefined);
        return;
      }
      resultMetadata.reject(error);
      await writer.abort(error).catch(() => undefined);
      await work.cancel("copilotz_output_protocol_failed").catch(() =>
        undefined
      );
      throw error;
    }
  })();
  pump.catch(() => undefined);

  return Object.freeze({
    operationId: work.operationId,
    streamId: work.streamId,
    metadata: resultMetadata.promise,
    output: output.readable,
    started: work.started,
    completed: (async () => {
      const terminal = await work.completed;
      await pump;
      return terminal;
    })(),
    async cancel(reason?: string) {
      cancelled = true;
      await writer.abort(reason).catch(() => undefined);
      return await work.cancel(reason);
    },
  });
}
