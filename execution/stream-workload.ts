import type { WorkerWorkHandler } from "@oxian/oxian-js/worker";
import type { ParticipantRecord, ThreadRecord } from "@/types/resources.ts";
import type { StreamExecutor } from "./stream-executor.ts";
import type { EventBus } from "./event-bus.ts";
import { COPILOTZ_STREAM_WORKLOAD } from "./protocol.ts";
import { encodeStreamFrame } from "./stream-protocol.ts";

export interface StreamWorkMetadata extends Record<string, unknown> {
  protocol: typeof COPILOTZ_STREAM_WORKLOAD;
  streamId: string;
  type: string;
  mediaType: string;
  namespace: string;
  thread: ThreadRecord;
  participant: ParticipantRecord;
  targetId?: string;
  provider?: string;
  correlationId: string;
  metadata: Record<string, unknown>;
}

function metadataOf(
  value: Readonly<Record<string, unknown>>,
): StreamWorkMetadata {
  if (value.protocol !== COPILOTZ_STREAM_WORKLOAD) {
    throw new TypeError("Unsupported Copilotz stream protocol.");
  }
  for (
    const field of [
      "streamId",
      "type",
      "mediaType",
      "namespace",
      "correlationId",
    ]
  ) {
    if (typeof value[field] !== "string") {
      throw new TypeError(`Missing stream metadata '${field}'.`);
    }
  }
  if (!value.thread || typeof value.thread !== "object") {
    throw new TypeError("Missing stream thread metadata.");
  }
  if (!value.participant || typeof value.participant !== "object") {
    throw new TypeError("Missing stream participant metadata.");
  }
  return value as StreamWorkMetadata;
}

export function createStreamWorkload(
  options: { executor: StreamExecutor; bus: EventBus },
): WorkerWorkHandler {
  return (context) => {
    const metadata = metadataOf(context.metadata);
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    const writer = transform.writable.getWriter();
    const streamPumps = new Set<Promise<void>>();
    const subscription = options.bus.subscribe((event) =>
      event.durable && event.namespace === metadata.namespace &&
      event.correlationId === metadata.correlationId
    );

    void (async () => {
      const eventPump = (async () => {
        for await (const event of subscription.stream) {
          await writer.write(encodeStreamFrame({ kind: "event", event }));
        }
      })();
      try {
        await options.executor.execute(
          {
            streamId: metadata.streamId,
            type: metadata.type,
            mediaType: metadata.mediaType,
            payload: context.input,
            namespace: metadata.namespace,
            thread: metadata.thread,
            participant: metadata.participant,
            targetId: metadata.targetId,
            provider: metadata.provider,
            metadata: metadata.metadata ?? {},
            correlationId: metadata.correlationId,
            signal: context.signal,
          },
          {
            event: (event) =>
              writer.write(encodeStreamFrame({ kind: "event", event })),
            stream: async (output) => {
              const streamId = output.streamId ?? crypto.randomUUID();
              await writer.write(encodeStreamFrame({
                kind: "stream_start",
                streamId,
                participant: output.participant,
                mediaType: output.mediaType,
                threadId: metadata.thread.id,
                namespace: metadata.namespace,
                causationId: output.causationId,
                correlationId: output.correlationId ?? metadata.correlationId,
              }));
              const pump = (async () => {
                for await (const chunk of output.payload) {
                  await writer.write(encodeStreamFrame(
                    { kind: "stream_chunk", streamId },
                    chunk,
                  ));
                }
                await writer.write(
                  encodeStreamFrame({ kind: "stream_end", streamId }),
                );
              })();
              streamPumps.add(pump);
              void pump.finally(() => streamPumps.delete(pump));
            },
          },
        );
        subscription.close();
        await eventPump;
        await Promise.all(streamPumps);
        await writer.write(encodeStreamFrame({
          kind: "settled",
          streamId: metadata.streamId,
        }));
        await writer.close();
      } catch (error) {
        subscription.close();
        await eventPump.catch(() => undefined);
        await Promise.allSettled(streamPumps);
        await writer.write(encodeStreamFrame({
          kind: "error",
          streamId: metadata.streamId,
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        })).catch(() => undefined);
        await writer.close().catch(() => undefined);
      }
    })();

    return {
      metadata: {
        protocol: COPILOTZ_STREAM_WORKLOAD,
        streamId: metadata.streamId,
        correlationId: metadata.correlationId,
        accepted: true,
      },
      body: transform.readable,
    };
  };
}
