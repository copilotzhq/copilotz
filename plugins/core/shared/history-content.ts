import {
  decodeContent,
  encodeContent,
  isContentRef,
} from "@copilotz/copilotz/content/codec";
import type {
  ContentJsonValue,
  ContentRef,
} from "@copilotz/copilotz/content/codec";
import type { ConversationMessage } from "./contracts.ts";

export type ResolvedMessageContent =
  & ContentRef
  & (
    | { kind: "text"; value: string }
    | { kind: "json"; value: ContentJsonValue }
    | { kind: Exclude<ContentRef["kind"], "text" | "json">; value: Uint8Array }
  );
export type ResolvedConversationMessage = ConversationMessage<
  readonly ResolvedMessageContent[]
>;

/** JSON history keeps values inline; media uses the runtime's canonical media codec. */
export function mapHistoryContent(
  message: Record<string, unknown>,
  direction: "encode" | "decode",
): Record<string, unknown> {
  const map = (entries: unknown) => {
    if (!Array.isArray(entries)) {
      throw new TypeError("Invalid resolved message content.");
    }
    return entries.map((entry) => {
      if (!isContentRef(entry) || !Object.hasOwn(entry, "value")) {
        throw new TypeError("History requires resolved content.");
      }
      const value = (entry as ResolvedMessageContent).value;
      if (entry.kind === "text") {
        if (typeof value !== "string") {
          throw new TypeError("Invalid resolved text.");
        }
        return entry;
      }
      if (entry.kind === "json") {
        decodeContent({ type: "json", value });
        return entry;
      }
      if (direction === "encode") {
        if (!(value instanceof Uint8Array)) {
          throw new TypeError("Invalid resolved media.");
        }
        return {
          ...entry,
          value: encodeContent({
            type: entry.kind,
            mediaType: entry.mediaType,
            bytes: value,
          }),
        };
      }
      const decoded = decodeContent(value);
      if (
        !decoded || typeof decoded !== "object" || !("bytes" in decoded) ||
        !(decoded.bytes instanceof Uint8Array)
      ) {
        throw new TypeError("Invalid history media.");
      }
      return { ...entry, value: decoded.bytes };
    });
  };
  const metadata = message.metadata as Record<string, unknown>;
  const nativeReasoning = metadata.llmNativeReasoning;
  const nativeBlocks = nativeReasoning && typeof nativeReasoning === "object" &&
      !Array.isArray(nativeReasoning) &&
      Array.isArray((nativeReasoning as Record<string, unknown>).blocks)
    ? nativeReasoning as Record<string, unknown>
    : undefined;
  return {
    ...message,
    content: map(message.content),
    metadata: {
      ...metadata,
      ...(metadata.llmReasoning === undefined
        ? {}
        : { llmReasoning: map(metadata.llmReasoning) }),
      ...(nativeBlocks === undefined ? {} : {
        llmNativeReasoning: {
          ...nativeBlocks,
          blocks: map(nativeBlocks.blocks),
        },
      }),
    },
  };
}
