---
name: add-api-integration
description: Add an OpenAPI-based external API integration that auto-generates tools for agents.
allowed-tools: [read_file, write_file, list_directory, http_request]
tags: [framework, api]
---

# Add API Integration

Integrate an external REST API using an OpenAPI spec. Copilotz auto-generates tools from the spec.

## Directory Structure

```
resources/apis/{api-name}/
  openApiSchema.json    # Required: OpenAPI 3.0 spec
  config.ts             # Optional: auth, base URL, tool policies
```

## Step 1: Add OpenAPI Spec

Place the OpenAPI 3.0 spec as `openApiSchema.json`. Can also be `.yaml`.

## Step 2: Create config.ts

```typescript
import type { API } from "copilotz";

const config: Omit<API, "openApiSchema"> = {
    id: "my-api",
    name: "My API",
    baseUrl: "https://api.example.com",  // Override spec's server URL
    auth: {
        type: "bearer",
        token: Deno.env.get("MY_API_TOKEN"),
    },
    // Control how API tool results appear in history
    historyPolicyDefaults: {
        visibility: "requester_only",
    },
    toolPolicies: {
        getItem: {                       // Keyed by operationId
            visibility: "public_result",
            projector: (_args, output) => {
                const item = output as { name?: string };
                return `Loaded item: ${item.name}`;
            },
        },
    },
};

export default config;
```

## Auth Types

```typescript
// Bearer token
auth: { type: "bearer", token: "..." }

// API key (header or query)
auth: { type: "apiKey", key: "X-API-Key", value: "...", in: "header" }

// Basic auth
auth: { type: "basic", username: "...", password: "..." }
```

## Notes

- Each operation in the spec becomes a tool named `{apiId}_{operationId}`
- Agents access API tools via `allowedTools` (e.g., `["myapi_getItem"]`)
- The spec is loaded once at startup; the actual API is called at runtime
