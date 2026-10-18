import { assertEquals, assertRejects } from "@std/assert";
import { createLocalPortCalls } from "./local-port-calls.ts";
Deno.test("local raw tracker preserves tagged snapshot cleanup uncertainty after authority loss", async () => {
  let live = true, quarantined: unknown;
  const cleanup = Object.assign(new Error("snapshot cleanup unknown"), {
    code: "owner_snapshot_cleanup_unknown",
    indeterminate: true,
  });
  const calls = createLocalPortCalls({
    current() {
      if (!live) throw new Error("authority lost");
    },
    quarantine(error) {
      quarantined = error;
      return error;
    },
    failure: (code) => new Error(code),
    snapshot: structuredClone,
    signal: new AbortController().signal,
    maxPendingCalls: 1,
  });
  const failure = await assertRejects(() =>
    calls.run(() => {
      live = false;
      return Promise.reject(cleanup);
    })
  );
  assertEquals(failure, cleanup);
  assertEquals(quarantined, cleanup);
  await calls.drain();
  assertEquals(calls.size, 0);
});
