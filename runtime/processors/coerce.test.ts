import { assertEquals } from "@std/assert";
import { coerceProcessorProcess } from "./coerce.ts";

Deno.test("processor coercion preserves background thread wakeups", async () => {
  const process = coerceProcessorProcess(() => ({
    backgroundThreadIds: ["thread-a", 42, "thread-b"],
  }));

  assertEquals(
    await process({} as never, {} as never),
    { backgroundThreadIds: ["thread-a", "thread-b"] },
  );
});
