---
name: create-memory
description: Configure built-in long-term memory or add a prompt-memory plugin resource.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, memory, context, plugin]
---

# Create Memory

For durable conversational memory, configure the built-in memory plugin:

```ts
const app = await createCopilotz({
  core: {
    memory: {
      enabled: true,
      config: {
        triggerEstimatedTokens: 12_000,
        retainRecentEstimatedTokens: 4_000,
      },
    },
  },
});
```

The built-in plugin owns graph collections, consolidation deliveries, retrieval,
and prompt contribution. Customize it through `core.memory`, including injected
LLM/embedding/consolidation functions, instead of duplicating its processors.

For a distinct reusable prompt contribution, add a `memory` resource:

```ts
import { definePlugin } from "jsr:@copilotz/copilotz@3/plugins";
import type { WorkflowPromptMemoryResource } from "jsr:@copilotz/copilotz@3/workflows";

const accountContext: WorkflowPromptMemoryResource = {
  id: "acme.account-context",
  name: "account-context",
  kind: "account",
  enabled: true,
  async contribute({ participant, context }) {
    const account = await context.collections.account.get(participant.id);
    if (!account) return null;
    return {
      resourceId: "acme.account-context",
      section: `Account context: ${JSON.stringify(account)}`,
    };
  },
};

export default definePlugin({
  manifest: {
    id: "@acme/account-memory",
    version: "1.0.0",
    provides: { memory: [accountContext.id!] },
  },
  resources: { memory: [accountContext] },
});
```

Memory resources compose prompt context; processors perform durable reactions.
Store large bodies as canonical assets, keep tenant/participant scope explicit,
and test retries plus prompt-size limits.
