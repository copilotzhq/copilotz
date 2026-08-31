/** Lossless multipart transport for request-scoped Application outputs. @module */

import type {
  ApplicationOutput,
  StreamOutput,
} from "@copilotz/copilotz/streams";
import type { EventNativeOutputStream } from "./event-native.ts";
import {
  createOperationReplayCursorTracker,
  decodeOperationReplayCursor,
  operationStreamReplayCursorKey,
} from "../runtime/streams/index.ts";
import type { OperationReplayCursorMutation } from "../runtime/streams/index.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
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
    replayKey: _replayKey,
    streamOrdinal: _streamOrdinal,
    ...value
  } = output;
  return value;
}

function boundedStreamError(error: unknown): Uint8Array {
  return encoder.encode(JSON.stringify({
    name: error instanceof Error && error.name ? error.name : "Error",
    message: "Progressive stream failed.",
  }));
}

function isReplayCapacityError(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code ===
    "operation_replay_capacity_exceeded";
}

/** Encodes one complete request observation without materializing raw bytes. */
export function applicationOutputsMultipartResponse(
  source: EventNativeOutputStream,
  options: Readonly<{
    headers?: HeadersInit;
    boundary?: string;
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
    const replayKey = operationStreamReplayCursorKey(output);
    let offset = initialOffset;
    const streamMutation = (
      action: "offset" | "end",
      nextOffset: number,
    ): OperationReplayCursorMutation =>
      operationId && output.streamOrdinal
        ? {
          kind: "operation-stream",
          action,
          operationId,
          streamOrdinal: output.streamOrdinal,
          offset: nextOffset,
        }
        : {
          kind: "legacy-stream",
          replayKey,
          offset: nextOffset,
        };
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const fromOffset = offset;
        const toOffset = offset + next.value.byteLength;
        await writePart(
          (replayCursor) =>
            part(boundary, "stream-chunk", next.value, {
              streamId: output.streamId,
              offset: fromOffset,
              cursor: replayCursor,
            }),
          [streamMutation("offset", toOffset)],
        );
        offset = toOffset;
      }
      await writePart(
        (replayCursor) =>
          part(
            boundary,
            "stream-end",
            encoder.encode(JSON.stringify({ offset })),
            { streamId: output.streamId, offset, cursor: replayCursor },
          ),
        operationId && output.streamOrdinal
          ? [streamMutation("end", offset)]
          : [],
      );
    } catch (error) {
      if (!cancelled) {
        console.error("[copilotz:multipart] progressive stream failed", {
          streamId: output.streamId,
          name: error instanceof Error && error.name ? error.name : "Error",
          message: error instanceof Error
            ? error.message.slice(0, 1_000)
            : "Unknown progressive stream failure.",
        });
        await writePart((replayCursor) =>
          part(boundary, "stream-error", boundedStreamError(error), {
            streamId: output.streamId,
            offset,
            cursor: replayCursor,
          })
        ).catch(() => undefined);
      }
    } finally {
      reader.releaseLock();
    }
  };
  void (async () => {
    const pumps: Promise<void>[] = [];
    try {
      for await (const output of source.outputs) {
        if (isTerminalOperationOutput(output)) await Promise.all(pumps);
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
            operationId,
            replayKey: output.replayKey,
            streamOrdinal: output.streamOrdinal,
            streamId: output.streamId,
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
          pumps.push(pump(output, operationId, streamOffset ?? 0));
        }
      }
      await Promise.all(pumps);
      await source.done;
      await serializeFrame(() => write(encoder.encode(`--${boundary}--\r\n`)));
      await writer.close();
    } catch (error) {
      cancelled = true;
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
        await source.cancel("operation_replay_capacity_exceeded").catch(() =>
          undefined
        );
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
    }
  })();
  const headers = new Headers(options.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", `multipart/mixed; boundary=${boundary}`);
  return new Response(transport.readable, { status: 200, headers });
}

function multipartBoundary(response: Response): string {
  const contentType = response.headers.get("content-type") ?? "";
  const match = contentType.match(
    /^multipart\/mixed\s*;[\s\S]*\bboundary=(?:"([^"]+)"|([^;\s]+))/i,
  );
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary) {
    throw new TypeError("Response is not Copilotz multipart output.");
  }
  return safeHeader(boundary, "Multipart boundary");
}

type ParsedPart = Readonly<{
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}>;

function indexOf(haystack: Uint8Array, needle: Uint8Array): number {
  outer:
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    for (let inner = 0; inner < needle.length; inner++) {
      if (haystack[index + inner] !== needle[inner]) continue outer;
    }
    return index;
  }
  return -1;
}

