# Thread and Message APIs

Threads and messages are the primary app-facing conversation APIs.

## Thread Routes

Typical thread routes include:

- `GET /threads`
- `POST /threads`
- `GET /threads/:id`
- `PATCH /threads/:id`

## Message Routes

Typical message routes include:

- `GET /threads/:id/messages`
- `POST /threads/:id/messages`
- transport-specific ingress paths depending on the application shell

## Recommended Use Case

Use these APIs as the conversation transport and history layer for your app.

## Common Mistaken Alternative

Do not force durable profile state into thread routes when it belongs on the
participant or collection side.

## Related Pages

- [How Threads Work](../runtime/how-threads-work.md)
- [Use Thread Metadata Safely](../playbooks/use-thread-metadata-safely.md)
- [Connect a React UI](../playbooks/connect-a-react-ui.md)
