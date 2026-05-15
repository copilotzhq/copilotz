---
title: React UI
description: Connect a frontend to Copilotz threads, messages, events, and assets.
section: App Integration
order: 30
status: draft
---

# React UI

A Copilotz frontend usually needs four things:

- list or create threads
- send messages
- stream or poll events
- render assets

The recommended path is to use Copilotz server/app endpoints behind your web
framework, then connect the UI to those endpoints.

## Typical Flow

1. create or select a thread
2. send a user message
3. stream events from the run or event endpoint
4. render `NEW_MESSAGE` events from agents
5. fetch asset data for `asset://...` references when needed

## Display Rule

For chat output, display agent messages.

```ts
event.type === "NEW_MESSAGE" && event.payload.sender?.type === "agent";
```

For debugging or admin views, show tool calls, tool results, LLM events, and
asset events separately.

## Related Pages

- [Events](../core-concepts/events.md)
- [Threads and Messages](../core-concepts/threads-and-messages.md)
- [withApp](./with-app.md)
