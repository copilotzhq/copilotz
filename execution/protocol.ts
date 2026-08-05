import type { CopilotzEvent } from "@/events/types.ts";

export const COPILOTZ_DELIVERY_WORKLOAD = "copilotz.delivery.v1" as const;
export const COPILOTZ_STREAM_WORKLOAD = "copilotz.stream.v1" as const;

export interface DeliveryWorkRequest {
  protocol: typeof COPILOTZ_DELIVERY_WORKLOAD;
  deliveryId: string;
  eventId: string;
  consumerId: string;
  namespace: string;
  correlationId: string;
}

export type DeliveryOutputFrame =
  | { kind: "event"; event: CopilotzEvent }
  | {
    kind: "settled";
    deliveryId: string;
    outcome: "succeeded" | "retry_wait" | "dead_letter" | "not_claimed";
  };

const encoder = new TextEncoder();

export function encodeJsonLine(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`);
}

export async function readAllBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function* decodeJsonLines<T>(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<T> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (line.trim()) yield JSON.parse(line) as T;
    }
  }
  pending += decoder.decode();
  if (pending.trim()) yield JSON.parse(pending) as T;
}
