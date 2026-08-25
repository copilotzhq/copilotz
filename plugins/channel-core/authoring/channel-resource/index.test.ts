import { assertEquals } from "@std/assert";
import { defineChannelResource } from "./index.ts";

Deno.test("channel resource freezes its policy", () => {
  assertEquals(
    defineChannelResource({ egress: "external" }).egress,
    "external",
  );
});
