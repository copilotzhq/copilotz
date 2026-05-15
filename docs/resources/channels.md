---
title: Channels
description: Ingress and egress adapters for external transports.
section: Resources
order: 60
status: draft
---

# Channels

Channels connect Copilotz to external transports.

Built-in channel families include:

- web
- WhatsApp
- Zendesk
- Discord
- Telegram

## What Channels Do

Ingress adapters normalize external messages into Copilotz messages.

Egress adapters deliver Copilotz responses back to the external transport.

## When to Use Channels

Use a channel when the app needs transport-specific behavior.

Do not put WhatsApp, Telegram, or Zendesk protocol logic inside ordinary tools
or agent instructions.

## Related Pages

- [Server Helpers and Channels](../app-integration/server-helpers-and-channels.md)
- [Resource Types](./resource-types.md)
