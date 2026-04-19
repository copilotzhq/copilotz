# LLM Providers

LLM provider resources register model backends the runtime can use.

## Where It Lives

```txt
resources/llm/<provider-name>/
```

## What It Is For

Use an LLM provider resource when you want Copilotz to execute calls through a
named model backend.

Recommended use case: runtime model integration  
Most common mistaken alternative: hard-coding provider logic directly into
application routes

## How Copilotz Consumes It

- providers are loaded into the runtime registry
- agent and runtime config reference them by provider name
- provider settings can be resolved at runtime through config hooks

## Minimal Example

The built-in providers under `resources/llm/` are the canonical examples.

## Public Surface

LLM providers are runtime dependencies, not application endpoints.

## Related Pages

- [Agents](./agents.md)
- [createCopilotz](../reference/create-copilotz.md)
- [What Is Copilotz?](../start-here/what-is-copilotz.md)
