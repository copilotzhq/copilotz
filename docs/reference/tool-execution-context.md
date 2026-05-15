---
title: Tool Execution Context
description: Runtime context passed to custom tool execute handlers.
section: Reference
order: 60
status: draft
---

# Tool Execution Context

Custom tools receive arguments and an optional runtime context.

```ts
execute: (async (args, context) => {
  // use args and context
});
```

The context can expose useful runtime capabilities such as:

- database access
- collections
- thread information
- namespace and schema context
- assets
- runtime configuration

Exact fields depend on runtime version and processor path. Treat the context as
the bridge from model-selected actions into application infrastructure.

## Related Pages

- [Create a Custom Tool](../build-guides/create-custom-tool.md)
- [Tools](../resources/tools.md)
