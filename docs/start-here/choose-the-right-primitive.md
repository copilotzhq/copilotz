# Choose the Right Primitive

The fastest way to keep a Copilotz app clean is to choose the right primitive
before you implement the behavior.

## Quick Decision Guide

Use a `feature` when:

- the frontend or another backend service should call the action directly
- you want the action exposed through the app dispatcher

Use a `tool` when:

- the LLM or agent should decide when to call the action
- the action belongs inside an agent run

Use a `collection` when:

- you need durable application data
- the data should be queryable or reachable through the collection API

Use `participant.metadata` when:

- the data is durable user profile or long-term user context
- both app code and agent logic should be able to read the same user-owned state

Use `thread.metadata` when:

- the data is conversation-local
- the state should not become the user's durable profile

## Recommended Choices

| Need | Recommended Primitive | Most Common Mistake |
| --- | --- | --- |
| frontend button triggers backend action | `feature` | making it a `tool` first |
| agent decides autonomously | `tool` | exposing only a custom route |
| durable business record | `collection` | storing it in thread metadata |
| persistent user profile | `participant.metadata` | inventing a separate profile store |
| thread-local notes or temporary flags | `thread.metadata` | storing it in participant metadata |

## Recommended Use Case

If the action has both an app-facing path and an agent-facing path, split the
concerns cleanly:

- use a `feature` for the direct app contract
- use a `tool` for agent autonomy
- store durable data in `collections` or `participant.metadata`

## Common Mistaken Alternative

Do not use thread metadata as a general persistence layer. Thread metadata is
scoped by conversation and should not replace participant-backed durable state.

## Related Pages

- [Build Backend Endpoints with Features](../playbooks/build-backend-endpoints-with-features.md)
- [Persist User Context with Participants](../playbooks/persist-user-context-with-participants.md)
- [Use Thread Metadata Safely](../playbooks/use-thread-metadata-safely.md)
