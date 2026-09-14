/** Shared helpers for bounded provider-native reasoning state. @module */

import type { ChatMessage, ProviderConfig } from "../../internal/types.ts";

export type NativeReasoningBlock = Record<string, unknown>;

export const NATIVE_REASONING_SCHEMA =
  "copilotz.llm-native-reasoning.v1" as const;

export function isRecord(value: unknown): value is NativeReasoningBlock {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function cloneBlock(block: NativeReasoningBlock): NativeReasoningBlock {
  return structuredClone(block);
}

/**
 * Native state is only usable when it was produced by this exact adapter/API
 * and model.  This guard deliberately requires assistant history and does not
 * copy arbitrary fields from an untrusted message into a provider request.
 */
export function matchingNativeBlocks(
  message: ChatMessage,
  config: ProviderConfig,
  adapter: string,
  api: string,
  model: string,
): NativeReasoningBlock[] | null {
  if (message.role !== "assistant") return null;
  const native = message.nativeReasoning;
  if (!native || native.schema !== NATIVE_REASONING_SCHEMA) return null;
  if (
    native.adapter !== adapter || native.api !== api || native.model !== model
  ) {
    return null;
  }
  // The concrete adapter is the authority when this helper is called directly
  // in a provider test or custom transport wrapper, where `provider` may be
  // omitted from the otherwise valid config. Runtime calls always set it.
  if (config.provider !== undefined && config.provider !== adapter) return null;
  if (!Array.isArray(native.blocks)) return null;
  const blocks = native.blocks.filter(isRecord).map(cloneBlock);
  return blocks.length > 0 ? blocks : null;
}

export function stringField(
  value: NativeReasoningBlock | null | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === "string" ? field : undefined;
}

type AnthropicNativeState = {
  blocksByIndex: Map<number, { block: NativeReasoningBlock; closed: boolean }>;
  order: number[];
  stopReason?: string;
};

/**
 * Captures Anthropic Messages-compatible thinking blocks. The returned
 * callback deliberately yields nothing until `message_stop` confirms a normal
 * `end_turn`/`stop_sequence` completion; the shared stream consumer can then
 * safely replace its snapshot while it drains a locally stopped transport.
 */
export function createAnthropicNativeReasoningExtractor(): (
  data: unknown,
) => NativeReasoningBlock[] | null {
  const state: AnthropicNativeState = {
    blocksByIndex: new Map(),
    order: [],
  };

  return (data: unknown): NativeReasoningBlock[] | null => {
    if (!isRecord(data)) return null;
    const type = stringField(data, "type");

    if (type === "content_block_start") {
      const index = data.index;
      const block = isRecord(data.content_block) ? data.content_block : null;
      if (
        typeof index !== "number" || !Number.isInteger(index) || !block ||
        (block.type !== "thinking" && block.type !== "redacted_thinking")
      ) return null;
      if (!state.blocksByIndex.has(index)) state.order.push(index);
      state.blocksByIndex.set(index, {
        block: cloneBlock(block),
        closed: false,
      });
      return null;
    }

    if (type === "content_block_delta") {
      const index = data.index;
      const tracked = typeof index === "number"
        ? state.blocksByIndex.get(index)
        : undefined;
      const delta = isRecord(data.delta) ? data.delta : null;
      if (!tracked || !delta) return null;
      const deltaType = stringField(delta, "type");
      if (deltaType === "thinking_delta") {
        const thinking = stringField(delta, "thinking");
        if (thinking !== undefined) {
          tracked.block.thinking =
            (stringField(tracked.block, "thinking") ?? "") + thinking;
        }
      } else if (deltaType === "signature_delta") {
        const signature = stringField(delta, "signature");
        if (signature !== undefined) {
          tracked.block.signature =
            (stringField(tracked.block, "signature") ?? "") + signature;
        }
      }
      return null;
    }

    if (type === "content_block_stop") {
      const index = data.index;
      const tracked = typeof index === "number"
        ? state.blocksByIndex.get(index)
        : undefined;
      if (tracked) tracked.closed = true;
      return null;
    }

    if (type === "message_delta") {
      const delta = isRecord(data.delta) ? data.delta : null;
      const stopReason = stringField(delta, "stop_reason");
      if (stopReason) state.stopReason = stopReason;
      return null;
    }

    if (
      type !== "message_stop" ||
      (state.stopReason !== "end_turn" && state.stopReason !== "stop_sequence")
    ) return null;

    const trackedBlocks = state.order.map((index) =>
      state.blocksByIndex.get(index)
    );
    if (trackedBlocks.some((tracked) => !tracked?.closed)) return null;
    const blocks = trackedBlocks.flatMap((tracked) => {
      return tracked ? [cloneBlock(tracked.block)] : [];
    });
    return blocks.length > 0 ? blocks : null;
  };
}
