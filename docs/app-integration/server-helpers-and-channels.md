---
title: Server Helpers and Channels
description: Wire Copilotz to HTTP frameworks and external transports.
section: App Integration
order: 20
status: draft
---

# Server Helpers and Channels

Copilotz is framework-agnostic.

Use `withApp(...)` when you want one dispatcher. Use server helper factories
when you want individual handler families.

## Handler Families

The server export includes handlers for:

- threads
- messages
- events
- assets
- collections
- participants
- graph
- channels

## Channels

Channels adapt external transports into Copilotz messages and deliver responses
back to those transports.

Use channels for web, WhatsApp, Zendesk, Discord, Telegram, or custom transport
work.

## Related Pages

- [withApp](./with-app.md)
- [Channels](../resources/channels.md)
