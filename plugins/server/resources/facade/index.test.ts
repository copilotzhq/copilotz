import { assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_SERVER_ASSET_UPLOAD_BYTES,
  defineServerFacade,
} from "./index.ts";

Deno.test("defineServerFacade snapshots exposure and defaults", () => {
  const include = ["compass.*"];
  const value = defineServerFacade({
    expose: { actions: { include } },
  });
  include.push("later.*");
  assertEquals(value.basePath, "/api");
  assertEquals(value.maxAssetUploadBytes, DEFAULT_SERVER_ASSET_UPLOAD_BYTES);
  assertEquals(value.expose.actions, {
    include: ["compass.*"],
    exclude: [],
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
        basePath: "/api/v2",
      }),
    TypeError,
  );
  assertThrows(
    () => defineServerFacade({ maxAssetUploadBytes: 0 }),
    TypeError,
  );
});
