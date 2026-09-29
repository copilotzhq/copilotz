# Agent Resource

## What it is

An immutable process-local Agent definition with model and capability selection.

## Why it exists

Agent policy should be declarative while allowing one pure per-turn resolver to
select effective instructions and model routes from a consistent durable
snapshot.

## How to use it

Call `defineAgent` and register the result under `resources.agents`.

Set `history.maxAgeMs` to bound conversation history by age. Core includes
Messages created at or after the trigger time minus this limit; the limit is
inclusive and uses the durable trigger timestamp, so retries use the same age
boundary. Omit `history` to keep the complete authorized history. A resolver may
return `history` to select a per-turn limit:

```ts
defineAgent({
  id: "assistant",
  name: "Assistant",
  role: "helper",
  models: { generate: [{ connection: "default", model: "default" }] },
  history: { maxAgeMs: 24 * 60 * 60 * 1_000 },
  dynamicResolve: ({ triggerMessage }) =>
    triggerMessage.metadata.urgent === true
      ? { history: { maxAgeMs: 60 * 60 * 1_000 } }
      : undefined,
});
```

## How it works

The helper validates aliases and static data.
`dynamicResolve(context,
execution)` is optional and runs inside Core's
read-only turn snapshot. Its context includes `baseAgent`, the agent
participant, thread, trigger message, and `SnapshotCollections`. It may return
`instructions`, `models`, `history`, and an opaque `revision`; omitted values
inherit the authored resource, while a provided model map or history policy
replaces it. Core captures the result in the prepared `llm.call` input. The
revision is provenance and does not reset provider session state.
