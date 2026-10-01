import { assertEquals, assertRejects } from "@std/assert";

import { createAsyncContextStorage } from "../../dependencies/async-hooks.ts";

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

Deno.test("native async context keeps overlapping runs isolated", async () => {
  const storage = createAsyncContextStorage<string>();
  const run = (value: string, delay: number) =>
    storage.run(value, async () => {
      assertEquals(storage.getStore(), value);
      await wait(delay);
      assertEquals(storage.getStore(), value);
      await Promise.resolve();
      assertEquals(storage.getStore(), value);
      return value;
    });

  assertEquals(await Promise.all([run("first", 10), run("second", 1)]), [
    "first",
    "second",
  ]);
  assertEquals(storage.getStore(), undefined);
});

Deno.test("native async context restores nested scope after rejection", async () => {
  const storage = createAsyncContextStorage<string>();
  await storage.run("outer", async () => {
    assertEquals(storage.getStore(), "outer");
    await assertRejects(
      () =>
        storage.run("inner", async () => {
          assertEquals(storage.getStore(), "inner");
          await wait(1);
          throw new Error("inner rejected");
        }),
      Error,
      "inner rejected",
    );
    assertEquals(storage.getStore(), "outer");
  });
  assertEquals(storage.getStore(), undefined);
});

Deno.test("missing native async context fails before invoking a scoped callback", async () => {
  const storage = createAsyncContextStorage<string>(() =>
    Promise.reject(new Error("native module unavailable"))
  );
  let invoked = false;

  await assertRejects(
    () =>
      storage.run("scope", () => {
        invoked = true;
      }),
    Error,
    "This operation requires native AsyncLocalStorage support",
  );
  assertEquals(invoked, false);
  assertEquals(storage.getStore(), undefined);
});
