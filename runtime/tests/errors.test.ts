/**
 * Failures: a public one says its message to any caller, and stays public
 * from job to job (an Action's failure reaching its caller); any other is
 * not public, whatever its code.
 */
import { assert, assertEquals, assertRejects } from "@std/assert";
import { createRuntime, definePlugin, failure, isPublic } from "../mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { failure as wired, raise } from "../wire.ts";
import { test } from "../../testing/mod.ts";

test("a failure is public only when made so; a code alone isn't", () => {
  assert(isPublic(failure("not_now", "Search first.", { public: true })));
  assert(!isPublic(failure("not_now", "Search first.")));
  assert(!isPublic(Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" })));
  assert(!isPublic(null) && !isPublic("text"));
  const carried = raise(wired(failure("not_now", "Search first.", { public: true })));
  assertEquals([carried.message, (carried as { code?: string }).code, isPublic(carried)], [
    "Search first.",
    "not_now",
    true,
  ]);
  assert(!isPublic(raise(wired(failure("conflict", "inside")))));
});

test("an Action's public failure reaches its caller public", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: [
      definePlugin({
        name: "refuses",
        actions: {
          "refuses.now": {
            input: { type: "object" },
            run: () => {
              throw failure("not_now", "Not yet.", { public: true });
            },
          },
        },
      }),
    ],
  });
  try {
    const error = await assertRejects(() => runtime.call("refuses.now", {}));
    assert(isPublic(error));
  } finally {
    await runtime.close();
  }
});
