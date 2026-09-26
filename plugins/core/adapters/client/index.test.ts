import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import {
  CopilotzHttpError,
  createCopilotzClient,
} from "../../../../client/index.ts";
import { createCoreClient } from "./index.ts";
Deno.test("Core history uses one encoded canonical id and forwards cancellation without serializing it", async () => {
  const signal = new AbortController().signal;
  const core = createCoreClient(
    createCopilotzClient({
      baseUrl: "https://test/api",
      fetch: ((url, init) => {
        const parsed = new URL(String(url));
        assertEquals(
          parsed.pathname,
          "/api/threads/thread%2Fcanonical/messages",
        );
        assertEquals(JSON.parse(parsed.searchParams.get("query")!), {
          limit: 25,
          order: "desc",
          after: "cursor",
        });
        assertEquals(init?.signal, signal);
        return Promise.resolve(
          Response.json({
            data: [],
            pageInfo: { hasMore: false, checkpoint: "boundary" },
          }),
        );
      }) as typeof fetch,
    }),
  );
  assertEquals(
    await core.threads.messages("thread/canonical", {
      limit: 25,
      order: "desc",
      after: "cursor",
    }, { signal }),
    { data: [], pageInfo: { hasMore: false, checkpoint: "boundary" } },
  );
});
Deno.test("Core reads preserve structured authorization errors", async () => {
  const core = createCoreClient(
    createCopilotzClient({
      baseUrl: "https://test/api",
      fetch: (() =>
        Promise.resolve(
          Response.json(
            { error: { code: "forbidden", message: "Forbidden" } },
            { status: 403 },
          ),
        )) as typeof fetch,
    }),
  );
  const error = await assertRejects(
    () => core.threads.get("other"),
    CopilotzHttpError,
  );
  assertEquals(error.status, 403);
  assertEquals(error.code, "forbidden");
});

Deno.test("resolved history preserves text, JSON, binary and reasoning through JSON HTTP", async () => {
  const { mapHistoryContent } = await import("../../shared/history-content.ts");
  const ref = {
    assetId: "asset",
    role: "body",
    mediaType: "application/octet-stream",
  };
  const original = {
    id: "message",
    metadata: {
      llmReasoning: [{ ...ref, kind: "text", value: "Reason 🌎" }],
      llmNativeReasoning: {
        schema: "copilotz.llm-native-reasoning.v1",
        adapter: "custom",
        api: "custom.api",
        model: "model",
        blocks: [{
          ...ref,
          kind: "json",
          mediaType: "application/json",
          value: { opaque: "state" },
        }],
      },
    },
    content: [
      { ...ref, kind: "text", value: "Hello 🌎" },
      { ...ref, kind: "json", value: { answer: 42, nested: [null, true] } },
      { ...ref, kind: "file", value: new Uint8Array([0, 255, 128, 1]) },
    ],
  };
  const core = createCoreClient(createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: (() =>
      Promise.resolve(Response.json({
        data: [mapHistoryContent(original, "encode")],
        pageInfo: { hasMore: false },
      }))) as typeof fetch,
  }));
  assertEquals<unknown>(
    (await core.threads.messages("thread")).data[0],
    original,
  );
  assertThrows(() =>
    mapHistoryContent({
      ...original,
      content: [{
        ...ref,
        kind: "file",
        value: { type: "file", dataBase64: "!" },
      }],
    }, "decode"), TypeError);
});

Deno.test("Core threads.send encodes image bytes before JSON submission", async () => {
  let sent: unknown;
  const core = createCoreClient(createCopilotzClient({
    baseUrl: "https://test/api",
    fetch: (async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return Response.json({ data: { operationId: "op" } }, { status: 202 });
    }) as typeof fetch,
  }));
  await core.threads.send({
    threadId: "thread",
    content: [{
      type: "image",
      bytes: new Uint8Array([1, 2, 3]),
      mediaType: "image/png",
      role: "attachment",
      disposition: "inline",
    }],
  }, { idempotencyKey: "image" });
  assertEquals((sent as { content: unknown[] }).content[0], {
    type: "image",
    dataBase64: "AQID",
    mediaType: "image/png",
    role: "attachment",
    disposition: "inline",
  });
});
