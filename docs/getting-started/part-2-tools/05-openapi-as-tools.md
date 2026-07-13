---
title: "Ch 5: OpenAPI as Tools"
description: "Auto-generate agent tools from any OpenAPI 3.x spec."
section: Getting Started
order: 50
status: stable
---

# Chapter 5: OpenAPI as Tools

> **Part 2 — Tools: From Custom to Protocol**

## The pain

Service X has a thorough REST API. It's well-documented, with an OpenAPI spec.
But it doesn't have an MCP server. You need your agent to search their catalog,
create records, and trigger webhooks.

So you start writing tool wrappers. One for the search endpoint. One for create.
One for update. One for list. The service has 40 endpoints and you need 12 of
them. Each wrapper has the same structure: validate inputs, call the API, handle
errors, format the response.

This is mechanical work that a machine should do.

## The solution

Copilotz can read an OpenAPI 3.x spec and auto-generate a typed tool for every
operation — authentication, parameter handling, and response formatting
included. You provide the spec inline (or via the resource filesystem), and the
agent gains access to the entire API.

The spec is passed via the `openApiSchema` field — either as a parsed JavaScript
object or as a YAML/JSON string.

## Inline configuration

```typescript
import { createCopilotz } from "@copilotz/copilotz";
import petstoreSpec from "./specs/petstore.json" with { type: "json" };

const copilotz = await createCopilotz({
  agents: [
    {
      id: "catalog-manager",
      name: "Catalog Manager",
      role: "Manages the product catalog via the store API.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o",
      },
      // allowedTools controls which generated operations this agent can call.
      // Operation IDs from the spec become tool keys.
      // Leave undefined to allow all generated tools.
    },
  ],
  apis: [
    {
      id: "petstore",
      name: "Petstore API",
      openApiSchema: petstoreSpec, // Pass the parsed spec object directly
      baseUrl: "https://petstore3.swagger.io/api/v3",
      auth: {
        type: "bearer",
        token: Deno.env.get("STORE_API_TOKEN") ?? "",
      },
    },
  ],
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});

copilotz.start({ banner: "Catalog manager ready.\n" });
```

You can also pass the spec as a YAML or JSON string if you fetch it at runtime:

```typescript
const specYaml = await Deno.readTextFile("./specs/myservice.yaml");

apis: [
  {
    id: "myservice",
    name: "My Service",
    openApiSchema: specYaml, // YAML string — Copilotz parses it
    baseUrl: "https://api.myservice.com",
    auth: { type: "bearer", token: Deno.env.get("MYSERVICE_TOKEN") ?? "" },
  },
];
```

## File-based configuration (recommended for larger projects)

When using the resource filesystem, APIs live in `resources/apis/{id}/`:

```
resources/
└── apis/
    └── petstore/
        ├── config.ts          # baseUrl, auth, headers, etc.
        └── openApiSchema.json # The OpenAPI 3.x spec (must be JSON)
```

**`resources/apis/petstore/config.ts`:**

```typescript
export default {
  name: "Petstore API",
  baseUrl: "https://petstore3.swagger.io/api/v3",
  auth: {
    type: "bearer",
    token: Deno.env.get("STORE_API_TOKEN") ?? "",
  },
  headers: {
    "Accept": "application/json",
  },
};
```

**`resources/apis/petstore/openApiSchema.json`:**

```json
{
  "openapi": "3.0.0",
  "info": { "title": "Petstore", "version": "1.0.0" },
  "paths": {
    "/pet": {
      "get": {
        "operationId": "findPets",
        "summary": "Find pets",
        ...
      },
      "post": {
        "operationId": "addPet",
        ...
      }
    }
  }
}
```

Copilotz discovers this automatically when `resources.path` is configured — no
registration needed.

## Authentication options

The `auth` field supports several schemes:

