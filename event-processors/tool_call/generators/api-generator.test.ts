import {
  assertEquals,
  assertObjectMatch,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import type { API } from "@/database/schemas/index.ts";

import { generateApiTools } from "./api-generator.ts";

const buildApiConfig = (overrides: Partial<API> = {}): API =>
  ({
    id: "api_test",
    name: "Test API",
    externalId: null,
    description: null,
    openApiSchema: {
      openapi: "3.0.0",
      info: {
        title: "Test API",
        version: "1.0.0",
      },
      paths: {
        "/status": {
          get: {
            operationId: "getStatus",
            summary: "Get status",
            responses: {
              "200": { description: "OK" },
            },
          },
        },
      },
    },
    baseUrl: "https://example.com",
    headers: null,
    auth: null,
    timeout: 30,
    includeResponseHeaders: null,
    metadata: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  }) as API;

Deno.test("API tool returns body text by default", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_123",
      },
    });

  try {
    const [tool] = generateApiTools(buildApiConfig());
    const result = await tool.execute({});

    assertEquals(result, JSON.stringify({ ok: true }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("API tool can include response headers", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_456",
      },
    });

  try {
    const [tool] = generateApiTools(
      buildApiConfig({ includeResponseHeaders: true }),
    );
    const result = await tool.execute({});

    assertObjectMatch(result as Record<string, unknown>, {
      body: JSON.stringify({ ok: true }),
      headers: {
        "content-type": "application/json",
        "x-request-id": "req_456",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
