import { assertEquals } from "@std/assert";
import { workerPresence } from "../presence.ts";
import { test } from "../../testing/mod.ts";

test("a worker moving to a fresh connection neither arrives nor leaves", () => {
  const presence = workerPresence();
  assertEquals(presence.arrived("computer", "c1", "w1", "conn-a"), true);
  // Oxian's handoff: the successor is ready, then the old connection closes.
  assertEquals(presence.arrived("computer", "c1", "w1", "conn-b"), false);
  assertEquals(presence.left("computer", "c1", "w1", "conn-a"), false);
  assertEquals(presence.workerOf("computer", "c1"), "w1");
  // Its own connection closing: gone.
  assertEquals(presence.left("computer", "c1", "w1", "conn-b"), true);
  assertEquals(presence.workerOf("computer", "c1"), undefined);
});

test("another worker taking a kind's id, then the first one's connection closing", () => {
  const presence = workerPresence();
  presence.arrived("computer", "c1", "w1", "conn-a");
  // A new attempt (another worker id) for the same computer: it arrives.
  assertEquals(presence.arrived("computer", "c1", "w2", "conn-b"), true);
  // The old worker's connection closing says nothing about the new one.
  assertEquals(presence.left("computer", "c1", "w1", "conn-a"), false);
  assertEquals(presence.workerOf("computer", "c1"), "w2");
  assertEquals(presence.all(), [["computer", "c1"]]);
});

test("back after leaving is an arrival again", () => {
  const presence = workerPresence();
  presence.arrived("computer", "c1", "w1", "conn-a");
  assertEquals(presence.left("computer", "c1", "w1", "conn-a"), true);
  assertEquals(presence.arrived("computer", "c1", "w1", "conn-b"), true);
});
