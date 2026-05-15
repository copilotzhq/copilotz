---
title: withApp
description: Attach Copilotz's framework-agnostic app dispatcher.
section: App Integration
order: 10
status: stable
---

# withApp

`withApp(...)` attaches an app dispatcher to a Copilotz runtime.

It exposes threads, messages, collections, assets, graph, events, agents,
channels, and features through one framework-agnostic request shape.

## Basic Use

```ts
import { createCopilotz } from "@copilotz/copilotz";
import { withApp } from "@copilotz/copilotz/server";

const runtime = await createCopilotz({
  agents: [agent],
  resources: { path: "./resources" },
});

const copilotz = withApp(runtime);
```

## Dispatch

```ts
const response = await copilotz.app.handle({
  resource: "features",
  method: "POST",
  path: ["qa", "start"],
  body: { profileId: "client-01" },
});
```

## Response Shape

App responses use:

```ts
{
  status: number;
  data?: unknown;
  pageInfo?: unknown;
}
```

HTTP adapters should serialize this as `{ data, pageInfo? }`.

## Related Pages

- [Build a Feature Endpoint](../build-guides/build-feature-endpoint.md)
- [Feature Handler Contract](../reference/feature-handler-contract.md)
