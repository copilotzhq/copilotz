---
name: create-feature
description: Add a transport-neutral application action as a plugin feature.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, feature, backend, plugin]
---

# Create Feature

Use a feature when application or frontend code should invoke named backend
behavior directly. Use a tool when an agent decides to invoke it, a processor
for event reactions, and a collection for durable state.

```ts
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";
import type { FeatureResource } from "jsr:@copilotz/copilotz@3/features";

const customers: FeatureResource = {
  id: "customers",
  actions: {
    async register(request, { application, namespace }) {
      const input = request.body as { id?: string; email?: string };
      if (!input.email) {
        return { status: 400, data: { error: "email is required" } };
      }

      const result = await application.collections.get("customer").create({
        id: input.id,
        email: input.email,
      }, { namespace });

      return { status: 201, data: { customer: result.value } };
    },
  },
};

export default definePlugin({
  manifest: {
    id: "@acme/customer-features",
    version: "1.0.0",
    provides: { features: [customers.id] },
  },
  resources: { features: [customers] },
});
```

`createEventNativeApp()` dispatches feature requests by resource ID and action
name. The action receives a normalized request and a context containing the
application and resolved tenant namespace. Return `{ status, data }` for an
explicit HTTP-like response, or any value for a `200` response.

Keep transport parsing in channels/fetch adapters, enforce authorization before
dispatch, and mutate through typed domain/collection APIs so state and events
remain atomic.
