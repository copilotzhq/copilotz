import { assertEquals, assertRejects } from "@std/assert";
import { createCollectionObserver } from "./collection-observation.ts";
import type { ObservationFrame } from "./index.ts";
import { ProtocolError } from "./protocol.ts";

const frame = (
  to: string,
  reset: boolean,
  from?: string,
): ObservationFrame => ({
  kind: "output",
  checkpoint: to,
  output: {
    type: "collection.snapshot",
    collection: "entry",
    to,
    reset,
    ...(from ? { from } : {}),
    value: [],
    status: "ready",
    pending: false,
  },
});
Deno.test("Collection client rejects an initial gap and only accepts explicit reset replacement", async () => {
  const gap = createCollectionObserver(async (_path, _selection, options) => {
    await options.onFrame(frame("2", false, "1"));
    return "2";
  });
  await assertRejects(
    () => gap("entry", { id: "one" }, { onSnapshot() {} }),
    ProtocolError,
    "gap",
  );
  const values: string[] = [];
  const reset = createCollectionObserver(async (_path, _selection, options) => {
    await options.onFrame(frame("5", true));
    await options.onFrame(frame("6", false, "5"));
    await options.onFrame(frame("1", true)); // Explicit new owner/snapshot baseline.
    return "1";
  });
  assertEquals(
    await reset("entry", { query: { limit: 10 } }, {
      checkpoint: "untrusted-old-cursor",
      onSnapshot(value) {
        values.push(value.to);
      },
    }),
    "1",
  );
  assertEquals(values, ["5", "6", "1"]);
});
Deno.test("Collection applied coverage advances only after successful application", async () => {
  let fail = false;
  const observe = createCollectionObserver(
    async (_path, _selection, options) => {
      await options.onFrame(frame("1", true));
      fail = true;
      await assertRejects(
        () => Promise.resolve(options.onFrame(frame("2", false, "1"))),
        Error,
        "application failed",
      );
      fail = false;
      await options.onFrame(frame("3", false, "1"));
      await assertRejects(
        () => Promise.resolve(options.onFrame(frame("4", false, "2"))),
        ProtocolError,
        "gap",
      );
      return "3";
    },
  );
  assertEquals(
    await observe("entry", { id: "one" }, {
      onSnapshot() {
        if (fail) throw new Error("application failed");
      },
    }),
    "3",
  );
});
