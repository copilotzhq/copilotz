import { assertEquals, assertStrictEquals } from "@std/assert";
import type { API } from "../resources/index.ts";
import type { WorkflowToolExecutionContext } from "../workflows/index.ts";
import { generateApiTools } from "./openapi-tools.ts";

Deno.test("OpenAPI preparation receives the trusted database and collection scope", async () => {
  let observed:
    | Parameters<NonNullable<API["prepareRequest"]>>[1]
    | undefined;
  const api: API = {
    id: "scoped-api",
    name: "Scoped API",
    baseUrl: "https://example.test",
    openApiSchema: {
      openapi: "3.0.0",
      paths: {
        "/lookup": {
          get: {
            operationId: "scoped_lookup",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    },
    prepareRequest(request, context) {
      observed = context;
      return request;
    },
  };
  const collection = Object.freeze({ definition: { name: "records" } });
  const executionContext = {
    namespace: "tenant-a",
    processor: { databaseSchema: "tenant_a" },
    collections: { records: collection },
  } as unknown as WorkflowToolExecutionContext;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response('{"ok":true}', {
        headers: { "content-type": "application/json" },
      }),
    );
  try {
    const tool = generateApiTools(api)[0];
    await tool.execute({}, executionContext);
    assertEquals(observed?.namespace, "tenant-a");
    assertEquals(observed?.databaseSchema, "tenant_a");
    assertStrictEquals(observed?.collections?.records, collection as never);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
