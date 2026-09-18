# Agent Resource

## What it is

An immutable process-local Agent definition with model and capability selection.

## Why it exists

Agent policy should be declarative while allowing one pure per-turn resolver to
select effective instructions and model routes from a consistent durable
snapshot.

## How to use it

Call `defineAgent` and register the result under `resources.agents`.

## How it works

The helper validates aliases and static data.
`dynamicResolve(context,
execution)` is optional and runs inside Core's
read-only turn snapshot. Its context includes `baseAgent`, the agent
participant, thread, trigger message, and `SnapshotCollections`. It may return
`instructions`, `models`, and an opaque `revision`; omitted values inherit the
authored resource, while a provided model map replaces it. Core captures the
result in the prepared `llm.call` input. The revision is provenance and does not
reset provider session state.
