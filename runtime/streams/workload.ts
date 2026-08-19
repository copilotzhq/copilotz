import type { BoundCollection } from "../collections/index.ts";
import type { AssetBodyStore } from "../content/index.ts";
import type {
  DeliveryWorkload,
  ExecutionWorkInput,
} from "../execution/index.ts";
import { createStreamWriter, type StreamWriter } from "./writer.ts";
import { openStreamFollower } from "./follower.ts";

export const COPILOTZ_STREAM_WORKLOAD = "copilotz.stream.v1";
export const COPILOTZ_STREAM_DISPATCH_SCHEMA = "copilotz.stream.dispatch.v1";
export const COPILOTZ_STREAM_RESULT_SCHEMA = "copilotz.stream.result.v1";

export type StreamDispatchAction = "write" | "follow";

export type StreamDispatchMetadata = Readonly<{
  schema: typeof COPILOTZ_STREAM_DISPATCH_SCHEMA;
  databaseSchema: string;
  action: StreamDispatchAction;
  namespace: string;
  threadId: string;
  streamId?: string;
  lane?: string;
  mediaType?: string;
  participantId?: string;
  offset?: number;
  correlationId?: string;
}>;

export type StreamResultMetadata = Readonly<{
  schema: typeof COPILOTZ_STREAM_RESULT_SCHEMA;
  action: StreamDispatchAction;
  streamId: string;
  hasOutput: boolean;
  mediaType: string;
}>;

export type StreamWorkloadScope = Readonly<{
  streams: BoundCollection;
  store: AssetBodyStore;
}>;

