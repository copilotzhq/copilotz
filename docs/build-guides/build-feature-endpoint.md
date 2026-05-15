---
title: Build a Feature Endpoint
description: Use features for app-owned backend behavior exposed through withApp.
section: Build Guides
order: 40
status: draft
---

# Build a Feature Endpoint

Use a feature when frontend or backend code should call behavior directly.

Features are not model tools. They are app endpoints.

## File Shape

```txt
resources/
  features/
    qa/
      start.ts
```

## Handler Shape

```ts
export default async function startQa(request: unknown, copilotz: unknown) {
  return {
    status: "queued",
  };
}
```

With `withApp(...)`, the action is reachable as:

```txt
POST /features/qa/start
```

## When to Use This

Use a feature for:

- login or OAuth callbacks
- report generation
- user profile updates
- starting background jobs
- starting a `copilotz.goal(...)` run from an endpoint

## Related Pages

- [withApp](../app-integration/with-app.md)
- [Feature Handler Contract](../reference/feature-handler-contract.md)
- [Choose the Right Primitive](../start-here/choose-the-right-primitive.md)
