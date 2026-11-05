/**
 * Entries that last a while: gone to `get` once past, dropped from memory by
 * a sweep that stops at the first still kept (set again, one lasts from
 * then), and none kept after `close`.
 */
import { assertEquals } from "@std/assert";
import { expiring } from "../expiring.ts";
import { test } from "../../testing/mod.ts";

const later = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("an entry lasts its while from when it's set, and is then dropped", async () => {
  const kept = expiring<string, number>(100, { every: 10 });
  kept.set("a", 1);
  kept.set("b", 2);
  assertEquals([kept.get("a"), kept.get("b"), kept.size()], [1, 2, 2]);
  await later(60);
  // Set again, it lasts from now.
  kept.set("a", 3);
  await later(70);
  assertEquals([kept.get("a"), kept.get("b")], [3, undefined]);
  assertEquals(kept.size(), 1);
  await later(70);
  assertEquals([kept.get("a"), kept.size()], [undefined, 0]);
  kept.close();
});

test("closed, nothing's kept", () => {
  const kept = expiring<string, number>(60_000);
  kept.set("a", 1);
  kept.close();
  assertEquals([kept.get("a"), kept.size()], [undefined, 0]);
  kept.delete("a");
});
