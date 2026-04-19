# Persist User Context with Participants

## When to Use This

Use `participant.metadata` when you need durable user profile data or long-term
user context that should remain available across threads and agent turns.

Recommended primitive: `participant.metadata`  
Most common mistaken alternative: creating a separate profile store or using
thread metadata for durable user state

## Minimal Project Layout

No extra resource file is required for the built-in `participant` collection,
but your application code should treat `participant.metadata` as the canonical
app payload for user-owned context.

## Example Read and Write Path

```ts
const participants = copilotz.collections.withNamespace("my-app").participant;

await participants.upsertIdentity({
  externalId: "user-123",
  participantType: "human",
  metadata: {
    purpose: { centralIkigai: "Help small teams ship AI products" },
  },
});
```

## How Copilotz Consumes It

- the built-in `participant` collection stores durable identities
- participant data is graph-backed and namespace-aware
- app code, tools, and features can all access the same participant record

## How It Maps to Endpoints

The built-in participant collection is also reachable through:

- `GET /collections/participant/:id`
- `PUT /collections/participant/:id`

The route identity is based on the participant key behavior, not only on a raw
internal row id.

## Validation Checklist

- durable user context is stored inside `participant.metadata`
- frontend state normalizes to `participant.metadata`, not a nested envelope
- thread-local state remains outside participant metadata
- tools and features read the same participant-backed data
- legacy keys, if present, are preserved intentionally rather than hidden by a
  second profile store

## Related Pages

- [Participant Collection](../reference/participant-collection.md)
- [Use Thread Metadata Safely](./use-thread-metadata-safely.md)
- [How Threads Work](../runtime/how-threads-work.md)
