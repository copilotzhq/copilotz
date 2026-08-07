---
name: add-api-integration
description: Add an OpenAPI API resource and expose its operations as agent tools.
allowed-tools: [read_file, write_file, list_directory, http_request]
tags: [framework, api, plugin]
---

# Add API Integration

In Copilotz v3, an OpenAPI integration is an `apis` resource inside a plugin.
The host explicitly grants the Web-fetch tool catalog to the text workflow; the
core never scans a resource directory.

## Define the plugin

```ts
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";
import type { API } from "jsr:@copilotz/copilotz@3/resources";

export function createCustomerApiPlugin(input: {
  schema: Record<string, unknown>;
  token: string;
}) {
  const api: API = {
    id: "customer-api",
    name: "Customer API",
    openApiSchema: input.schema,
    baseUrl: "https://api.example.com",
    auth: { type: "bearer", token: input.token },
    historyPolicyDefaults: { visibility: "requester_only" },
    toolPolicies: {
      getCustomer: { visibility: "public" },
    },
  };

  return definePlugin({
    manifest: {
      id: "@acme/customer-api",
      version: "1.0.0",
      provides: { apis: [api.id] },
    },
    resources: { apis: [api] },
  });
}
```

Inject secrets from the application boundary. Do not read Deno, Node, or Bun
environment globals in a portable plugin.

## Grant OpenAPI execution

```ts
import { createCopilotz } from "jsr:@copilotz/copilotz@3";
import { createServerWorkflowToolCatalog } from "jsr:@copilotz/copilotz@3/adapters";

const app = await createCopilotz({
  namespace: "acme",
  plugins: [createCustomerApiPlugin({ schema, token })],
  core: {
    text: { toolCatalog: createServerWorkflowToolCatalog() },
  },
  resources: {
    agents: [{
      id: "support",
      name: "Support",
      role: "Support customers.",
      allowedTools: ["getCustomer"],
      runtimes: { text: { type: "llm", provider: "openai" } },
    }],
  },
});
```

Each OpenAPI `operationId` becomes the stable tool key. Keep operation IDs
unique across the composed application and use `allowedTools` to grant them.

## Checklist

- Use an OpenAPI 3.x object or string with stable `operationId` values.
- Keep routing data and credentials small; return large bodies through normal
  tool-result content handling.
- Use `prepareRequest` for dynamic request policy and the provided idempotency
  key for externally mutating operations.
- Test generated schemas and auth without relying on filesystem discovery.
