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

Deno.test("OpenAPI NDJSON responses stream output before returning their final value", async () => {
  const api: API = {
    id: "streaming-api",
    name: "Streaming API",
    baseUrl: "https://example.test",
    streamNdjson: true,
    openApiSchema: {
      openapi: "3.1.0",
      paths: {
        "/terminal": {
          post: {
            operationId: "terminal",
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: {} },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    },
  };
  const seen: unknown[] = [];
  const executionContext = {
    emitOutput(value: unknown, options: unknown) {
      seen.push({ value, options });
      return Promise.resolve();
    },
    processor: { signal: new AbortController().signal },
  } as unknown as WorkflowToolExecutionContext;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        [
          JSON.stringify({
            type: "output",
            channel: "stdout",
            mode: "append",
            delta: "hello\n",
          }),
          JSON.stringify({
            type: "output",
            channel: "stderr",
            mode: "append",
            delta: "warning\n",
          }),
          JSON.stringify({ type: "result", value: { exitCode: 0 } }),
          "",
        ].join("\n"),
        {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        },
      ),
    );
  try {
    const result = await generateApiTools(api)[0].execute({}, executionContext);
    assertEquals(seen, [{
      value: "hello\n",
      options: { channel: "stdout", mode: "append" },
    }, {
      value: "warning\n",
      options: { channel: "stderr", mode: "append" },
    }]);
    assertEquals(result, { exitCode: 0 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("OpenAPI response assets become canonical attachments without leaking base64", async () => {
  const api: API = {
    id: "asset-api",
    name: "Asset API",
    baseUrl: "https://example.test",
    responseAssets: {
      asset_export: {
        dataBase64Field: "dataBase64",
        mediaTypeField: "mimeType",
        nameField: "path",
      },
    },
    openApiSchema: {
      openapi: "3.1.0",
      paths: {
        "/assets/export": {
          post: {
            operationId: "asset_export",
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: {} },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    },
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(Response.json({
      path: "outputs/report.csv",
      mimeType: "text/csv",
      size: 18,
      dataBase64: btoa("name,value\nalpha,1\n"),
      workspaceGeneration: 2,
      environment: null,
    }));
  try {
    const result = await generateApiTools(api)[0].execute({});
    assertEquals(result, {
      kind: "copilotz.workflow-tool.result.v1",
      output: {
        path: "outputs/report.csv",
        mimeType: "text/csv",
        size: 18,
        workspaceGeneration: 2,
        environment: null,
      },
      attachments: [{
        type: "file",
        bytes: new TextEncoder().encode("name,value\nalpha,1\n"),
        mediaType: "text/csv",
        role: "attachment",
        disposition: "attachment",
        name: "report.csv",
      }],
    });
    assertEquals(JSON.stringify(result).includes("dataBase64"), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
