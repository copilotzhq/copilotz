import { assertEquals, assertThrows } from "@std/assert";
import { captureOfflineManifest } from "./offline-manifest.ts";
import { captureHostCommandJson } from "../application/host-command-json.ts";

Deno.test("offline manifests exceed online aggregate limits without accepting accessors or aliases", () => {
  const manifest = {
    events: Array.from(
      { length: 12000 },
      (_, id) => ({ id, text: "synthetic".repeat(20) }),
    ),
  };
  assertThrows(() => captureHostCommandJson(manifest), RangeError);
  const snapshot = captureOfflineManifest(manifest);
  assertEquals(snapshot, manifest);
  assertEquals(Object.isFrozen(snapshot.events[0]), true);
  manifest.events[0].text = "changed";
  assertEquals(snapshot.events[0].text, "synthetic".repeat(20));
  let calls = 0;
  assertThrows(() =>
    captureOfflineManifest({
      get secret() {
        calls++;
        return "bad";
      },
    }), TypeError);
  assertEquals(calls, 0);
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  for (
    const invalid of [cycle, new Date(), { x: NaN }, { x: undefined }, [, ,], {
      [Symbol("x")]: 1,
    }]
  ) {
    assertThrows(() => captureOfflineManifest(invalid), TypeError);
  }
});
