---
name: create-channel
description: Add transport-neutral ingress and egress as a plugin channel.
allowed-tools: [read_file, write_file, list_directory, search_files]
tags: [framework, channel, integration, plugin]
---

# Create Channel

A channel normalizes an external transport into attachment inputs and delivers
attachment outputs back to that transport. It is a plugin resource, not a
filesystem convention.

```ts
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";
import type { ChannelResource } from "jsr:@copilotz/copilotz@3/channels";

const webhook: ChannelResource = {
  id: "webhook",
  defaultAgentIds: ["support"],
  ingress: {
    async handle(request) {
      const body = request.body as {
        threadId: string;
        userId: string;
        text: string;
      };
      return {
        status: 202,
        inputs: [{
          thread: { externalId: body.threadId },
          participant: {
            externalId: body.userId,
            participantType: "human",
          },
          input: { content: body.text },
        }],
      };
    },
  },
  egress: {
    requestBound: false,
    async deliver({ execution }) {
      for await (const output of execution.outputs) {
        await transport.send(output);
      }
    },
  },
};

export default definePlugin({
  manifest: {
    id: "@acme/webhook-channel",
    version: "1.0.0",
    provides: { channels: [webhook.id] },
  },
  resources: { channels: [webhook] },
});
```

Ingress returns one or more envelopes containing `thread`, `participant`,
optional recipients, and the same input accepted by `attachment.send()`. Egress
receives participant-labelled semantic events or readable media streams.

Keep webhook verification and transport normalization at this boundary. Raw
media chunks stay ephemeral; durable transcripts/messages are produced through
the normal attachment workflow.
