# Multi-Agent Public Ask

Copilotz treats collaboration as conversation, not hidden delegation. The
built-in `ask` tool creates an ordinary public question addressed to another
agent in the same thread. The answer is another public participant message.
Causation metadata resumes the asking agent after the answer settles.

```ts
resources: {
  agents: [
    {
      id: "coordinator",
      name: "Coordinator",
      role: "Coordinate specialists and synthesize the final answer.",
      allowedAgents: ["researcher", "writer"],
      allowedTools: ["ask"],
      runtimes: { text: { type: "llm", provider: "openai" } },
    },
    {
      id: "researcher",
      name: "Researcher",
      role: "Research facts and answer peers publicly.",
      allowedAgents: ["coordinator"],
      runtimes: { text: { type: "llm", provider: "openai" } },
    },
  ],
}
```

The model invokes:

```json
{ "target": "researcher", "message": "What evidence supports this claim?" }
```

## Semantics

- The target must be an agent participant in the same thread.
- `allowedAgents` constrains who an agent may ask; omitted means all declared
  peers, while an empty/null list permits none.
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
