import { assertEquals } from "@std/assert";
import { formatLlmRequestForWire } from "@copilotz/copilotz/llm";
import { sourceMessagesFromTranscript } from "./source.ts";

Deno.test("memory source estimation preserves the tenant-scoped attachment notice", () => {
  const namespace = "tenant:a";
  const model = { connection: "test", model: "gpt-6.1-sol" };
  const message = {
    role: "user" as const,
    content: [{
      kind: "file" as const,
      assetId: "voice-note",
      role: "attachment",
      name: "voice.webm",
      mediaType: "audio/webm",
      disposition: "attachment" as const,
      resolve: false as const,
    }],
  };
  const expected = formatLlmRequestForWire({ messages: [message] }, {
    provider: "openai",
    model: model.model,
  }, namespace);
  const [source] = sourceMessagesFromTranscript(
    {
      namespace,
      resources: { llmConnections: { test: { provider: "openai" } } },
    } as never,
    { messages: [], model },
    [{ sourceId: "human", message }],
  );

  assertEquals(source.id, "human");
  assertEquals(source.text.includes("asset://tenant%3Aa/voice-note"), true);
  assertEquals(source.estimatedTokens, expected.estimate.estimatedTokens);
  assertEquals(source.sourceBytes, 0);
});
