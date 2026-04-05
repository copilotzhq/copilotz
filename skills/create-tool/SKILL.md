---
name: create-tool
description: Create a custom tool with config and execute files for Copilotz agents.
allowed-tools: [read_file, write_file, list_directory]
tags: [framework, tool]
---

# Create Tool

Create a custom tool that agents can invoke.

## Directory Structure

```
resources/tools/{tool-name}/
  config.ts     # Required: tool definition (schema, description)
  execute.ts    # Required: tool implementation
```

## Step 1: Create config.ts

Define the tool's metadata and input/output schemas.

```typescript
import type { Tool } from "copilotz";

const config: Omit<Tool, "execute"> = {
    id: "my-tool",
    name: "My Tool",
    description: "What this tool does — be specific, the LLM reads this.",
    inputSchema: {
        type: "object",
        properties: {
            param1: {
                type: "string",
                description: "Description of param1",
            },
            param2: {
                type: "number",
                description: "Description of param2",
                default: 10,
            },
        },
        required: ["param1"],
    },
    // Optional: control how tool results appear in chat history
    historyPolicy: {
        visibility: "public_result",  // "requester_only" | "public_result" | "public_full"
        projector: (input, output) => {
            return `Tool completed for ${input.param1}`;
        },
    },
};

export default config;
```

## Step 2: Create execute.ts

Implement the tool logic. The function receives input params and a context object.

```typescript
import type { ToolExecutionContext } from "copilotz";

interface Input {
    param1: string;
    param2?: number;
}

export default async function execute(
    input: Input,
    context: ToolExecutionContext,
): Promise<unknown> {
    const { param1, param2 = 10 } = input;
    const { threadId, namespace, db } = context;

    // Your implementation here
    const result = await doSomething(param1, param2);

    return { success: true, data: result };
}
```

## Context Object

The `ToolExecutionContext` provides:

| Field | Type | Description |
|-------|------|-------------|
| `threadId` | string | Current conversation thread |
| `namespace` | string | Active namespace for multi-tenancy |
| `db` | CopilotzDb | Database instance |
| `senderId` | string | Agent or user who triggered the tool |
| `agents` | Agent[] | Available agents |

## History Policy

Controls how tool calls and results appear in chat history for other agents:

- `requester_only`: Only the calling agent sees results
- `public_result`: All agents see a projected summary
- `public_full`: All agents see full input and output

Use `projector` with `public_result` for compact summaries.

## Notes

- The directory name becomes the tool's `id` by default
- Agents access tools via `allowedTools: ["my-tool"]`
- Tool is auto-loaded when `resources.path` is set
