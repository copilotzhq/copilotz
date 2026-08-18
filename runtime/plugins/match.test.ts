import { assert, assertEquals } from "@std/assert";

import { defineProcessor } from "./processor.ts";
import { matchProcessor, matchesPartial } from "./match.ts";

const envelope = {
  type: "stream.created",
  namespace: "tenant-a",
  threadId: "thread-a",
  subject: { type: "stream", id: "stream-a" },
  payload: { dataRef: { assetId: "body-a" } },
  routing: { senderId: "user-a", recipientIds: ["agent-a"] },
  visibility: { kind: "public" as const },
  metadata: { copilotzWorkflow: { kind: "agent_output" } },
};

Deno.test("matcher entries are OR and fields in one entry are AND", () => {
  const processor = defineProcessor({
    id: "core.or-and",
    on: [
      { eventType: "message.created", routing: { senderId: "user-a" } },
      {
        eventType: "stream.created",
        data: { record: { lane: "content", mediaType: "audio/*" } },
      },
    ],
    handle() {},
  });
  assertEquals(matchProcessor(processor, envelope, {
    record: { lane: "content", mediaType: "audio/pcm" },
  }), true);
  assertEquals(matchProcessor(processor, {
    ...envelope,
    type: "message.created",
  }), true);
  assertEquals(matchProcessor(processor, {
    ...envelope,
    type: "message.created",
    routing: { senderId: "other" },
  }), false);
  assertEquals(matchProcessor(processor, envelope, {
    record: { lane: "progress", mediaType: "audio/pcm" },
  }), false);
});

Deno.test("nested objects use partial equality and media wildcards", () => {
  assert(matchesPartial({ lane: "content" }, {
    lane: "content",
    mediaType: "audio/pcm",
  }));
  assert(matchesPartial({ mediaType: "audio/*" }, { mediaType: "audio/pcm" }));
  assertEquals(
    matchesPartial({ mediaType: "audio/pcm" }, { mediaType: "audio/wav" }),
    false,
  );
  assertEquals(matchesPartial({ lane: "content" }, { lane: "progress" }), false);
});

Deno.test("matching ignores dataRef-only payloads unless match data is provided", () => {
  const processor = defineProcessor({
    id: "core.body",
    on: [{
      eventType: "stream.created",
      data: { record: { lane: "content" } },
    }],
    handle() {},
  });
  assertEquals(matchProcessor(processor, envelope), false);
  assertEquals(
    matchProcessor(processor, envelope, { record: { lane: "content" } }),
    true,
  );
});
