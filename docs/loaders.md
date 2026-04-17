# Resource Loaders

Resource loaders let you organize agents, tools, APIs, processors, skills, and more in a filesystem structure. This is useful for larger projects where configuration-as-code becomes unwieldy.

## Recommended: Built-in Resource Loading

The simplest way to use file-based resources is via the `resources.path` option in `createCopilotz`. This loads and merges everything automatically, while bundled/native resources come from presets:

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  resources: {
    path: "./resources",
    preset: ["core", "code"],
    imports: ["channels.whatsapp"],
  },
  dbConfig: { url: Deno.env.get("DATABASE_URL") },
});
```

When `resources.path` is set, `createCopilotz` internally calls `loadResources` and merges the results with any explicit config arrays. See [Configuration — Resources](./configuration.md#resources) for merge semantics.

## Why Loaders?

As your AI application grows, managing everything in a single config object gets messy:
- Agents have long instruction prompts
- Custom tools have complex logic
- Multiple API integrations need organization
- Processors and skills need testing independently

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
├── processors/
│   ├── NEW_MESSAGE/
│   │   └── processor.ts         # Custom processor
│   └── CUSTOM_EVENT/
│       └── processor.ts
└── skills/
    ├── my-skill/
    │   ├── SKILL.md              # Skill instructions (required)
    │   └── references/           # Optional reference files
    └── another-skill/
        └── SKILL.md
```

## Low-Level Usage with `loadResources()`

If you need more control over the loaded resources before passing them to `createCopilotz`, use `loadResources()` directly:

```typescript
import { loadResources, createCopilotz } from "@copilotz/copilotz";

// Load resources from directory
const resources = await loadResources({
  path: "./resources",
  imports: ["agents", "tools.read_file", "channels.whatsapp"],
});

// Inspect or transform before passing to createCopilotz
console.log(`Loaded ${resources.agents.length} agents`);

const copilotz = await createCopilotz({
  agents: resources.agents,
  tools: resources.tools,
  apis: resources.apis,
  processors: resources.processors,
  dbConfig: { url: ":memory:" },
});
```

> **Tip**: For most projects, `resources.path` in `createCopilotz` is simpler and handles the merge automatically. Use `loadResources()` when you need to inspect, filter, or transform resources before initialization.

## Presets and Imports

`loadResources()` and `createCopilotz({ resources: ... })` support the same two selectors:

- `preset`: named import groups declared by a manifest
- `imports`: dot-notation selectors such as `tools`, `tools.read_file`, `channels`, `channels.whatsapp`

Selectors are additive. For bundled resources, `createCopilotz` always includes `core`, so `preset: ["code"]` behaves like `["core", "code"]`.

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
  assetOptions: {
    produce: {
      persistGeneratedAssets: false,
    },
  },
};

export default config;
```

`assetOptions.produce.persistGeneratedAssets` is useful in loader-based projects when an agent or its tool calls may produce large inline assets that you do not want persisted into the shared asset store or conversation history.

## Tool Files

### config.ts (Preferred)

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
  historyPolicy: {
    visibility: "public_result",
    projector: ({ text }, output) => {
      const result = output as { sentiment: string; confidence: number };
      return `Sentiment analyzed for ${text.length} characters: ${result.sentiment} (${result.confidence})`;
    },
  },
};

export default config;
```

`historyPolicy` is especially useful in loader-based projects because it lives in `config.ts`, so you can keep the projector callback in code.

### execute.ts (Preferred)

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

### index.ts (Supported Fallback)

Tools can also be packaged as a single `index.ts` that exports the full tool
object, including `execute`:

```typescript
export default {
  key: "analyze-sentiment",
  name: "Analyze Sentiment",
  description: "Analyze the sentiment of text",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
  },
  async execute(input, context) {
    return {
      sentiment: "positive",
      confidence: 0.98,
    };
  },
};
```

