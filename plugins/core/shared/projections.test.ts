import { assertEquals, assertThrows } from "@std/assert";
import { mapMessageRecord } from "./projections.ts";
import type { ContentSequence } from "@copilotz/copilotz/content";
import type { ConversationMessage, Participant } from "./contracts.ts";

const sender: Participant = {
  id: "north",
  namespace: "tenant",
  externalId: "north",
  participantType: "agent",
  metadata: {},
  createdAt: "2026-09-06",
  updatedAt: "2026-09-06",
};
const base = {
  id: "message",
  namespace: "tenant",
  threadId: "thread",
  senderId: "north",
  recipientIds: [],
  createdAt: "2026-09-06",
  updatedAt: "2026-09-06",
};
const ref = {
  assetId: "text",
  kind: "text",
  role: "body",
  mediaType: "text/plain",
} as const;

Deno.test("message projection preserves resolved values, binary bytes, descriptors and reasoning types", () => {
  const content = [
    { ...ref, value: "hello" },
    {
      assetId: "binary",
      kind: "file",
      role: "attachment",
      mediaType: "application/octet-stream",
      value: new Uint8Array([0, 255]),
    },
    { ...ref, assetId: "unloaded", resolve: false },
  ] as const;
  const metadata = {
    llmReasoning: [{ ...ref, role: "reasoning", value: "reason" }] as const,
    llmNativeReasoning: {
      schema: "copilotz.llm-native-reasoning.v1",
      adapter: "custom",
      api: "custom.api",
      model: "model",
      blocks: [{
        ...ref,
        kind: "json" as const,
        mediaType: "application/json",
        value: { opaque: "state" },
      }],
    },
  };
  const message = mapMessageRecord({ ...base, content, metadata }, sender);
  // These assignments also enforce the public inferred types during deno check.
  const text: string = message.content[0].value;
  const binary: Uint8Array = message.content[1].value;
  const descriptor: false = message.content[2].resolve;
  const reasoning: string = message.metadata.llmReasoning[0].value;
  const native = message.metadata.llmNativeReasoning.blocks[0].value;
  assertEquals(text, "hello");
  assertEquals(binary, new Uint8Array([0, 255]));
  assertEquals(descriptor, false);
  assertEquals(reasoning, "reason");
  assertEquals(native, { opaque: "state" });
  assertEquals(message.content, content);
});

Deno.test("ordinary message projection remains reference-based and rejects invalid content metadata", () => {
  const message: ConversationMessage = mapMessageRecord({
    ...base,
    content: [ref],
    metadata: {},
  }, sender);
  const content: ContentSequence = message.content;
  assertEquals(content, [ref]);
  // @ts-expect-error Ordinary history does not promise resolved values.
  assertEquals(message.content[0].value, undefined);
  assertThrows(
    () =>
      mapMessageRecord({
        ...base,
        content: [{ ...ref, kind: "invalid" }],
        metadata: {},
      }, sender),
    TypeError,
  );
});
