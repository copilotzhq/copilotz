# Use Thread Metadata Safely

## When to Use This

Use `thread.metadata` for conversation-scoped or run-scoped state that should
not become part of the user's durable profile.

Recommended primitive: `thread.metadata`  
Most common mistaken alternative: using thread metadata as a general persistence
layer for long-lived user context

## Good Uses

- temporary UI state tied to one thread
- routing or workflow hints for the current conversation
- thread-local notes that help the current run
- conversation-specific flags

## Bad Uses

- long-term user profile data
- durable memory that should survive across threads
- business records that belong in a collection

## Example

```ts
await copilotz.app.handle({
  resource: "threads",
  method: "PATCH",
  path: ["thread-123"],
  body: {
    metadata: {
      journeyStep: "pricing-review",
    },
  },
});
```

## How Copilotz Consumes It

Thread metadata is attached to the thread entity and follows the thread
lifecycle. It is available during runs, but it is scoped to that conversation
context.

## Validation Checklist

- the data is useful only for the current thread
- the data should not appear as global user profile state
- the app can delete or replace the thread without breaking durable state
- participant metadata is used for long-lived user context instead

## Related Pages

- [Persist User Context with Participants](./persist-user-context-with-participants.md)
- [How Threads Work](../runtime/how-threads-work.md)
- [Choose the Right Primitive](../start-here/choose-the-right-primitive.md)
