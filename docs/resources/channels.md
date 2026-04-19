# Channels

Channels connect Copilotz to external ingress and egress systems such as web,
WhatsApp, or Zendesk.

## Where It Lives

```txt
resources/channels/<channel-name>/
  ingress.ts
  egress.ts
```

## What It Is For

Use a channel when Copilotz should receive or deliver messages through an
external transport.

Recommended use case: transport integration  
Most common mistaken alternative: mixing external transport logic directly into
tools or feature handlers

## How Copilotz Consumes It

- channels are loaded into the channel registry
- ingress adapters normalize incoming payloads into Copilotz envelopes
- egress adapters deliver runtime output to the target transport

## Minimal Example

```ts
export default {
  name: "web",
  routes: [],
};
```

## Public Surface

Channels define ingress and egress behavior rather than standard collection or
feature endpoints.

## Related Pages

- [Channels API](../reference/channels-api.md)
- [Serve Copilotz with Oxian](../playbooks/serve-copilotz-with-oxian.md)
- [How Events Work](../runtime/how-events-work.md)
