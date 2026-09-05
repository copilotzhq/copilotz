/** Lossless multipart transport for request-scoped Application outputs. @module */

import type {
  ApplicationOutput,
  StreamOutput,
} from "@copilotz/copilotz/streams";
import type { HttpObservation } from "./http-types.ts";
import {
  createOperationReplayCursorTracker,
  decodeOperationReplayCursor,
  streamErrorOutput,
} from "../runtime/streams/index.ts";
import type {
  OperationReplayCursorMutation,
} from "../runtime/streams/index.ts";

import { MAX_FRAME_BYTES } from "../client/protocol.ts";
import { outputActionRuns } from "./output-order.ts";

const encoder = new TextEncoder();
const FRAME_HEADER = "x-copilotz-frame";
const STREAM_HEADER = "x-copilotz-stream-id";
const OFFSET_HEADER = "x-copilotz-offset";
const CURSOR_HEADER = "x-copilotz-cursor";

type FrameKind = "output" | "stream-chunk" | "stream-end" | "stream-error";

function bytes(...values: readonly Uint8Array[]): Uint8Array {
  const size = values.reduce((total, value) => total + value.byteLength, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.byteLength;
  }
  return output;
}

function safeHeader(value: string, label: string): string {
  const result = value.replace(/[\r\n]/g, "").trim();
  if (!result) throw new TypeError(`${label} must be non-empty.`);
  return result;
}

function part(
  boundary: string,
  kind: FrameKind,
  content: Uint8Array,
  options: Readonly<{ streamId?: string; offset?: number; cursor?: string }> =
    {},
): Uint8Array {
  if (content.byteLength > MAX_FRAME_BYTES) {
    throw new RangeError("Multipart frame capacity exceeded.");
  }
  const headers = [
    `--${boundary}`,
    `content-type: ${
      kind === "stream-chunk"
        ? "application/octet-stream"
        : "application/json; charset=utf-8"
    }`,
    `content-length: ${content.byteLength}`,
    `${FRAME_HEADER}: ${kind}`,
    ...(options.streamId
      ? [`${STREAM_HEADER}: ${safeHeader(options.streamId, "Stream id")}`]
      : []),
    ...(options.offset === undefined
      ? []
      : [`${OFFSET_HEADER}: ${options.offset}`]),
    ...(options.cursor
      ? [`${CURSOR_HEADER}: ${safeHeader(options.cursor, "Replay cursor")}`]
      : []),
    "",
    "",
  ].join("\r\n");
  return bytes(encoder.encode(headers), content, encoder.encode("\r\n"));
}

function isStream(output: ApplicationOutput): output is StreamOutput {
  return output.type === "stream.output" &&
    typeof (output as { payload?: { getReader?: unknown } }).payload
        ?.getReader === "function";
}

function isTerminalOperationOutput(output: ApplicationOutput): boolean {
  return output.type === "operation.completed" ||
    output.type === "operation.failed" ||
    output.type === "operation.cancelled";
}

function descriptor(output: ApplicationOutput): unknown {
  if (!isStream(output)) return output;
  const {
    payload: _payload,
    terminal: _terminal,
    replayKey: _replayKey,
    ...value
  } = output;
  return value;
}

function boundedStreamError(
  streamId: string,
  offset: number,
): Uint8Array {
  return encoder.encode(JSON.stringify({
    type: "stream.error",
    streamId,
    offset,
    code: "stream_unavailable",
    outcome: "abandoned",
    availability: "missing",
    capture: "truncated",
    terminalAt: new Date().toISOString(),
    message: "Progressive stream became unavailable.",
  }));
}

function isReplayCapacityError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code ===
    "operation_replay_capacity_exceeded";
}

