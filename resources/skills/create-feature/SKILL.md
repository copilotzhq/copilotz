---
name: create-feature
description: Add an app-facing backend feature action for frontend or service calls.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, feature, backend]
---

# Create Feature

Use a feature when application code should call backend behavior directly
through a request/response endpoint.

## When To Use It

- Use a `feature` for app-facing backend actions with a clear request contract.
- Prefer a feature over a tool when the caller is your frontend or another
  service.
- Do not hide ordinary application endpoints inside tools unless the model needs
  to decide when to call them.

## Directory Structure

```txt
resources/features/{feature-name}/{action}.ts
```

Each file becomes a dispatcher endpoint at `/features/{feature-name}/{action}`
when `withApp(...)` is enabled.

## Step 1: Choose The Boundary

Before creating the file, confirm the behavior belongs in a feature:

- `feature`: app or service calls it directly
- `tool`: an agent decides whether to call it
- `processor`: it belongs in the event pipeline
- `collection`: it is durable state, not behavior

## Step 2: Create The Action File

```typescript
export default async function registerCustomer(request, copilotz) {
  const body = (request.body ?? {}) as { email?: string; name?: string };

  if (!body.email) {
    return {
      status: 400,
      data: { error: "email is required" },
    };
  }

  const customers = copilotz.collections?.customer;
  const created = await customers?.create({
    id: crypto.randomUUID(),
    email: body.email,
    name: body.name ?? "Unknown",
  });

  return {
    status: 201,
    data: { customer: created },
  };
}
```

## Handler Contract

The default export receives:

- a request-like object with `method`, `body`, `query`, `headers`, and optional
  `context`
- the `copilotz` instance

It may return:

- an object with `status` and `data`
- or any value the dispatcher should wrap as `data`

## How Copilotz Consumes It

- features are loaded during `createCopilotz(...)`
- `withApp(...)` exposes them as dispatcher routes
- the resource family is `features`

## Common Mistakes

- Using a feature when the LLM should decide whether to invoke the behavior
- Putting transport-specific ingress logic in a feature instead of a channel
- Treating a collection as if it were an endpoint layer

## Notes

- Keep feature handlers focused on backend application contracts.
- If multiple actions belong to the same business area, group them under one
  feature directory.
