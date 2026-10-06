import { assertEquals } from "@std/assert";
import { resolveCoreObservationKeys } from "./index.ts";

Deno.test("Core's legacy catalog resolver preserves opaque keys and interprets only owned metadata", () => {
  assertEquals(
    resolveCoreObservationKeys({
      metadata: {
        observationKeys: ["another:key"],
        core: { threadId: "thread" },
      },
      operationMetadata: { operationMetadata: { threadId: "root-thread" } },
    }),
    ["another:key", "core.thread:thread", "core.thread:root-thread"],
  );
  assertEquals(
    resolveCoreObservationKeys({
      metadata: {
        threadId: "foreign",
        core: { operationMetadata: { threadId: "foreign" } },
        operationMetadata: { core: { threadId: "foreign" } },
      },
    }),
    [],
  );
});
