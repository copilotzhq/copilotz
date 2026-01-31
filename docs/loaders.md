# Resource Loaders

Resource loaders let you organize agents, tools, APIs, and processors in a filesystem structure. This is useful for larger projects where configuration-as-code becomes unwieldy.

## Why Loaders?

As your AI application grows, managing everything in a single config object gets messy:
- Agents have long instruction prompts
- Custom tools have complex logic
- Multiple API integrations need organization
- Event processors need testing independently

Loaders let you organize resources in a clean directory structure with proper separation of concerns.

## Directory Structure

```
resources/
├── agents/
│   ├── support-agent/
│   │   ├── instructions.md      # System prompt (required)
│   │   └── config.ts            # Agent configuration
│   └── research-agent/
│       ├── instructions.md
│       └── config.ts
├── tools/
│   ├── analyze-sentiment/
│   │   ├── config.ts            # Tool definition (required)
│   │   └── execute.ts           # Tool implementation (required)
│   └── generate-report/
│       ├── config.ts
│       └── execute.ts
├── apis/
│   ├── github/
│   │   ├── openApiSchema.json   # OpenAPI spec (required)
│   │   └── config.ts            # API configuration
│   └── stripe/
│       ├── openApiSchema.json
│       └── config.ts
└── event-processors/
    ├── NEW_MESSAGE/
    │   └── processor.ts         # Custom processor
    └── CUSTOM_EVENT/
        └── processor.ts
```

## Usage

```typescript
import { loadResources, createCopilotz } from "@copilotz/copilotz";

// Load resources from directory
const resources = await loadResources({ path: "./resources" });

// Create Copilotz with loaded resources
const copilotz = await createCopilotz({
  agents: resources.agents,
  tools: resources.tools,
  apis: resources.apis,
  processors: resources.processors,
  dbConfig: { url: ":memory:" },
});
```

## Agent Files

### instructions.md (Required)

The system prompt for the agent, written in Markdown:

```markdown
# Support Agent

You are a helpful customer support agent for Acme Corp.

## Guidelines

- Be friendly and professional
- If you don't know something, say so
- Escalate complex issues to @Technical

## Common Questions

- **Billing**: Direct to the billing portal
- **Technical**: Use @Technical for help
- **Returns**: 30-day return policy
```

### config.ts

Agent configuration (without instructions, which come from the markdown file):

```typescript
import type { Agent } from "@copilotz/copilotz";

const config: Partial<Agent> = {
  id: "support-agent",
  name: "Support",
  role: "assistant",
  llmOptions: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.3,
  },
  allowedTools: ["search_knowledge", "create_ticket"],
  allowedAgents: ["technical-agent"],
  ragOptions: {
    mode: "auto",
    namespaces: ["support-docs", "faq"],
  },
};

export default config;
```

## Tool Files

### config.ts (Required)

Tool definition:

```typescript
import type { Tool } from "@copilotz/copilotz";

const config: Omit<Tool, "execute"> = {
  id: "analyze-sentiment",
  name: "Analyze Sentiment",
  description: "Analyze the sentiment of text",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "The text to analyze",
      },
    },
    required: ["text"],
  },
  outputSchema: {
    type: "object",
    properties: {
      sentiment: {
        type: "string",
        enum: ["positive", "negative", "neutral"],
      },
      confidence: {
        type: "number",
      },
    },
  },
};

export default config;
```

### execute.ts (Required)

Tool implementation:

```typescript
import type { ToolExecutionContext } from "@copilotz/copilotz";

interface Input {
  text: string;
}

interface Output {
  sentiment: "positive" | "negative" | "neutral";
  confidence: number;
}

export default async function execute(
  input: Input,
  context: ToolExecutionContext
): Promise<Output> {
  const { text } = input;
  const { threadId, namespace, db } = context;
  
  // Your sentiment analysis logic
  const result = await analyzeSentiment(text);
  
  return {
    sentiment: result.label,
    confidence: result.score,
  };
}
```

## API Files

### openApiSchema.json (Required)

Standard OpenAPI 3.0 specification:

```json
{
  "openapi": "3.0.0",
  "info": {
    "title": "GitHub API",
    "version": "1.0.0"
  },
  "servers": [
    { "url": "https://api.github.com" }
  ],
  "paths": {
    "/repos/{owner}/{repo}": {
      "get": {
        "operationId": "getRepository",
        "summary": "Get a repository",
        "parameters": [
          { "name": "owner", "in": "path", "required": true },
          { "name": "repo", "in": "path", "required": true }
        ]
      }
    }
  }
}
```

### config.ts

API configuration (the `openApiSchema` is loaded automatically from `openApiSchema.json`):

```typescript
import type { API } from "@copilotz/copilotz";

const config: Omit<API, "openApiSchema"> = {
  id: "github",
  name: "GitHub API",
  baseUrl: "https://api.github.com",
  auth: {
    type: "bearer",
    token: Deno.env.get("GITHUB_TOKEN"),
  },
};

export default config;
```

## Processor Files

### processor.ts (Required)

Custom event processor:

```typescript
import type { EventProcessor, ProcessorDeps } from "@copilotz/copilotz";

const processor: EventProcessor = {
  eventType: "NEW_MESSAGE",
  
  shouldProcess: (event, deps: ProcessorDeps) => {
    // Only process messages with specific metadata
    return event.payload.metadata?.requiresModeration === true;
  },
  
  process: async (event, deps: ProcessorDeps) => {
    const { db, thread, context } = deps;
    
    // Your custom processing logic
    const isAppropriate = await moderateContent(event.payload.content);
    
    if (!isAppropriate) {
      return {
        producedEvents: [{
          type: "NEW_MESSAGE",
          payload: {
            content: "This message was flagged for review.",
            sender: { type: "system", name: "Moderator" },
          },
        }],
      };
    }
    
    // Let default processor handle it
    return { producedEvents: [] };
  },
};

export default processor;
```

## Loading Options

```typescript
const resources = await loadResources({
  path: "./resources",
  // Future options...
});
```

## Combining with Inline Config

You can combine loaded resources with inline configuration:

```typescript
const resources = await loadResources({ path: "./resources" });

const copilotz = await createCopilotz({
  // Loaded resources
  agents: resources.agents,
  tools: resources.tools,
  apis: resources.apis,
  processors: resources.processors,
  
  // Additional inline config
  tools: [
    ...resources.tools,
    {
      id: "inline-tool",
      // ...
    },
  ],
  
  dbConfig: { url: ":memory:" },
  rag: { ... },
});
```

## Best Practices

1. **Use instructions.md for prompts** — Markdown is easier to read and edit than embedded strings.

2. **Keep execute.ts focused** — Tool implementations should do one thing well.

3. **Version control** — The directory structure works great with git.

4. **Testing** — Import and test processors independently:

```typescript
import processor from "./resources/event-processors/NEW_MESSAGE/processor.ts";

Deno.test("processor filters flagged messages", async () => {
  const event = { payload: { metadata: { requiresModeration: true } } };
  const shouldProcess = processor.shouldProcess(event, mockDeps);
  assertEquals(shouldProcess, true);
});
```

5. **Environment-specific configs** — Use environment variables in config files for secrets.

## Next Steps

- [Agents](./agents.md) — Agent configuration options
- [Tools](./tools.md) — Creating custom tools
- [Events](./events.md) — Custom event processors
