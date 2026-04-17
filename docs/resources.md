# Resources

Everything in Copilotz is a **resource**. Agents, tools, APIs, processors, LLM providers, embeddings, storage backends, collections, and skills are all loaded through the same system. You can override or extend any of them.

## How It Works

When `createCopilotz` initializes, it loads resources from three layers:

1. **Built-in** — ships with the library (OpenAI adapter, filesystem storage, default processors, etc.)
2. **User directory** — loaded from `resources.path` if provided
3. **Inline config** — passed directly via `createCopilotz({ tools: [...], processors: [...] })`

User and inline resources take priority over built-in ones. On ID collision, the higher-priority resource wins.

```typescript
const copilotz = await createCopilotz({
  resources: { path: "./resources" }, // layer 2: file-based
  tools: [myInlineTool],             // layer 3: inline
  dbConfig: { url: ":memory:" },
});
```

## Resource Types

| Type | Directory | Purpose | Docs |
|------|-----------|---------|------|
| **Agents** | `agents/` | LLM-powered agents with instructions and configuration | [Agents](./agents.md) |
| **Tools** | `tools/` | Functions the LLM can call | [Tools](./tools.md) |
| **APIs** | `apis/` | OpenAPI specs auto-converted to tools | [Tools](./tools.md#api-integration) |
| **Processors** | `processors/` | Custom event handlers for the processing pipeline | [Events](./events.md) |
| **Skills** | `skills/` | SKILL.md-based instructions with progressive disclosure | [Skills](./skills.md) |
| **LLM providers** | `llm/` | Chat completion adapters (OpenAI, Anthropic, etc.) | [LLM Providers](./llm-providers.md) |
| **Embeddings** | `embeddings/` | Text embedding adapters | [Embeddings](./embeddings.md) |
| **Storage** | `storage/` | Asset storage backends (filesystem, S3, etc.) | [Storage](./storage.md) |
| **Collections** | `collections/` | Schema-validated data types for the knowledge graph | [Collections](./collections.md) |

## Built-in Resources

Copilotz ships with a complete set of defaults so everything works out of the box:

**LLM providers:** OpenAI, Anthropic, Gemini, Groq, DeepSeek, Ollama, MiniMax

**Embeddings:** OpenAI (`text-embedding-3-small`)

**Storage:** Filesystem (`fs`), Amazon S3 (`s3`)

**Collections:** `participant`, `message`, `chunk`, `document`, `llm_usage`

**Processors:** `new_message`, `llm_call`, `tool_call`, `rag_ingest`, `entity_extract`

**Tools:** 27 built-in tools for file ops, HTTP, RAG, memory, skills, and more

## Overriding Built-in Resources

Any built-in resource can be replaced by providing your own with the same identifier. User/config resources always take priority.

### Override a processor

User-defined processors for a given event type run before built-in ones. Return `{ producedEvents: [...] }` to claim the event and prevent built-in processing:

```typescript
const copilotz = await createCopilotz({
  processors: [{
    eventType: "NEW_MESSAGE",
    shouldProcess: (event) => event.payload.metadata?.custom === true,
    process: async (event, deps) => {
      // Handle it yourself, built-in NEW_MESSAGE processor won't run
      return { producedEvents: [{ type: "LLM_CALL", payload: { ... } }] };
    },
  }],
  // ...
});
```

### Override an LLM provider

Add a custom provider that matches an existing name to replace it, or use a new name and reference it in agent config:

```typescript
const copilotz = await createCopilotz({
  agents: [{
    id: "assistant",
    instructions: "You are a helpful assistant.",
    llmOptions: { provider: "my-custom-llm", model: "my-model" },
  }],
  // ...
});
```

See [LLM Providers](./llm-providers.md) for the full adapter interface.

## Manifest-Based Packaging

For publishable resource packages (or the built-in resources themselves), a `manifest.ts` declares what the package provides:

```typescript
export default {
  provides: {
    agents: ["my-agent"],
    tools: ["my-tool"],
    processors: ["my-processor"],
    llm: ["my-provider"],
    // Any key from the resource types table
  },
};
```

When `loadResources` encounters a `manifest.ts`, it uses the declared lists to selectively load only the resources that are provided, rather than scanning the whole directory.

## File-Based Loading

Without a manifest, `loadResources` scans standard subdirectories (`agents/`, `tools/`, `apis/`, `processors/`, `skills/`). See [Loaders](./loaders.md) for the full directory structure and file conventions.

## Next Steps

- [Loaders](./loaders.md) — File-based resource loading conventions
- [LLM Providers](./llm-providers.md) — Custom LLM adapters
- [Embeddings](./embeddings.md) — Custom embedding providers
- [Storage](./storage.md) — Custom storage backends
- [Events](./events.md) — Custom event processors
