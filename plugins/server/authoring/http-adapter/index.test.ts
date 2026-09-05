import { assertEquals, assertThrows } from "@std/assert";
import { createPluginRegistry, definePlugin } from "@copilotz/copilotz/plugins";
import { createHttpAdapter, type HttpRoute } from "./index.ts";
import { compileServerRoutes } from "../route-compiler/index.ts";
import { defineServerFacade } from "../../resources/facade/index.ts";

Deno.test("HTTP adapters reject dispatchers, ambiguous parameters, and duplicate identities", () => {
  const route = {
    id: "test",
    method: "GET",
    path: "/test",
    handler: () => ({}),
  } as const;
  for (
    const path of [
      "/*",
      "/v2/test",
      "/test/:id/:id",
      "/test//item",
      "/test?value=1",
      "/test/%2f",
      "/test/:bad-name",
    ]
  ) {
    assertThrows(
      () => createHttpAdapter({ routes: [{ ...route, path }] }),
      TypeError,
    );
  }
  assertThrows(
    () =>
      createHttpAdapter({
        routes: [{ ...route, method: "TRACE" } as unknown as HttpRoute],
      }),
    TypeError,
  );
  assertThrows(() => createHttpAdapter({ routes: [route, route] }), TypeError);
});

Deno.test("compiled routes preserve frozen endpoint policy and prefer exact paths", () => {
  const policy = { authentication: { mode: "public" } };
  const http = createHttpAdapter({
    routes: [
      { id: "item", method: "GET", path: "/items/:id", handler: () => ({}) },
      {
        id: "discovery",
        method: "GET",
        path: "/items/discovery",
        metadata: policy,
        handler: () => ({}),
      },
    ],
  });
  policy.authentication.mode = "changed";
  const registry = createPluginRegistry({
    plugins: [
      definePlugin({
        id: "test",
        version: "1",
        adapters: { http: { test: http } },
      }),
    ],
  });
  const routes = compileServerRoutes(registry, defineServerFacade());
  const match = routes.match("GET", "/api/items/discovery")!;
  assertEquals(match.endpoint.id, "discovery");
  assertEquals(match.endpoint.metadata, { authentication: { mode: "public" } });
  assertEquals(Object.isFrozen(match.endpoint.metadata?.authentication), true);
  assertEquals(routes.match("GET", "/api/items/other")?.params, {
    id: "other",
  });
});
