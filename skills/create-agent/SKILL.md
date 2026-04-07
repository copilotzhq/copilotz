---
name: create-agent
description: Scaffold a new Copilotz agent with instructions and configuration files.
allowed-tools: [read_file, write_file, list_directory, search_files]
tags: [framework, agent]
---

# Create Agent

Create a new agent in the Copilotz resources directory.

## Directory Structure

Each agent lives in `resources/agents/{agent-name}/` with two files:

```
resources/agents/{agent-name}/
  instructions.md    # Required: system prompt (markdown)
  config.ts          # Optional: agent configuration
```

## Step 1: Create instructions.md

Write the agent's system prompt in markdown. This becomes the agent's `instructions` field.

```markdown
# Agent Name

You are a [role description].

## Guidelines

- Be [tone/style]
- [Key behavior 1]
- [Key behavior 2]

## Capabilities

- [What the agent can do]
```

## Step 2: Create config.ts

Export a default object with agent configuration. The `instructions` field is automatically loaded from `instructions.md`.

```typescript
import type { Agent } from "copilotz";

export default {
    llmOptions: {
        provider: "gemini",       // "openai", "anthropic", "gemini", "groq", "deepseek", "ollama"
        model: "gemini-3.1-flash-lite",
        temperature: 1,
        maxTokens: 10000,
        // apiKey: Deno.env.get("OPENAI_KEY"),  // Override env var
    },
    allowedTools: ["*"],          // Or specific: ["search_knowledge", "http_request"]
    // allowedAgents: ["other-agent"],  // For multi-agent setups
    // ragOptions: { mode: "auto", namespaces: ["docs"] },
} as Agent;
```

## Key Configuration Options

| Field | Type | Description |
|-------|------|-------------|
| `llmOptions` | object | LLM provider config (required) |
| `allowedTools` | string[] \| null | Tool whitelist. `null` = no tools, omit = all tools |
| `allowedAgents` | string[] | Which other agents this one can communicate with |
| `ragOptions` | object | RAG settings: `mode`, `namespaces`, `autoInjectLimit` |
| `assetOptions` | object | Asset generation settings |
| `description` | string | Public description (shown in agent listings) |

## Common Patterns

### Agent with RAG
```typescript
export default {
    llmOptions: { provider: "openai", model: "gpt-4o-mini" },
    allowedTools: ["search_knowledge", "ingest_document"],
    ragOptions: {
        mode: "auto",
        namespaces: ["docs", "faq"],
        autoInjectLimit: 5,
    },
} as Agent;
```

### Agent with API access
```typescript
export default {
    llmOptions: { provider: "anthropic", model: "claude-sonnet-4-5-20241022" },
    allowedTools: ["http_request", "github_getRepository"],
} as Agent;
```

## Notes

- The directory name becomes the agent's `id` and `name` by default
- `config.ts` fields override auto-derived values
- Agent is auto-loaded when `resources.path` is set in `createCopilotz`
