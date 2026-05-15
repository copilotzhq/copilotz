---
title: Collections
description: Resource shape for typed application data.
section: Resources
order: 50
status: draft
---

# Collections

Collections define application-specific data.

Use them for product entities that need persistence and namespace support.

## Code Shape

```ts
import { defineCollection } from "@copilotz/copilotz";

export default defineCollection({
  name: "booking",
  schema: {
    type: "object",
    properties: {
      passengerName: { type: "string" },
      status: { type: "string" },
    },
    required: ["passengerName"],
  },
});
```

## Consumed By

Collections can be used from:

- app code
- feature handlers
- tool execution context
- processors
- server collection endpoints

## Related Pages

- [Persist Data with Collections](../build-guides/persist-data-with-collections.md)
- [Data and Tenancy](../core-concepts/data-and-tenancy.md)
