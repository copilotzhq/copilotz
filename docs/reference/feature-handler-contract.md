---
title: Feature Handler Contract
description: Request and return shape for feature action handlers.
section: Reference
order: 50
status: draft
---

# Feature Handler Contract

A feature action is a default-exported function.

```ts
export default async function action(request: unknown, copilotz: unknown) {
  return { ok: true };
}
```

It lives under:

```txt
resources/features/<feature>/<action>.ts
```

With `withApp(...)`, the action is reachable through:

```txt
/features/<feature>/<action>
```

## Guidance

Return JSON-serializable data.

Keep the feature contract app-owned. If the model should choose when to execute
the behavior, make a tool instead.

## Related Pages

- [Features](../resources/features.md)
- [withApp](../app-integration/with-app.md)
