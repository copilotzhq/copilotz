import { assertEquals, assertRejects } from "@std/assert";
import type { OperationCatalog } from "../runtime/streams/catalog.ts";
import { watchSelection } from "./selection-watch.ts";

Deno.test("selection watch retries failed subscription acquisition", async () => {
  let attempts = 0;
  let removed = 0;
  const catalog = {
    onChange() {
      if (++attempts === 1) return Promise.reject(new Error("unavailable"));
      return Promise.resolve(() => removed++);
    },
  } as unknown as OperationCatalog;
  await assertRejects(
    () => watchSelection(catalog, "tenant", "thread", () => {}),
    Error,
    "unavailable",
  );
  const first = await watchSelection(catalog, "tenant", "thread", () => {});
  const second = await watchSelection(catalog, "tenant", "other", () => {});
  first.close();
  assertEquals(removed, 0);
  second.close();
  second.close();
  assertEquals(attempts, 2);
  assertEquals(removed, 1);
});
