import { assert, assertEquals, assertThrows } from "@std/assert";
import { captureParentCapture } from "./protected-action-content.ts";

Deno.test("parent capture assertions synchronously bound paths, descriptors, and destination without invoking accessors", () => {
  const input = {
    captureKey: "create:content",
    parentInputPath: "/message~1body/content~0refs",
    content: [],
    origin: { type: "document", id: "record" },
  };
  const fixed = captureParentCapture(input);
  input.origin.id = "changed";
  assertEquals(fixed.origin.id, "record");
  assert(Object.isFrozen(fixed));
  for (
    const path of [
      "",
      "relative",
      "/message/~2",
      "/__proto__/content",
      "/message//content",
    ]
  ) {
    assertThrows(() =>
      captureParentCapture({ ...input, parentInputPath: path })
    );
  }
  assertThrows(() =>
    captureParentCapture({
      ...input,
      origin: { type: "document", id: " record" },
    })
  );
  assertThrows(() =>
    captureParentCapture({ ...input, captureKey: "x".repeat(513) })
  );
  assertThrows(() =>
    captureParentCapture(
      {
        ...input,
        content: [{
          type: "content.pending",
          pendingRef: "unadopted",
          mediaType: "text/plain",
          digest: "sha256:x",
          byteLength: 1,
        }],
      } as never,
    )
  );
  assertThrows(() =>
    captureParentCapture({ ...input, content: [], extra: true } as never)
  );
  let getter = false;
  assertThrows(() =>
    captureParentCapture({
      ...input,
      get content() {
        getter = true;
        return [];
      },
    })
  );
  assertEquals(getter, false);
});
