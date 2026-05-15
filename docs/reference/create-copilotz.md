---
title: createCopilotz
description: Bootstrap a Copilotz runtime from resources, agents, providers, storage, data, and runtime options.
section: Reference
order: 10
status: draft
---

# createCopilotz

`createCopilotz(config)` creates a Copilotz runtime.

```ts
const copilotz = await createCopilotz(config);
```

## Common Config

```ts
{
  agents: [agent],
  tools: [tool],
  resources: {
    path: "./resources",
    imports: ["tools.get_current_time"],
    preset: ["rag"],
  },
  dbConfig: { url: ":memory:" },
  namespace: "tenant-acme",
  stream: true,
}
```

## Instance Methods

The returned instance includes:

- `run(message, options)`
- `goal(options)`
- `start(initialMessageOrOptions)`
- `shutdown()`
- `assets`
- `collections`
- `schema`
- `db`
- `ops`
- `config`

## Related Pages

- [Run API](./run-api.md)
- [Goal API](./goal-api.md)
- [Resource Loading](../runtime/resource-loading.md)