export type CreateStreamWorkloadOptions = Readonly<{
  resolve(
    databaseSchema: string,
  ): StreamWorkloadScope | Promise<StreamWorkloadScope>;
}>;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function requiredText(
  value: unknown,
  key: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Stream dispatch metadata requires '${key}'.`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError("Stream dispatch optional text must be non-empty.");
  }
  return value.trim();
}

function optionalOffset(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError("Stream follow offset must be a non-negative integer.");
  }
  return value as number;
}

export function parseStreamDispatchMetadata(
  value: Readonly<Record<string, unknown>>,
): StreamDispatchMetadata {
  if (value.schema !== COPILOTZ_STREAM_DISPATCH_SCHEMA) {
    throw new TypeError(
      `Unsupported stream dispatch schema '${String(value.schema)}'.`,
    );
  }
  const action = value.action;
  if (action !== "write" && action !== "follow") {
    throw new TypeError(
      "Stream dispatch metadata requires action 'write' or 'follow'.",
    );
  }
  const metadata: StreamDispatchMetadata = Object.freeze({
    schema: COPILOTZ_STREAM_DISPATCH_SCHEMA,
    databaseSchema: requiredText(value.databaseSchema, "databaseSchema"),
    action,
    namespace: requiredText(value.namespace, "namespace"),
    threadId: requiredText(value.threadId, "threadId"),
    ...(optionalText(value.streamId) ? { streamId: optionalText(value.streamId) } : {}),
    ...(optionalText(value.lane) ? { lane: optionalText(value.lane) } : {}),
    ...(optionalText(value.mediaType)
      ? { mediaType: optionalText(value.mediaType) }
      : {}),
    ...(optionalText(value.participantId)
      ? { participantId: optionalText(value.participantId) }
      : {}),
    ...(optionalOffset(value.offset) !== undefined
      ? { offset: optionalOffset(value.offset) }
      : {}),
    ...(optionalText(value.correlationId)
      ? { correlationId: optionalText(value.correlationId) }
      : {}),
  });
  if (action === "write") {
    requiredText(metadata.lane, "lane");
    requiredText(metadata.mediaType, "mediaType");
  } else {
    requiredText(metadata.streamId, "streamId");
  }
  return metadata;
}

export function jsonStreamDispatchMetadata(
  metadata: StreamDispatchMetadata,
): NonNullable<ExecutionWorkInput["metadata"]> {
  return JSON.parse(JSON.stringify(metadata)) as NonNullable<
    ExecutionWorkInput["metadata"]
  >;
}

async function pumpWrite(
  writer: StreamWriter,
  input: ReadableStream<Uint8Array>,
  signal: AbortSignal,
): Promise<void> {
  const reader = input.getReader();
  const onAbort = () => {
    void reader.cancel(signal.reason).catch(() => undefined);
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) break;
      if (!(next.value instanceof Uint8Array)) {
        throw new TypeError("Stream write input must yield Uint8Array chunks.");
      }
      await writer.write(next.value);
    }
    signal.throwIfAborted();
    await writer.finalize();
  } catch (error) {
    await writer.abandon(
      error instanceof Error ? error.message : String(error),
    ).catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener("abort", onAbort);
    try {
      reader.releaseLock();
    } catch {
      // Reader was cancelled by abort.
    }
  }
}

function followUntilSettled(
  follower: ReadableStream<Uint8Array>,
  settled: Promise<void>,
  onCancel?: (reason?: unknown) => Promise<void>,
): ReadableStream<Uint8Array> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      reader = follower.getReader();
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) break;
          controller.enqueue(next.value);
        }
        await settled;
        controller.close();
      } catch (error) {
        await settled.catch(() => undefined);
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader?.cancel(reason).catch(() => undefined);
      await onCancel?.(reason);
    },
  });
}

function resultMetadata(
  action: StreamDispatchAction,
  streamId: string,
  mediaType: string,
  hasOutput: boolean,
): StreamResultMetadata {
  return Object.freeze({
    schema: COPILOTZ_STREAM_RESULT_SCHEMA,
    action,
    streamId,
    hasOutput,
    mediaType,
  });
}

/** Oxian handler that writes or follows one durable stream asset. */
export function createStreamWorkload(
  options: CreateStreamWorkloadOptions,
): DeliveryWorkload {
  return async (context) => {
    const metadata = parseStreamDispatchMetadata(record(context.metadata));
    const scope = await options.resolve(metadata.databaseSchema);
    if (metadata.action === "follow") {
      const follower = await openStreamFollower({
        streams: scope.streams,
        store: scope.store,
        namespace: metadata.namespace,
        streamId: metadata.streamId!,
        offset: metadata.offset,
      });
      return {
        metadata: resultMetadata(
          "follow",
          metadata.streamId!,
          follower.mediaType,
          true,
        ),
        body: follower.body,
      };
    }

    const writer = await createStreamWriter({
      streams: scope.streams,
      store: scope.store,
      namespace: metadata.namespace,
      threadId: metadata.threadId,
      lane: metadata.lane!,
      mediaType: metadata.mediaType!,
      ...(metadata.participantId
        ? { participantId: metadata.participantId }
        : {}),
      ...(metadata.streamId ? { id: metadata.streamId } : {}),
      ...(metadata.correlationId
        ? { metadata: { correlationId: metadata.correlationId } }
        : {}),
    });
    const follower = await openStreamFollower({
      streams: scope.streams,
      store: scope.store,
      namespace: metadata.namespace,
      streamId: writer.id,
    });
    await context.sendMetadata(
      resultMetadata("write", writer.id, metadata.mediaType!, true),
    );
    const onAbort = () => {
      void writer.abandon(
        context.signal.reason instanceof Error
          ? context.signal.reason.message
          : "cancelled",
      ).catch(() => undefined);
    };
    if (context.signal.aborted) onAbort();
    else {
      context.signal.addEventListener("abort", onAbort, { once: true });
    }
    const pumping = pumpWrite(writer, context.input, context.signal);
    pumping.finally(() => {
      context.signal.removeEventListener("abort", onAbort);
    }).catch(() => undefined);
    return followUntilSettled(follower.body, pumping, (reason) =>
      writer.abandon(
        reason instanceof Error ? reason.message : String(reason ?? "cancelled"),
      ));
  };
}