async function* parseParts(
  body: ReadableStream<Uint8Array>,
  boundary: string,
): AsyncGenerator<ParsedPart> {
  const reader = body.getReader();
  let buffer: Uint8Array = new Uint8Array();
  const append = (value: Uint8Array) => {
    buffer = bytes(buffer, value);
  };
  const fill = async (minimum = 1): Promise<boolean> => {
    while (buffer.byteLength < minimum) {
      const next = await reader.read();
      if (next.done) return false;
      append(next.value);
    }
    return true;
  };
  const line = async (): Promise<string | null> => {
    const marker = encoder.encode("\r\n");
    while (true) {
      const at = indexOf(buffer, marker);
      if (at >= 0) {
        const value = decoder.decode(buffer.slice(0, at));
        buffer = buffer.slice(at + marker.byteLength);
        return value;
      }
      const next = await reader.read();
      if (next.done) return buffer.length ? null : null;
      append(next.value);
    }
  };
  try {
    const first = await line();
    if (first !== `--${boundary}`) {
      throw new TypeError(
        "Multipart response has an invalid opening boundary.",
      );
    }
    while (true) {
      const headers: Record<string, string> = {};
      while (true) {
        const value = await line();
        if (value === null) {
          throw new TypeError("Multipart headers were truncated.");
        }
        if (value === "") break;
        const separator = value.indexOf(":");
        if (separator <= 0) throw new TypeError("Multipart header is invalid.");
        headers[value.slice(0, separator).trim().toLowerCase()] = value.slice(
          separator + 1,
        ).trim();
      }
      const length = Number(headers["content-length"]);
      if (!Number.isSafeInteger(length) || length < 0) {
        throw new TypeError("Multipart content-length is invalid.");
      }
      if (!(await fill(length + 2))) {
        throw new TypeError("Multipart body was truncated.");
      }
      const content = buffer.slice(0, length);
      if (buffer[length] !== 13 || buffer[length + 1] !== 10) {
        throw new TypeError("Multipart body terminator is invalid.");
      }
      buffer = buffer.slice(length + 2);
      yield Object.freeze({ headers: Object.freeze(headers), body: content });
      const marker = await line();
      if (marker === `--${boundary}--`) return;
      if (marker !== `--${boundary}`) {
        throw new TypeError("Multipart response has an invalid boundary.");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function json(value: Uint8Array): Record<string, unknown> {
  const parsed = JSON.parse(decoder.decode(value));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("Multipart JSON frame must contain an object.");
  }
  return parsed as Record<string, unknown>;
}

/** Decodes the canonical response back into application-facing output values. */
export function decodeCopilotzOutputs(
  response: Response,
): ReadableStream<ApplicationOutput> {
  const boundary = multipartBoundary(response);
  if (!response.body) throw new TypeError("Multipart response has no body.");
  const streams = new Map<
    string,
    WritableStreamDefaultWriter<Uint8Array>
  >();
  const body = response.body;
  return new ReadableStream<ApplicationOutput>({
    start(controller) {
      void (async () => {
        try {
          for await (const frame of parseParts(body, boundary)) {
            const kind = frame.headers[FRAME_HEADER] as FrameKind | undefined;
            if (kind === "output") {
              const value = json(frame.body);
              if (value.type === "stream.output") {
                const streamId = typeof value.streamId === "string"
                  ? value.streamId
                  : "";
                if (!streamId || streams.has(streamId)) {
                  throw new TypeError(
                    "Multipart stream descriptor is invalid.",
                  );
                }
                const stream = new TransformStream<Uint8Array, Uint8Array>(
                  undefined,
                  {
                    highWaterMark: 256 * 1024,
                    size: (chunk) => chunk.byteLength,
                  },
                  {
                    highWaterMark: 256 * 1024,
                    size: (chunk) => chunk.byteLength,
                  },
                );
                streams.set(streamId, stream.writable.getWriter());
                controller.enqueue(Object.freeze({
                  ...value,
                  payload: stream.readable,
                }) as ApplicationOutput);
              } else {
                controller.enqueue(Object.freeze(value) as ApplicationOutput);
              }
              continue;
            }
            const streamId = frame.headers[STREAM_HEADER];
            const writer = streamId ? streams.get(streamId) : undefined;
            if (!writer) {
              throw new TypeError("Multipart stream frame is orphaned.");
            }
            if (kind === "stream-chunk") {
              await writer.write(frame.body).catch(() => undefined);
            } else if (kind === "stream-end") {
              streams.delete(streamId);
              await writer.close().catch(() => undefined);
            } else if (kind === "stream-error") {
              streams.delete(streamId);
              await writer.abort(new Error("Progressive stream failed.")).catch(
                () => undefined,
              );
            } else throw new TypeError("Multipart frame kind is invalid.");
          }
          for (const writer of streams.values()) {
            await writer.abort(new Error("Progressive stream was truncated."))
              .catch(
                () => undefined,
              );
          }
          streams.clear();
          controller.close();
        } catch (error) {
          for (const writer of streams.values()) {
            await writer.abort(error).catch(() => undefined);
          }
          streams.clear();
          controller.error(error);
        }
      })();
    },
    async cancel(reason) {
      await body.cancel(reason).catch(() => undefined);
      for (const writer of streams.values()) {
        await writer.abort(reason).catch(() => undefined);
      }
      streams.clear();
    },
  }, { highWaterMark: 64 });
}
