import { assertEquals, assertThrows } from "@std/assert";
import { snapshotStreamMetadata } from "./json.ts";
Deno.test("stream metadata is detached, recursively frozen and bounded before publication", () => {
  const source = { nested: [{ value: "original" }] },
    snapshot = snapshotStreamMetadata(source);
  source.nested[0].value = "changed";
  assertEquals(snapshot, { nested: [{ value: "original" }] });
  assertEquals(Object.isFrozen(snapshot), true);
  assertEquals(Object.isFrozen(snapshot.nested), true);
  assertThrows(() => snapshotStreamMetadata({ text: "x".repeat(65536) }));
  assertThrows(() => snapshotStreamMetadata({ a: { b: 1 } }, { maxDepth: 1 }));
  assertThrows(() => snapshotStreamMetadata({ a: [1, 2, 3] }, { maxNodes: 3 }));
  assertThrows(() =>
    snapshotStreamMetadata({ a: "oversize" }, { maxBytes: 3 })
  );
  assertThrows(() => snapshotStreamMetadata(null));
});
Deno.test("stream metadata never invokes accessor, iterator or toJSON code", () => {
  let calls = 0;
  const getter = {
    get value() {
      calls++;
      return "unsafe";
    },
  };
  assertThrows(() => snapshotStreamMetadata(getter));
  const array = [1];
  Object.defineProperty(array, "0", {
    enumerable: true,
    get() {
      calls++;
      return 2;
    },
  });
  assertThrows(() => snapshotStreamMetadata({ array }));
  assertThrows(() =>
    snapshotStreamMetadata({
      toJSON() {
        calls++;
        return {};
      },
    })
  );
  assertEquals(calls, 0);
});
Deno.test("writer append replay receipts retain digests and offsets rather than completed chunks", async () => {
  const source = await Deno.readTextFile(
    new URL("./stream.ts", import.meta.url),
  );
  const receiptType = source.slice(
    source.indexOf("const appends = new Map"),
    source.indexOf("const queue ="),
  );
  assertEquals(receiptType.includes("Uint8Array"), false);
  assertEquals(receiptType.includes("digest: string"), true);
  assertEquals(
    source.includes("appends.set(appendId, { digest, ...result })"),
    true,
  );
  assertEquals(source.includes("appends.clear()"), true);
});