/** Encodes one complete request observation without materializing raw bytes. */
export function applicationOutputsMultipartResponse(
  source: HttpObservation,
  options: Readonly<{
    headers?: HeadersInit;
    boundary?: string;
    signal?: AbortSignal;
  }> = {},
): Response {
  const boundary = safeHeader(
    options.boundary ?? `copilotz-${crypto.randomUUID()}`,
    "Multipart boundary",
  );
  const transport = new TransformStream<Uint8Array, Uint8Array>(undefined, {
    highWaterMark: 256 * 1024,
    size: (value) => value.byteLength,
  }, {
    highWaterMark: 256 * 1024,
    size: (value) => value.byteLength,
  });
  const writer = transport.writable.getWriter();
  const initial = decodeOperationReplayCursor(source.replayCursor);
  const cursorTracker = createOperationReplayCursorTracker(initial);
  let cancelled = false;
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  const detach = async (reason: unknown) => {
    if (cancelled) return;
    cancelled = true;
    await Promise.allSettled([
      source.cancel("observation_detached"),
      ...[...readers].map((reader) => reader.cancel(reason)),
      writer.abort(reason),
    ]);
  };
  const abort = () => {
    void detach(options.signal?.reason);
  };
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener("abort", abort, { once: true });
  void writer.closed.catch(detach);
  const write = (value: Uint8Array) => writer.write(value);
  let frameTail: Promise<void> = Promise.resolve();
  const serializeFrame = <T>(task: () => Promise<T>): Promise<T> => {
    const result = frameTail.then(task, task);
    frameTail = result.then(() => undefined, () => undefined);
    return result;
  };
  const writePart = (
    build: (replayCursor: string) => Uint8Array,
    mutations: readonly OperationReplayCursorMutation[] = [],
  ): Promise<void> =>
    serializeFrame(async () => {
      const frame = build(cursorTracker.cursor(mutations));
      await write(frame);
      cursorTracker.commit(mutations);
    });
  const pump = async (
    output: StreamOutput,
    operationId: string | undefined,
    initialOffset: number,
  ): Promise<void> => {
    const reader = output.payload.getReader();
    readers.add(reader);
    let offset = initialOffset;
    const streamMutation = (
      action: "offset" | "end",
      nextOffset: number,
    ): OperationReplayCursorMutation => {
      if (!operationId || !output.streamOrdinal) {
        throw new Error("Application stream is missing its operation lane.");
      }
      return {
        kind: "operation-stream",
        action,
        operationId,
        streamOrdinal: output.streamOrdinal,
        offset: nextOffset,
      };
    };
    try {
      while (true) {
        const next = await reader.read();
        if (cancelled) return;
        if (next.done) break;
        for (
          let index = 0;
          index < next.value.length;
          index += MAX_FRAME_BYTES
        ) {
          const chunk = next.value.subarray(index, index + MAX_FRAME_BYTES);
          const fromOffset = offset;
          const toOffset = offset + chunk.length;
          await writePart((cursor) =>
            part(boundary, "stream-chunk", chunk, {
              streamId: output.streamId,
              offset: fromOffset,
              cursor,
            }), [streamMutation("offset", toOffset)]);
          offset = toOffset;
        }
      }
      if (cancelled) return;
      const terminal = await output.terminal;
      const streamError = streamErrorOutput(output.streamId, terminal);
      const terminalOffset = terminal.offset;
      if (streamError === null && terminalOffset !== offset) {
        throw new Error("Completed stream Body ended at an invalid offset.");
      }
      if (streamError) {
        await writePart(
          (replayCursor) =>
            part(
              boundary,
              "stream-error",
              encoder.encode(JSON.stringify(streamError)),
              {
                streamId: output.streamId,
                offset: terminalOffset,
                cursor: replayCursor,
              },
            ),
          operationId && output.streamOrdinal
            ? [streamMutation("end", terminalOffset)]
            : [],
        );
      } else {
        await writePart(
          (replayCursor) =>
            part(
              boundary,
              "stream-end",
              encoder.encode(JSON.stringify(terminal)),
              {
                streamId: output.streamId,
                offset: terminalOffset,
                cursor: replayCursor,
              },
            ),
          operationId && output.streamOrdinal
            ? [streamMutation("end", terminalOffset)]
            : [],
        );
      }
    } catch (error) {
      if (!cancelled) {
        await writePart((replayCursor) =>
          part(
            boundary,
            "stream-error",
            boundedStreamError(output.streamId, offset),
            {
              streamId: output.streamId,
              offset,
              cursor: replayCursor,
            },
          )
        ).catch(() => undefined);
      }
      if (!cancelled) throw error;
    } finally {
      readers.delete(reader);
      reader.releaseLock();
    }
  };
  void (async () => {
    const pumps = new Set<Promise<void>>();
    const actionPumps = new Map<string, Set<Promise<void>>>();
    let heartbeatPending = false;
    const heartbeat = setInterval(() => {
      if (heartbeatPending || cancelled) return;
      heartbeatPending = true;
      void writePart((cursor) =>
        part(
          boundary,
          "output",
          encoder.encode(JSON.stringify({ type: "observation.heartbeat" })),
          { cursor },
        )
      )
        .catch(detach).finally(() => {
          heartbeatPending = false;
        });
    }, 15_000);
    try {
      for await (const output of source.outputs) {
        if (isTerminalOperationOutput(output)) await Promise.all(pumps);
        else if (!isStream(output)) {
          await Promise.all(
            outputActionRuns(output).flatMap(
              (id) => [...(actionPumps.get(id) ?? [])],
            ),
          );
        }
        const outputRecord = output as unknown as Record<string, unknown>;
        const operationId = typeof outputRecord.operationId === "string" &&
            outputRecord.operationId.trim()
          ? outputRecord.operationId.trim()
          : source.operationId;
        const mutations: OperationReplayCursorMutation[] = [];
        if (
          "durable" in output && output.durable === true &&
          typeof output.position === "string"
        ) {
          if (source.compositeCursor && operationId) {
            mutations.push({
              kind: "event",
              operationId,
              position: output.position,
            });
          } else {
            mutations.push({ kind: "event", position: output.position });
            if (operationId) {
              mutations.push({
                kind: "event",
                operationId,
                position: output.position,
              });
            }
          }
        }
        let streamOffset: number | undefined;
        if (isStream(output)) {
          const position = cursorTracker.streamPosition({
            operationId: operationId!,
            streamOrdinal: output.streamOrdinal!,
          });
          if (position.consumed) {
            await output.payload.cancel("operation_stream_already_consumed")
              .catch(() => undefined);
            continue;
          }
          streamOffset = position.offset;
          if (operationId && output.streamOrdinal) {
            mutations.push({
              kind: "operation-stream",
              action: "register",
              operationId,
              streamOrdinal: output.streamOrdinal,
              offset: streamOffset,
            });
          }
        }
        await writePart(
          (replayCursor) =>
            part(
              boundary,
              "output",
              encoder.encode(JSON.stringify(descriptor(output))),
              { cursor: replayCursor },
            ),
          mutations,
        );
        if (isStream(output)) {
          const pending = pump(output, operationId, streamOffset ?? 0);
          pumps.add(pending);
          const actionRunId = output.metadata.sourceActionRunId;
          const ledger = typeof actionRunId === "string"
            ? actionPumps.get(actionRunId) ?? new Set<Promise<void>>()
            : undefined;
          if (ledger && typeof actionRunId === "string") {
            actionPumps.set(actionRunId, ledger);
            ledger.add(pending);
          }
          void pending.then(() => {
            pumps.delete(pending);
            ledger?.delete(pending);
            if (ledger?.size === 0 && typeof actionRunId === "string") {
              actionPumps.delete(actionRunId);
            }
          }, detach);
        }
      }
      await Promise.all(pumps);
      await source.done;
      await serializeFrame(() => write(encoder.encode(`--${boundary}--\r\n`)));
      await writer.close();
    } catch (error) {
      if (isReplayCapacityError(error)) {
        await writePart((replayCursor) =>
          part(
            boundary,
            "output",
            encoder.encode(JSON.stringify(Object.freeze({
              type: "replay.capacity",
              code: "operation_replay_capacity_exceeded",
              ...(source.operationId
                ? { operationId: source.operationId }
                : {}),
              ...(source.threadId ? { threadId: source.threadId } : {}),
            }))),
            { cursor: replayCursor },
          )
        ).catch(() => undefined);
        cancelled = true;
        await Promise.allSettled([
          source.cancel("operation_replay_capacity_exceeded"),
          ...[...readers].map((reader) =>
            reader.cancel("observation_capacity")
          ),
        ]);
        await Promise.allSettled(pumps);
        await serializeFrame(() => write(encoder.encode(`--${boundary}--\r\n`)))
          .catch(() => undefined);
        await writer.close().catch(() => undefined);
        return;
      }
      await source.cancel(
        error instanceof Error ? error.message : "multipart_failed",
      ).catch(() => undefined);
      await writer.abort(error).catch(() => undefined);
    } finally {
      clearInterval(heartbeat);
      options.signal?.removeEventListener("abort", abort);
    }
  })();
  const headers = new Headers(options.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", `multipart/mixed; boundary=${boundary}`);
  return new Response(transport.readable, { status: 200, headers });
}
