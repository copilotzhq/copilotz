# Channels API

Channels define how Copilotz receives and delivers messages through external
transports.

## Main Concepts

- ingress adapters normalize inbound traffic
- egress adapters deliver outbound payloads
- channel routes describe how the external transport maps into runtime behavior

## Recommended Use Case

Use channels when Copilotz should integrate with a transport like web,
WhatsApp, or Zendesk.

## Common Mistaken Alternative

Do not build transport-specific behavior into ordinary tools or features when it
belongs at the channel boundary.

## Related Pages

- [Channels](../resources/channels.md)
- [How Events Work](../runtime/how-events-work.md)
- [Serve Copilotz with Oxian](../playbooks/serve-copilotz-with-oxian.md)
