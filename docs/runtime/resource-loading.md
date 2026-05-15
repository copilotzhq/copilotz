---
title: Resource Loading
description: How createCopilotz loads bundled, file-based, and explicit resources.
section: Runtime
order: 30
status: stable
---

# Resource Loading

`createCopilotz(...)` builds the runtime from resource layers.

## Layers

1. bundled Copilotz resources
2. resources from `resources.path`
3. explicit config resources
4. filters, overrides, and base agent config

Explicit project resources win on ID/name collisions.

## Bundled Imports

Bundled tools, channels, providers, and other resources can be selected with
dot-notation imports.

```ts
resources: {
  imports: ["tools.get_current_time", "channels.web"],
}
```

## File-Based Resources

```ts
const copilotz = await createCopilotz({
  resources: { path: "./resources" },
  agents: [agent],
});
```

For local directories, Copilotz can discover standard folders. For remote
packages, a manifest is required.

## Presets

Presets are named groups declared by a resource manifest.

```ts
resources: {
  path: "jsr:@copilotz/some-package",
  preset: ["core"],
}
```

## Related Pages

- [Resources](../core-concepts/resources.md)
- [Resource Manifest](../reference/resource-manifest.md)
