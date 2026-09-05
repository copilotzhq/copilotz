/** Browser-safe, backpressured decoding of canonical multipart frames. @module */

export type OutputDescriptor = Readonly<
  Record<string, unknown> & { type: string }
>;
export type ObservationFrame =
  | Readonly<{ kind: "output"; output: OutputDescriptor; checkpoint: string }>
  | Readonly<{
    kind: "stream-chunk";
    streamId: string;
    offset: number;
    bytes: Uint8Array;
    checkpoint: string;
  }>
  | Readonly<{
    kind: "stream-end" | "stream-error";
    streamId: string;
    offset: number;
    terminal: Readonly<Record<string, unknown>>;
    checkpoint: string;
  }>;

export class ProtocolError extends Error {
  override name = "ProtocolError";
}

export class TruncatedObservationError extends ProtocolError {
  override name = "TruncatedObservationError";
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_HEADERS = 32 * 1024;
export const MAX_FRAME_BYTES = 1024 * 1024;

function object(bytes: Uint8Array): Record<string, unknown> {
  const value = JSON.parse(decoder.decode(bytes));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolError("Frame must contain a JSON object.");
  }
  return value;
}

/** Yielding suspends parsing; the consumer controls when the next frame is read. */
export async function* decodeObservation(
  response: Response,
): AsyncGenerator<ObservationFrame> {
  const match = /^multipart\/mixed\s*;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))$/i
    .exec(response.headers.get("content-type") ?? "");
  const boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 70 || !response.body) {
    throw new ProtocolError("Expected a multipart response with a body.");
  }
  const reader = response.body.getReader();
  let buffer: Uint8Array = new Uint8Array();
  let complete = false;
  const fill = async (size: number) => {
    while (buffer.length < size) {
      const next = await reader.read();
      if (next.done) {
        throw new TruncatedObservationError(
          "Multipart response was truncated.",
        );
      }
      const joined = new Uint8Array(buffer.length + next.value.length);
      joined.set(buffer);
      joined.set(next.value, buffer.length);
      buffer = joined;
    }
  };
  const line = async () => {
    let index = 0;
    while (true) {
      await fill(index + 2);
      if (buffer[index] === 13 && buffer[index + 1] === 10) {
        const value = decoder.decode(buffer.subarray(0, index));
        buffer = buffer.subarray(index + 2);
        return value;
      }
      if (++index > MAX_HEADERS) {
        throw new ProtocolError("Header is too large.");
      }
    }
  };
  const streams = new Map<string, number | undefined>();
  try {
    let marker = await line();
    while (marker !== `--${boundary}--`) {
      if (marker !== `--${boundary}`) {
        throw new ProtocolError("Invalid boundary.");
      }
      const headers = new Headers();
      let headerBytes = 0;
      for (let value = await line(); value; value = await line()) {
        headerBytes += encoder.encode(value).length + 2;
        if (headerBytes > MAX_HEADERS) {
          throw new ProtocolError("Headers are too large.");
        }
        const separator = value.indexOf(":");
        const name = value.slice(0, separator).trim();
        if (separator < 1 || headers.has(name)) {
          throw new ProtocolError("Invalid header.");
        }
        headers.set(name, value.slice(separator + 1).trim());
      }
      const rawLength = headers.get("content-length") ?? "";
      const length = Number(rawLength);
      if (!/^(0|[1-9][0-9]*)$/.test(rawLength) || length > MAX_FRAME_BYTES) {
        throw new ProtocolError("Frame length is invalid or exceeds capacity.");
      }
      await fill(length + 2);
      if (buffer[length] !== 13 || buffer[length + 1] !== 10) {
        throw new ProtocolError("Invalid frame terminator.");
      }
      const bytes = buffer.slice(0, length);
      buffer = buffer.subarray(length + 2);
      const checkpoint = headers.get("x-copilotz-cursor");
      if (!checkpoint) throw new ProtocolError("Frame has no checkpoint.");
      const kind = headers.get("x-copilotz-frame");
      if (kind === "output") {
        const output = object(bytes);
        if (typeof output.type !== "string") {
          throw new ProtocolError("Invalid output.");
        }
        if (output.type === "stream.output") {
          const id = output.streamId;
          if (typeof id !== "string" || !id || streams.has(id)) {
            throw new ProtocolError("Invalid stream descriptor.");
          }
          if (streams.size >= 256) {
            throw new ProtocolError("Stream capacity exceeded.");
          }
          // A resumed stream starts at its first transmitted byte offset.
          streams.set(id, undefined);
        }
        yield { kind, output: output as OutputDescriptor, checkpoint };
      } else {
        const streamId = headers.get("x-copilotz-stream-id") ?? "";
        const rawOffset = headers.get("x-copilotz-offset") ?? "";
        const offset = Number(rawOffset);
        if (
          !streams.has(streamId) || !/^(0|[1-9][0-9]*)$/.test(rawOffset) ||
          !Number.isSafeInteger(offset)
        ) throw new ProtocolError("Invalid stream lane.");
        const expected = streams.get(streamId);
        if (kind === "stream-chunk") {
          if (expected !== undefined && expected !== offset) {
            throw new ProtocolError("Stream bytes arrived out of order.");
          }
          streams.set(streamId, offset + bytes.length);
          yield { kind, streamId, offset, bytes, checkpoint };
        } else if (kind === "stream-end" || kind === "stream-error") {
          const terminal = object(bytes);
          if (
            terminal.offset !== offset ||
            !["completed", "failed", "cancelled", "superseded", "abandoned"]
              .includes(String(terminal.outcome)) ||
            !["retained", "purge_pending", "purged", "missing"].includes(
              String(terminal.availability),
            ) ||
            !["complete", "truncated"].includes(String(terminal.capture)) ||
            typeof terminal.terminalAt !== "string" ||
            !Number.isFinite(Date.parse(terminal.terminalAt)) ||
            (kind === "stream-end" && (terminal.outcome !== "completed" ||
              terminal.capture !== "complete" ||
              (expected !== undefined && offset !== expected)))
          ) {
            throw new ProtocolError("Invalid stream terminal.");
          }
          streams.delete(streamId);
          yield { kind, streamId, offset, terminal, checkpoint };
        } else throw new ProtocolError("Unknown frame kind.");
      }
      marker = await line();
    }
    if (streams.size) {
      throw new ProtocolError("Response closed with unfinished streams.");
    }
    complete = true;
  } finally {
    if (!complete) {
      await reader.cancel("observation_detached").catch(() => undefined);
    }
    reader.releaseLock();
  }
}
