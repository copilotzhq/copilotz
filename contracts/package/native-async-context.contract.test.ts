import { assertEquals, assertRejects } from "@std/assert";

import {
  createAsyncContextStorage,
  runIndependentAsyncContext,
} from "../../dependencies/async-hooks.ts";

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

Deno.test("independent execution hides inherited stores, allows explicit rebind and restores parent", async () => {
  const storage = createAsyncContextStorage<object | undefined>();
  const parent = {};
  await storage.run(parent, async () => {
    await runIndependentAsyncContext(async () => {
      assertEquals(storage.getStore(), undefined);
      await storage.run(parent, async () => {
        assertEquals(storage.getStore(), parent);
        await Promise.resolve();
        assertEquals(storage.getStore(), parent);
        await assertRejects(
          () =>
            runIndependentAsyncContext(async () => {
              assertEquals(storage.getStore(), undefined);
              await storage.run(
                undefined,
                () => assertEquals(storage.getStore(), undefined),
              );
              throw new Error("independent rejected");
            }),
          Error,
          "independent rejected",
        );
        assertEquals(storage.getStore(), parent);
      });
      assertEquals(storage.getStore(), undefined);
    });
    assertEquals(storage.getStore(), parent);
  });
  assertEquals(storage.getStore(), undefined);
});

Deno.test("overlapping independent executions retain only their explicitly installed stores", async () => {
  const storage = createAsyncContextStorage<string>();
  const firstEntered = Promise.withResolvers<void>();
  const secondEntered = Promise.withResolvers<void>();
  await storage.run("scheduler", () =>
    Promise.all([
      runIndependentAsyncContext(async () => {
        assertEquals(storage.getStore(), undefined);
        await storage.run("first", async () => {
          firstEntered.resolve();
          await secondEntered.promise;
          assertEquals(storage.getStore(), "first");
        });
      }),
      runIndependentAsyncContext(async () => {
        await firstEntered.promise;
        assertEquals(storage.getStore(), undefined);
        await storage.run("second", async () => {
          secondEntered.resolve();
          await Promise.resolve();
          assertEquals(storage.getStore(), "second");
        });
      }),
    ]));
  assertEquals(storage.getStore(), undefined);
});

Deno.test("native storage initialization remains lazy and retries after unavailable loader", async () => {
  let loads = 0;
  let calls = 0;
  const storage = createAsyncContextStorage<string>(async () => {
    loads++;
    if (loads === 1) throw new Error("unavailable first load");
    return (await import("node:async_hooks")).AsyncLocalStorage;
  });
  assertEquals(loads, 0);
  assertEquals(storage.getStore(), undefined);
  assertEquals(loads, 0);
  await assertRejects(
    () =>
      storage.run("first", () => {
        calls++;
      }),
    Error,
    "native AsyncLocalStorage support",
  );
  assertEquals(calls, 0);
  await runIndependentAsyncContext(() =>
    storage.run("retried", () => {
      calls++;
      assertEquals(storage.getStore(), "retried");
    })
  );
  assertEquals(loads, 2);
  assertEquals(calls, 1);
});
