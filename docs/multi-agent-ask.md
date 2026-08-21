# Multi-Agent Public Ask

Copilotz treats collaboration as conversation, not hidden delegation. The
built-in `ask` tool creates an ordinary public question addressed to another
agent in the same thread. The answer is another public participant message.
Causation metadata resumes the asking agent after the answer settles.

```ts
context: {
  agents: {
    coordinator: {
      id: "coordinator",
      name: "Coordinator",
      role: "Coordinate specialists and synthesize the final answer.",
      capabilities: { agents: ["researcher", "writer"] },
      runtime: { provider: "openai" },
    },
    researcher: {
      id: "researcher",
      name: "Researcher",
      role: "Research facts and answer peers publicly.",
      capabilities: { agents: ["coordinator"] },
      runtime: { provider: "openai" },
    },
  },
}
```

The model invokes:

```json
{ "target": "researcher", "message": "What evidence supports this claim?" }
```

## Semantics

- The target must be an agent participant in the same thread.
- `capabilities.agents` constrains who an agent may ask. Omitted or empty means
  none; `{ all: true }` deliberately grants every declared peer.
- The `ask` tool is derived from a non-empty agent grant. Applications enable
  its resource/processor plugin explicitly with `core: { ask: {} }`.
- Questions, progress, and answers are public messages with stable ask metadata.
- Nested asks are allowed up to a configurable depth (default 8).
- Parallel asks and tools settle independently, then resume their callers.
- An asked-agent failure produces durable failure state and still resumes the
  caller with a labelled outcome.
- No global single-speaker lock is imposed. Concurrent realtime output remains
  separate participant-labelled streams.

Background work that should not be part of the public conversation belongs in a
separate application-defined thread/workflow, not a hidden consultation API.

The same `context.ask()` capability is available inside realtime providers, so
audio interaction and text interaction share the multi-agent semantics.
