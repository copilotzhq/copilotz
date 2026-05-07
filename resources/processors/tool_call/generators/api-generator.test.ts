import {
  assertEquals,
  assertObjectMatch,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import type { API } from "@/types/index.ts";

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

Deno.test("API tool applies history policy overrides to generated tools", () => {
  const [tool] = generateApiTools(buildApiConfig({
    historyPolicyDefaults: {
      visibility: "requester_only",
    },
    toolPolicies: {
      getStatus: {
        visibility: "public_result",
      },
    },
  }));

  assertObjectMatch(tool, {
    key: "getStatus",
    historyPolicy: {
      visibility: "public_result",
    },
  });
});

Deno.test("API dynamic auth uses raw response body when token path is omitted", async () => {
  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];

  globalThis.fetch = async (input, init: globalThis.RequestInit | undefined) => {
    const url = String(input);
    const headers = Object.fromEntries(
      new Headers(init?.headers).entries(),
    );
    requests.push({ url, headers });

    if (url.includes("metadata.google.internal")) {
      return new Response("google-id-token\n", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const [tool] = generateApiTools(buildApiConfig({
      headers: {
        Authorization: "Bearer shared-secret",
      },
      auth: {
        type: "dynamic",
        authEndpoint: {
          url:
            "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=https://sandbox.example.run.app",
          method: "GET",
          headers: {
            "Metadata-Flavor": "Google",
          },
        },
        tokenExtraction: {
          type: "apiKey",
          headerName: "X-Serverless-Authorization",
          prefix: "Bearer ",
        },
      },
    }));

    await tool.execute({});

    assertEquals(requests.length, 2);
    assertEquals(requests[0].headers["metadata-flavor"], "Google");
    assertEquals(
      requests[1].headers["x-serverless-authorization"],
      "Bearer google-id-token",
    );
    assertEquals(requests[1].headers.authorization, "Bearer shared-secret");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("API prepareRequest can inject trusted runtime context into request body", async () => {
  const originalFetch = globalThis.fetch;
  let captured: { url: string; body: Record<string, unknown> } | undefined;

  globalThis.fetch = async (input, init: globalThis.RequestInit | undefined) => {
    captured = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    };
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  try {
    const [tool] = generateApiTools(buildApiConfig({
      openApiSchema: {
        openapi: "3.0.0",
        info: { title: "Prepared API", version: "1.0.0" },
        paths: {
          "/v1/browser-session": {
            post: {
              operationId: "browser_session",
              requestBody: {
                required: true,
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      required: ["sessionId", "actions"],
                      properties: {
                        sessionId: { type: "string" },
                        scope: {
                          type: "string",
                          enum: ["agent", "thread"],
                        },
                        actions: {
                          type: "array",
                          items: { type: "object" },
                        },
                      },
                    },
                  },
                },
              },
              responses: { "200": { description: "OK" } },
            },
          },
        },
      },
      prepareRequest: (request, context) => {
        const body = request.body as Record<string, unknown>;
        const scope = body.scope === "thread" ? "thread" : "agent";
        return {
          ...request,
          body: {
            ...body,
            scope: undefined,
            sessionId: [
              context.namespacePrefix ?? "default",
              context.userExternalId ?? "anonymous",
              context.threadId ?? "no-thread",
              scope === "agent" ? context.senderId ?? "agent" : "thread",
              body.sessionId,
            ].join(":"),
            actor: {
              tenantId: context.namespacePrefix,
              userId: context.userExternalId,
              threadId: context.threadId,
              agentId: context.senderId,
            },
          },
        };
      },
    }));

    await tool.execute(
      {
        sessionId: "main",
        scope: "agent",
        actions: [{ action: "read" }],
      },
      {
        namespacePrefix: "compass",
        userExternalId: "user-1",
        threadId: "thread-1",
        senderId: "east",
        senderType: "agent",
      },
    );

    assertEquals(captured?.url, "https://example.com/v1/browser-session");
    assertObjectMatch(captured?.body ?? {}, {
      sessionId: "compass:user-1:thread-1:east:main",
      actor: {
        tenantId: "compass",
        userId: "user-1",
        threadId: "thread-1",
        agentId: "east",
      },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
