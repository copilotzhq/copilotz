import { assertEquals } from "@std/assert";
import { searchMemoryAction } from "./index.ts";

Deno.test("no readable memory space returns before embedding or vector queries", async () => {
  let calls = 0;
  const result = await searchMemoryAction.execute({ query: "secret" }, {
    action: { metadata: { threadId: "thread", agentId: "agent" } },
    collections: {
      memorySpaceAccess: { list: () => Promise.resolve([]) },
      thread: { get: () => Promise.resolve({ id: "thread" }) },
    },
    adapters: {
      memoryEmbedding: {
        default: () => {
          calls++;
          throw new Error("must not embed");
        },
      },
    },
    vectors: {
      search: () => {
        calls++;
        throw new Error("must not search");
      },
    },
  } as never);
  assertEquals(result, { notes: [], returned: 0, truncated: false });
  assertEquals(calls, 0);
});
