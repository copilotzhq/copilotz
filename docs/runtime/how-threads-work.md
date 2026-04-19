# How Threads Work

Threads are the unit of conversation and session state in Copilotz.

## What a Thread Holds

- messages
- participants
- thread metadata
- event and run context tied to that conversation

## Why Threads Matter

Threads let Copilotz scope execution and history to one conversation. They are
the right place for conversation-local metadata and chat state.

## Important Boundary

Thread metadata is not the user's durable profile. Use thread metadata for
conversation-local state, and use `participant.metadata` or collections for
durable state.

## Public Surface

Threads are exposed through the app layer, including:

- `GET /threads`
- `POST /threads`
- `GET /threads/:id`
- `PATCH /threads/:id`

## Related Pages

- [Use Thread Metadata Safely](../playbooks/use-thread-metadata-safely.md)
- [Thread and Message APIs](../reference/thread-and-message-apis.md)
- [How Events Work](./how-events-work.md)
