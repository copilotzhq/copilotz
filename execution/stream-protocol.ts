import type { CopilotzEvent } from "@/events/types.ts";

export type StreamWireHeader =
  | { kind: "event"; event: CopilotzEvent }
  | {
    kind: "stream_start";
    streamId: string;
    participant: { id: string; name?: string; type: string };
    mediaType: string;
    threadId: string;
    namespace: string;
    causationId?: string;
    correlationId: string;
  }
  | { kind: "stream_chunk"; streamId: string }
  | { kind: "stream_end"; streamId: string }
  | { kind: "settled"; streamId: string }
  | { kind: "error"; streamId: string; message: string; name?: string };

const encoder = new TextEncoder();

export function encodeStreamFrame(
  header: StreamWireHeader,
  payload: Uint8Array<ArrayBufferLike> = new Uint8Array(),
): Uint8Array {
  const headerBytes = encoder.encode(JSON.stringify(header));
  const frame = new Uint8Array(8 + headerBytes.byteLength + payload.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, headerBytes.byteLength, false);
  frame.set(headerBytes, 4);
  view.setUint32(4 + headerBytes.byteLength, payload.byteLength, false);
  frame.set(payload, 8 + headerBytes.byteLength);
  return frame;
}

function concat(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBufferLike> {
  if (!left.byteLength) return right.slice();
  const result = new Uint8Array(left.byteLength + right.byteLength);
  result.set(left);
  result.set(right, left.byteLength);
  return result;
}

export async function* decodeStreamFrames(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<{ header: StreamWireHeader; payload: Uint8Array }> {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array();
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    pending = concat(pending, chunk);
    while (pending.byteLength >= 8) {
      const view = new DataView(
        pending.buffer,
        pending.byteOffset,
        pending.byteLength,
      );
      const headerLength = view.getUint32(0, false);
      if (pending.byteLength < 8 + headerLength) break;
      const payloadLength = view.getUint32(4 + headerLength, false);
      const total = 8 + headerLength + payloadLength;
      if (pending.byteLength < total) break;
      const header = JSON.parse(
        decoder.decode(pending.subarray(4, 4 + headerLength)),
      ) as StreamWireHeader;
      const payload = pending.slice(8 + headerLength, total);
      pending = pending.slice(total);
      yield { header, payload };
    }
  }
  if (pending.byteLength) {
    throw new TypeError("Truncated Copilotz stream frame.");
  }
}