```typescript
// Bearer token
auth: { type: "bearer", token: Deno.env.get("API_TOKEN") ?? "" }

// API key in header
auth: { type: "apiKey", in: "header", name: "X-API-Key", key: Deno.env.get("API_KEY") ?? "" }

// API key in query string
auth: { type: "apiKey", in: "query", name: "api_key", key: Deno.env.get("API_KEY") ?? "" }

// HTTP Basic auth
auth: { type: "basic", username: "user", password: Deno.env.get("API_PASS") ?? "" }

// Custom headers/query params
auth: {
  type: "custom",
  headers: { "X-Tenant-Id": "acme", "X-Version": "2" },
  queryParams: { format: "json" },
}

// Dynamic auth (fetches a token from an auth endpoint first)
auth: {
  type: "dynamic",
  authEndpoint: {
    url: "https://api.myservice.com/oauth/token",
    method: "POST",
    body: { grant_type: "client_credentials", client_id: "...", client_secret: "..." },
  },
  tokenExtraction: {
    path: "access_token",  // Dot-path into the JSON response
    type: "bearer",
  },
  cache: { enabled: true, duration: 3600 },  // Cache token for 1 hour
}
```

## How tool names are generated

`operationId` values in the spec become tool keys. Given:

```yaml
paths:
  /pets:
    get:
      operationId: listPets
    post:
      operationId: createPet
  /pets/{id}:
    get:
      operationId: getPetById
```

Copilotz generates tools with keys `listPets`, `createPet`, and `getPetById`.
These are the values you reference in `allowedTools`.

If an operation has no `operationId`, Copilotz skips it — so make sure your spec
has them.

## Scoping with `allowedTools`

For large APIs you only need a subset of, use `allowedTools` on the agent:

```typescript
{
  id: "billing-agent",
  allowedTools: [
    // Only these operations from the Stripe spec
    "GetCustomer",
    "ListCustomers",
    "RetrievePaymentIntent",
    "ListPaymentIntents",
  ],
}
```

The agent can only call those operations. All others in the spec are generated
but unreachable for this agent.

## Custom request preparation

For advanced cases — injecting per-request context, transforming URLs, adding
dynamic headers based on thread state — use `prepareRequest`:

```typescript
apis: [
  {
    id: "myapi",
    name: "My API",
    openApiSchema: spec,
    baseUrl: "https://api.myservice.com",
    prepareRequest: async (request, context) => {
      // context also includes stable toolCallId and traceId attribution.
      const tenantId = context.threadMetadata?.tenantId as string;
      return {
        ...request,
        headers: {
          ...request.headers,
          "X-Tenant-Id": tenantId,
        },
      };
    },
  },
];
```

`prepareRequest` runs after model-visible OpenAPI validation. Treat the model
body as untrusted: remove or overwrite protected identity, tenant, session,
workspace, credential, placement, and idempotency fields before sending the
request. Derive those values from the trusted context, including `toolCallId`
for stable request idempotency and `traceId` for observability. Do not merely
merge trusted fields underneath model-provided values.

## Multiple APIs

Stack as many APIs as you need — each with its own spec and auth:

```typescript
apis: [
  {
    id: "crm",
    name: "CRM API",
    openApiSchema: crmSpec,
    baseUrl: "https://api.hubspot.com",
    auth: { type: "bearer", token: Deno.env.get("HUBSPOT_TOKEN") ?? "" },
  },
  {
    id: "billing",
    name: "Billing API",
    openApiSchema: stripeSpec,
    baseUrl: "https://api.stripe.com",
    auth: { type: "bearer", token: Deno.env.get("STRIPE_KEY") ?? "" },
  },
],
```

Operation IDs are namespaced by `id` internally, so there are no collisions even
if two specs share operation names.

## What this unlocks

- Any OpenAPI 3.x spec becomes a full set of agent tools — no wrapper code
- Specs provided as JS objects, YAML strings, or JSON files in the resource
  filesystem
- Rich auth options including dynamic OAuth token fetching with caching
- Custom request preparation hooks for per-request context injection
- Multiple APIs, each independently scoped to specific agents via `allowedTools`

## What's next

Between native tools, MCP servers, and OpenAPI specs, your agent might now have
50 or more tools available. Here's the problem: every tool description goes into
the system prompt. At 50 tools, you're spending thousands of tokens on tool
descriptions before the user even says hello — and LLMs measurably perform worse
when choosing from too many options. This needs to be fixed.

→
**[Chapter 6: Tool Sprawl & Custom Skills](../part-3-skills/06-tool-sprawl-and-skills.md)**
