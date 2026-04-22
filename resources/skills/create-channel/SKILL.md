---
name: create-channel
description: Add a transport channel with ingress and egress adapters.
allowed-tools: [read_file, write_file, list_directory, search_files]
tags: [framework, channel, integration]
---

# Create Channel

Use a channel when Copilotz should receive or deliver messages through an
external transport such as web, WhatsApp, or Zendesk.

## When To Use It

- Use a `channel` for ingress and egress at the transport boundary.
- Prefer a channel over a feature or tool when the problem is message delivery
  or normalization.
- Do not mix transport-specific behavior into ordinary tools or features.

## Directory Structure

```txt
resources/channels/{channel-name}/
  ingress.ts
  egress.ts
```

## Step 1: Design The Channel Boundary

Define:

- what inbound payloads look like
- how they map into Copilotz envelopes or runtime events
- what outbound runtime payloads must be sent back to the transport

## Step 2: Create `ingress.ts`

```typescript
export default {
  name: "my-channel",
  routes: [
    {
      method: "POST",
      path: "/webhook",
      handler: async (request, copilotz) => {
        const body = await request.json();

        return {
          type: "NEW_MESSAGE",
          payload: {
            content: body.text,
            sender: {
              type: "user",
              id: body.userId,
              name: body.userName ?? "User",
            },
            threadId: body.threadId,
          },
        };
      },
    },
  ],
};
```

## Step 3: Create `egress.ts`

```typescript
export default {
  name: "my-channel",
  send: async (payload, context) => {
    console.log("Sending outbound payload", { payload, context });
  },
};
```

## How Copilotz Consumes It

- channels are loaded into the channel registry
- ingress adapters normalize incoming traffic into Copilotz runtime input
- egress adapters deliver runtime output back to the transport

## Common Mistakes

- Putting transport auth or webhook parsing inside tools
- Treating channels like app-facing features
- Forgetting that ingress and egress are different responsibilities

## Notes

- Keep normalization logic explicit and deterministic.
- Reuse existing runtime helpers or built-in channels as references when
  possible.
