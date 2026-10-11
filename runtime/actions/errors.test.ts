import { assertEquals, assertThrows } from "@std/assert";
import { ActionError } from "./index.ts";

Deno.test("ActionError requires a message, code and client-error HTTP status", () => {
  assertEquals(new ActionError("Refused.", { code: "refused" }).status, 422);
  for (const status of [200, 399, 500, 422.5, NaN]) {
    assertThrows(
      () => new ActionError("Refused.", { code: "refused", status }),
      RangeError,
    );
  }
  assertThrows(() => new ActionError(" ", { code: "refused" }), TypeError);
  assertThrows(() => new ActionError("Refused.", { code: " " }), TypeError);
});
