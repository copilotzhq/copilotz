import { assertEquals, assertRejects } from "@std/assert";
import { createHttpReads } from "./reads.ts";
import type { InternalCopilotzApplication } from "../runtime/application/types.ts";
import { defineCollection } from "../runtime/collections/definition.ts";

Deno.test("HTTP owner projection queries cannot fall through to raw Collection rows", async () => {
  let rawReads = 0;
  const entry = defineCollection({
    name: "entry",
    ownerPolicy: "required",
    schema: { type: "object", properties: { secret: { type: "string" } } },
    queries: {
      projected: {
        ownerProjection: true,
        inputSchema: { type: "object" },
        outputSchema: { type: "array" },
      },
    },
  });
  const application = {
    config: { namespace: "space" },
    plugins: { collections: { entry } },
    collections: {
      withScope: () => ({
        entry: {
          list() {
            rawReads++;
            return Promise.resolve([{ secret: "private" }]);
          },
        },
      }),
    },
  } as unknown as InternalCopilotzApplication;
  const read = await createHttpReads(application, { namespace: "space" });
  const error = await assertRejects(() => read.query("entry", "projected", {}));
  assertEquals((error as { code: string }).code, "query_not_found");
  assertEquals(rawReads, 0);
});