When both formats are present, Copilotz prefers `config.ts` + `execute.ts` and
falls back to `index.ts` only when the split files are absent.

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
  historyPolicyDefaults: {
    visibility: "requester_only",
  },
  toolPolicies: {
    getRepository: {
      visibility: "public_result",
      projector: (_args, output) => {
        const repo = output as { full_name?: string };
        return `Repository loaded: ${repo.full_name}`;
      },
    },
  },
};

export default config;
```

`toolPolicies` are keyed by the generated tool key, which is usually the OpenAPI `operationId`.

## Processor Files

Place processor directories under `processors/` named by event type (e.g. `processors/NEW_MESSAGE/processor.ts`).

### processor.ts (Required)

Custom event processor:

```typescript
import type { EventProcessor, ProcessorDeps } from "@copilotz/copilotz";

const processor: EventProcessor = {
  eventType: "NEW_MESSAGE",
  
  shouldProcess: (event, deps: ProcessorDeps) => {
    return event.payload.metadata?.requiresModeration === true;
  },
  
  process: async (event, deps: ProcessorDeps) => {
    const { db, thread, context } = deps;
    
    const isAppropriate = await moderateContent(event.payload.content);
    
    if (!isAppropriate) {
      // Claim: replace the event with a system message
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
    
    // Pass: let the next processor (built-in) handle it
    return;
  },
};

export default processor;
```

### Return semantics

Processors are executed in priority order (user-defined first, built-in last). The first processor whose `process` returns a `producedEvents` array claims the event:

| Return value | Behavior |
|---|---|
| `{ producedEvents: [event, ...] }` | **Claim** — enqueue events, skip remaining processors |
| `{ producedEvents: [] }` | **Swallow** — claim without producing anything |
| `void` / `undefined` | **Pass** — fall through to the next processor |

This lets you override, suppress, or observe any built-in behavior. See [Events — Return Semantics](./events.md#return-semantics) for more detail.

## Skill Files

Place skill directories under `skills/`. Each directory must contain a `SKILL.md` file and optionally a `references/` folder:

```
resources/skills/my-skill/
├── SKILL.md                # Frontmatter (name, description) + instructions body
└── references/             # Optional reference files the skill can load
    └── example.json
```

Skills loaded from the resources directory use progressive disclosure: only names and descriptions are sent to the LLM initially; full instructions are fetched on-demand via the `load_skill` tool. See [Skills](./skills.md) for the full format.

## Loading Options

```typescript
const resources = await loadResources({
  path: "./resources",               // string or string[] for multiple directories
  preset: ["core", "rag"],          // optional manifest-defined preset names
  imports: ["tools.read_file"],     // optional dot-notation selectors
});
```

## Combining with Inline Config

The recommended way to combine file-loaded and inline resources is via `resources.path`:

```typescript
const copilotz = await createCopilotz({
  resources: {
    path: "./resources",
    preset: ["core", "code"],
    filterResources: (resource, type) =>
      !(type === "tool" && resource.id === "persistent_terminal"),
  },

  // Explicit items are merged with file-loaded ones:
  // - Appended by default
  // - Override on ID collision (matched by id, key, or name)
  tools: [myInlineTool],
  agents: [{ id: "assistant", instructions: "Override file-loaded assistant" }],

  dbConfig: { url: ":memory:" },
});
```

If you need manual control, use `loadResources()` with `mergeResourceArrays`:

```typescript
import { loadResources, createCopilotz, mergeResourceArrays } from "@copilotz/copilotz";

const resources = await loadResources({ path: "./resources" });

const copilotz = await createCopilotz({
  agents: resources.agents,
  tools: mergeResourceArrays(resources.tools, [myInlineTool]),
  apis: resources.apis,
  processors: resources.processors,
  dbConfig: { url: ":memory:" },
});
```

## Best Practices

1. **Use instructions.md for prompts** — Markdown is easier to read and edit than embedded strings.

2. **Keep execute.ts focused** — Tool implementations should do one thing well.

3. **Version control** — The directory structure works great with git.

4. **Testing** — Import and test processors independently:

```typescript
import processor from "./resources/processors/NEW_MESSAGE/processor.ts";

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
- [Resources](./resources.md) — Customizing LLM providers, storage, embeddings, and more
