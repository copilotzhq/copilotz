---
title: Resource Manifest
description: Manifest format for packaged resources and import selectors.
section: Reference
order: 40
status: stable
---

# Resource Manifest

Resource manifests declare what a resource package provides.

Local resource directories can be discovered without a manifest. Remote resource
packages need a manifest because the loader cannot list remote files.

## Shape

```ts
export default {
  provides: {
    agents: ["support"],
    tools: ["lookup_order"],
    features: ["admin"],
  },
  presets: {
    core: ["agents.support", "tools.lookup_order"],
  },
};
```

## Import Selectors

Selectors use dot notation:

```ts
resources: {
  imports: ["tools.lookup_order", "channels.web"],
}
```

Use `tools` to select all tools from a manifest. Use `tools.name` to select one.

## Related Pages

- [Resource Loading](../runtime/resource-loading.md)
- [Resource Types](../resources/resource-types.md)
