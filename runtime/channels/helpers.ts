import type {
  AttachmentOutput,
  AttachmentStreamOutput,
} from "../attachments/index.ts";
import type { ResolvedContent } from "../content/index.ts";
import type { ConversationMessage } from "../domain/index.ts";
import { loadChannelMessage } from "./identity.ts";
import type { ChannelEgressContext } from "./types.ts";

export function channelMetadata(
  metadata: Readonly<Record<string, unknown>>,
  channelId: string,
): Readonly<Record<string, unknown>> | null {
  const channels = metadata.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return null;
  }
  const value = (channels as Record<string, unknown>)[channelId];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

export function isAttachmentStreamOutput(
  output: AttachmentOutput,
): output is AttachmentStreamOutput {
  const payload = (output as { payload?: unknown }).payload;
  return output.type === "stream.output" && Boolean(payload) &&
    typeof (payload as { getReader?: unknown }).getReader === "function";
}

export async function collectByteStream(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
  cancellationReason = "channel_output_too_large",
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("Channel stream byte limit must be positive.");
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!(item.value instanceof Uint8Array)) {
        throw new TypeError("Channel output stream must contain byte chunks.");
      }
      length += item.value.byteLength;
      if (length > maxBytes) {
        await reader.cancel(cancellationReason);
        throw new RangeError(
          `Channel output stream exceeds ${maxBytes} bytes.`,
        );
      }
      chunks.push(item.value.slice());
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export type ResolvedAgentMessage = Readonly<{
  message: ConversationMessage;
  content: readonly ResolvedContent[];
}>;

export async function resolveAgentMessageOutput(
  context: ChannelEgressContext,
  output: AttachmentOutput,
): Promise<ResolvedAgentMessage | null> {
  if (
    isAttachmentStreamOutput(output) || !("durable" in output) ||
    !output.durable || output.type !== "message.created"
  ) return null;
  const payload = output.payload && typeof output.payload === "object"
    ? output.payload as Record<string, unknown>
    : undefined;
  const messageId = output.subject?.type === "message"
    ? output.subject.id
    : typeof payload?.messageId === "string"
    ? payload.messageId
    : "";
  if (!messageId) return null;
  const message = await loadChannelMessage(
    context.application,
    context.namespace,
    messageId,
  );
  if (!message || message.sender.participantType !== "agent") return null;
  return Object.freeze({
    message,
    content: await context.application.content.resolver.getMany(
      message.content,
      { namespace: context.namespace },
    ),
  });
}

export function requestHeader(
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined {
  const normalized = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === normalized) return value;
  }
  return undefined;
}

export function timingSafeTextEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

export function outboundText(content: ResolvedContent): string | null {
  if (content.ref.kind === "text") return content.text?.trim() || null;
  if (content.ref.kind === "json") {
    return (content.text ?? JSON.stringify(content.value))?.trim() || null;
  }
  return null;
}
