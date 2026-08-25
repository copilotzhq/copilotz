import { assertEquals, assertThrows } from "@std/assert";
import { defineServerFacade } from "./index.ts";

Deno.test("defineServerFacade snapshots exposure, overrides, and defaults", () => {
  const include = ["compass.*"];
  const value = defineServerFacade({
    expose: { actions: { include } },
    overrides: {
      actions: { "compass.preview.list": { path: "/features/previews/list/" } },
    },
  });
  include.push("later.*");
  assertEquals(value.basePath, "/api/v1");
  assertEquals(value.expose.actions, {
    include: ["compass.*"],
    exclude: [],
  });
  assertEquals(value.overrides.actions, {
    "compass.preview.list": { path: "/features/previews/list" },
  });
  assertEquals(Object.isFrozen(value), true);
});

Deno.test("defineServerFacade rejects malformed policy", () => {
  assertThrows(
    () => defineServerFacade({ expose: { actions: { include: [""] } } }),
    TypeError,
  );
  assertThrows(
    () =>
      defineServerFacade({
        overrides: { actions: { missing: { path: "../x" } } },
      }),
    TypeError,
  );
});
