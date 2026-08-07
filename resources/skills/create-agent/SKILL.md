---
name: create-agent
description: Define a text/realtime agent as a plugin resource.
allowed-tools: [read_file, write_file, list_directory, search_files]
tags: [framework, agent, plugin]
---

# Create Agent

Agents are ordinary logical resources. Define them in a plugin for reuse or in
top-level `resources.agents` for an application-local override. Copilotz does
not infer IDs or scan directories.

```ts
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";
import type { Agent } from "jsr:@copilotz/copilotz@3/resources";

const support: Agent = {
  id: "support",
  name: "Support",
  role: "Resolve customer questions clearly and safely.",
  instructions: `
Use the available tools when they improve accuracy.
Ask a specialist publicly when their expertise is needed.
  `.trim(),
  runtimes: {
    text: { type: "llm", provider: "openai", model: "gpt-5-mini" },
    realtime: {
      type: "realtime",
      provider: "acme-realtime",
      voice: "alloy",
    },
  },
  allowedTools: ["lookup_customer", "ask"],
  allowedAgents: ["billing"],
};

export default definePlugin({
  manifest: {
    id: "@acme/support-agents",
    version: "1.0.0",
    provides: { agents: [support.id] },
  },
  resources: { agents: [support] },
});
```

`llmOptions` remains shorthand/configuration for `runtimes.text`; runtime
selection belongs in `runtimes`. Inject API keys and dynamic model policy at the
application/provider boundary instead of persisting secrets in the agent.

The stable agent ID is not the participant ID. A thread contains participant
records whose `agentId` points to the agent resource. Multi-agent communication
uses the public `ask` tool and requires target agent participants in the same
thread.
