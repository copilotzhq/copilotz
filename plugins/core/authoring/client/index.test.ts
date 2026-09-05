import { assertEquals, assertRejects } from "@std/assert";
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
