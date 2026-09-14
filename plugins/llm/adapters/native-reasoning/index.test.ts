import { assertEquals } from "@std/assert";

import type { ChatMessage, ProviderConfig } from "../../internal/types.ts";
import {
  createAnthropicNativeReasoningExtractor,
  matchingNativeBlocks,
} from "./index.ts";

Deno.test("native reasoning matches only exact adapter, API, and model", () => {
  const message: ChatMessage = {
    role: "assistant",
    content: "answer",
    nativeReasoning: {
      schema: "copilotz.llm-native-reasoning.v1",
      adapter: "anthropic",
      api: "anthropic.messages",
      model: "claude-test",
      blocks: [{ type: "thinking", thinking: "private", signature: "sig" }],
    },
  };
  const config: ProviderConfig = {
    provider: "anthropic",
    model: "claude-test",
  };

  assertEquals(
    matchingNativeBlocks(
      message,
      config,
      "anthropic",
      "anthropic.messages",
      "claude-test",
    ),
    [{ type: "thinking", thinking: "private", signature: "sig" }],
  );
  assertEquals(
    matchingNativeBlocks(
      message,
      config,
      "anthropic",
      "anthropic.messages",
      "claude-other",
    ),
    null,
  );
});

Deno.test("Anthropic native reasoning finalizes complete thinking and redacted blocks", () => {
  const extract = createAnthropicNativeReasoningExtractor();

  assertEquals(
    extract({
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    }),
    null,
  );
  assertEquals(
    extract({
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "one" },
    }),
    null,
  );
  assertEquals(
    extract({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "sig-" },
    }),
    null,
  );
  assertEquals(
    extract({
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "one" },
    }),
    null,
  );
  assertEquals(extract({ type: "content_block_stop", index: 0 }), null);
  assertEquals(
    extract({
      type: "content_block_start",
      index: 1,
      content_block: { type: "redacted_thinking", data: "ciphertext" },
    }),
    null,
  );
  assertEquals(extract({ type: "content_block_stop", index: 1 }), null);
  assertEquals(
    extract({
      type: "content_block_start",
      index: 2,
      content_block: { type: "thinking", thinking: "no-initial-signature" },
    }),
    null,
  );
  assertEquals(
    extract({
      type: "content_block_delta",
      index: 2,
      delta: { type: "signature_delta", signature: "sig-two" },
    }),
    null,
  );
  assertEquals(extract({ type: "content_block_stop", index: 2 }), null);
  assertEquals(
    extract({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
    }),
    null,
  );
  assertEquals(extract({ type: "message_stop" }), [
    { type: "thinking", thinking: "one", signature: "sig-one" },
    { type: "redacted_thinking", data: "ciphertext" },
    {
      type: "thinking",
      thinking: "no-initial-signature",
      signature: "sig-two",
    },
  ]);
});
