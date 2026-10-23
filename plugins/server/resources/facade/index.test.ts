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

Deno.test("SEC3 facade validates canonical origins and default Host cookie attributes", () => {
  for (
    const allowedOrigins of [["*"], ["null"], ["https://app.example/"], [
      "https://user:pass@app.example",
    ], ["file://example"]]
  ) {
    assertThrows(() =>
      defineServerFacade({
        authenticate: () => {
          throw new Error("unused");
        },
        allowedOrigins,
      })
    );
  }
  for (
    const sessionCookie of [{ secure: false }, { path: "/api" }, {
      domain: "example.com",
    }]
  ) {
    assertThrows(() =>
      defineServerFacade({
        authenticate: () => {
          throw new Error("unused");
        },
        sessionCookie,
      })
    );
  }
});

Deno.test("defineServerFacade retains and validates the trusted actor resolver", () => {
  const authenticate = () => new Response(null, { status: 401 });
  const resolveActor = () => ({ id: "participant" });
  assertEquals(
    defineServerFacade({ authenticate, resolveActor }).resolveActor,
    resolveActor,
  );
  assertThrows(
    () =>
      defineServerFacade({
        authenticate,
        resolveActor: "invalid" as unknown as typeof resolveActor,
      }),
    TypeError,
    "resolveActor",
  );
});
