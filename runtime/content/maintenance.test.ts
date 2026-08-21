import { assertEquals } from "@std/assert";

import { createMemoryBodyStore } from "./body-store.ts";
import { maintainProgressiveBodies } from "./maintenance.ts";

Deno.test("progressive body maintenance fences and aborts expired writers without semantic lookup", async () => {
  const store = createMemoryBodyStore({ protectionMs: 0 });
  const writer = await store.reserve({
    bodyId: "content-streams/tenant-a/stream-a",
    mediaType: "text/plain",
  });
  await store.append({
    writer,
    expectedOffset: 0,
    appendId: "first",
    bytes: new TextEncoder().encode("partial"),
  });

  const result = await maintainProgressiveBodies(store);

  assertEquals(result, {
    examined: 1,
    aborted: 1,
    deferred: 0,
    errors: [],
  });
  assertEquals(await store.head({ bodyId: writer.bodyId }), null);
});
