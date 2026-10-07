import { assertEquals } from "@std/assert";
import { formatLlmRequestForWire } from "@copilotz/copilotz/llm";
import {
  historyBoundaryAdvances,
  sourceMessagesFromTranscript,
} from "./source.ts";

Deno.test("memory progress follows chronological message order rather than opaque IDs", async () => {
  let reads = 0;
  const context = {
    collections: {
      message: {
        get: ({ id }: { id: string }) => {
          reads++;
          return Promise.resolve({
            id,
            threadId: "thread",
            createdAt: id === "a-later"
              ? "2026-10-02T00:00:00Z"
              : "2026-10-01T00:00:00Z",
          });
        },
      },
    },
  };
  assertEquals(
    await historyBoundaryAdvances(context as never, "thread", "same", "same"),
    false,
  );
  assertEquals(reads, 0);
  assertEquals(
    await historyBoundaryAdvances(
      context as never,
      "thread",
      "a-later",
      "z-earlier",
    ),
    true,
  );
  assertEquals(
    await historyBoundaryAdvances(
      context as never,
      "thread",
      "z-earlier",
      "a-later",
    ),
    false,
  );
});

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
