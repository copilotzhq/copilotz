---
title: Features
description: Resource shape for app-facing backend actions.
section: Resources
order: 40
status: stable
---

# Features

Features are backend actions exposed through the app dispatcher.

Use features when application code owns the call.

## File Shape

```txt
resources/
  features/
    auth/
      login.ts
      callback.ts
```

## Handler Shape

```ts
export default async function login(request: unknown, copilotz: unknown) {
  return { ok: true };
}
```

With `withApp(...)`, this becomes:

```txt
POST /features/auth/login
```

## Related Pages

- [Build a Feature Endpoint](../build-guides/build-feature-endpoint.md)
- [Feature Handler Contract](../reference/feature-handler-contract.md)
