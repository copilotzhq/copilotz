import type {
  WorkerHostDispatchInput,
  WorkerHostWorkHandle,
} from "@oxian/oxian-js/host";
import type { ParticipantRecord, ThreadRecord } from "@/types/resources.ts";
import type { StreamSendHandle } from "@/attachments/types.ts";
import type { OutputHub } from "@/attachments/output-hub.ts";
import type { EventBus } from "./event-bus.ts";
import { COPILOTZ_STREAM_WORKLOAD } from "./protocol.ts";
import { decodeStreamFrames } from "./stream-protocol.ts";
import type { OxianDispatcher } from "./coordinator.ts";
import type { StreamWorkMetadata } from "./stream-workload.ts";

export interface OpenStreamOptions {
  streamId: string;
  type: string;
  mediaType: string;
  payload: ReadableStream<Uint8Array>;
  namespace: string;
  thread: ThreadRecord;
  participant: ParticipantRecord;
  targetId?: string;
  provider?: string;
  metadata?: Record<string, unknown>;
  correlationId: string;
}

export class StreamCoordinator {
  readonly #dispatcher: OxianDispatcher;
  readonly #events: EventBus;
  readonly #outputs: OutputHub;
  readonly #target?: WorkerHostDispatchInput["target"];
  readonly #durableCommitted?: () => void;
  readonly #active = new Map<string, WorkerHostWorkHandle>();

  constructor(options: {
    dispatcher: OxianDispatcher;
    events: EventBus;
    outputs: OutputHub;
    target?: WorkerHostDispatchInput["target"];
    durableCommitted?: () => void;
  }) {
    this.#dispatcher = options.dispatcher;
    this.#events = options.events;
    this.#outputs = options.outputs;
    this.#target = options.target;
    this.#durableCommitted = options.durableCommitted;
  }

  async open(options: OpenStreamOptions): Promise<StreamSendHandle> {
    const metadata: StreamWorkMetadata = {
      protocol: COPILOTZ_STREAM_WORKLOAD,
      streamId: options.streamId,
      type: options.type,
      mediaType: options.mediaType,
      namespace: options.namespace,
      thread: options.thread,
      participant: options.participant,
      ...(options.targetId ? { targetId: options.targetId } : {}),
      ...(options.provider ? { provider: options.provider } : {}),
      correlationId: options.correlationId,
      metadata: options.metadata ?? {},
    };
    const handle = await this.#dispatcher.dispatch({
      workload: COPILOTZ_STREAM_WORKLOAD,
      ...(this.#target ? { target: this.#target } : {}),
      metadata: JSON.parse(JSON.stringify(metadata)) as NonNullable<
        WorkerHostDispatchInput["metadata"]
      >,
      body: options.payload,
    });
    this.#active.set(options.streamId, handle);
    await handle.started;
    await handle.metadata;
    const done = this.#observe(options, handle);
    void done.catch(() => undefined);
    return {
      streamId: options.streamId,
      correlationId: options.correlationId,
      done,
      cancel: async (reason?: string) => {
        await handle.cancel(reason);
      },
    };
  }

  async close(reason = "attachment_closed"): Promise<void> {
    await Promise.all(
      [...this.#active.values()].map((handle) => handle.cancel(reason)),
    );
    this.#active.clear();
  }

  async #observe(
    input: OpenStreamOptions,
    handle: WorkerHostWorkHandle,
  ): Promise<void> {
    const streams = new Map<
      string,
      WritableStreamDefaultWriter<Uint8Array>
    >();
    try {
      for await (const frame of decodeStreamFrames(handle.output)) {
        const header = frame.header;
        if (header.kind === "event") {
          this.#events.publish(header.event);
          if (header.event.durable) this.#durableCommitted?.();
        } else if (header.kind === "stream_start") {
          const transform = new TransformStream<Uint8Array, Uint8Array>();
          streams.set(header.streamId, transform.writable.getWriter());
          this.#outputs.publishStream({
            kind: "stream",
            participant: header.participant,
            mediaType: header.mediaType,
            streamId: header.streamId,
            threadId: header.threadId,
            namespace: header.namespace,
            causationId: header.causationId,
            correlationId: header.correlationId,
            payload: transform.readable,
          });
        } else if (header.kind === "stream_chunk") {
          const writer = streams.get(header.streamId);
          if (!writer) {
            throw new Error(`Unknown output stream '${header.streamId}'.`);
          }
          await writer.write(frame.payload);
        } else if (header.kind === "stream_end") {
          const writer = streams.get(header.streamId);
          streams.delete(header.streamId);
          await writer?.close();
        } else if (header.kind === "error") {
          throw new Error(header.message);
        }
      }
      await handle.completed;
    } catch (error) {
      await Promise.all(
        [...streams.values()].map((writer) =>
          writer.abort(error).catch(() => undefined)
        ),
      );
      throw error;
    } finally {
      this.#active.delete(input.streamId);
      await Promise.all(
        [...streams.values()].map((writer) =>
          writer.close().catch(() => undefined)
        ),
      );
    }
  }
}
