import { assertEquals, assertThrows } from "@std/assert";
import {
  DEFAULT_SERVER_ASSET_UPLOAD_BYTES,
  defineServerFacade,
} from "./index.ts";

Deno.test("defineServerFacade snapshots exposure and defaults", () => {
  const include = ["atlas.*"];
  const value = defineServerFacade({
    authenticate: () => new Response(null, { status: 401 }),
    expose: { actions: { include } },
  });
  include.push("later.*");
  assertEquals(value.basePath, "/api");
  assertEquals(value.maxAssetUploadBytes, DEFAULT_SERVER_ASSET_UPLOAD_BYTES);
  assertEquals(value.expose.actions, {
    include: ["atlas.*"],
    exclude: [],
  });
});

Deno.test("defineServerFacade rejects malformed policy", () => {
  assertThrows(
    () =>
      defineServerFacade({
        authenticate: () => new Response(null, { status: 401 }),
        expose: { actions: { include: [""] } },
      }),
    TypeError,
  );
  assertThrows(
    () =>
      defineServerFacade({
        authenticate: () => new Response(null, { status: 401 }),
        basePath: "/api/v2",
      }),
    TypeError,
  );
  assertThrows(
    () =>
      defineServerFacade({
        authenticate: () => new Response(null, { status: 401 }),
        maxAssetUploadBytes: 0,
      }),
    TypeError,
  );
});
