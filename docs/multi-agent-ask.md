# Multi-Agent Public Ask

Copilotz treats collaboration as conversation, not hidden delegation. The
built-in `ask` tool creates an ordinary public question addressed to another
agent in the same thread. The answer is another public participant message.
Causation metadata resumes the asking agent after the answer settles.

```ts
resources: {
  agents: {
    coordinator: {
      id: "coordinator",
      name: "Coordinator",
      role: "Coordinate specialists and synthesize the final answer.",
      models: { generate: "default" },
      capabilities: { agents: ["researcher", "writer"] },
    },
    researcher: {
      id: "researcher",
      name: "Researcher",
      role: "Research facts and answer peers publicly.",
      models: { generate: "default" },
      capabilities: { agents: ["coordinator"] },
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
  none; grants are exact Agent alias lists.
- The `ask` Tool is derived from a non-empty Agent grant. `corePlugin`
  contributes its native Action, Tool Resource, and continuation Processors.
- Questions, progress, and answers are ordinary participant messages with stable
  ask metadata and the originating response visibility.
- Nested asks persist a non-recursive parent cursor. Resume reloads and
  validates the parent question, so depth is limited by durable ancestry rather
  than an in-memory stack.
- Calls in one model-produced Tool plan execute sequentially in provider order.
  An `ask` completion pauses that plan until its durable answer or failure Event
  resumes the remaining calls and one final LLM continuation.
- An asked-agent failure produces durable failure state and still resumes the
  caller with a labelled outcome.
- No global single-speaker lock is imposed. Generic progressive output remains
  independent per stream; semantic participant identity stays in Core Events and
  Messages rather than the runtime stream descriptor.

Background work that should not be part of the public conversation belongs in a
separate application-defined thread/workflow, not a hidden consultation API.

Realtime orchestration uses the same composed `context.actions.ask` Action when
it deliberately participates in Core's ask protocol. There is no separate ask
capability method or second continuation path.
