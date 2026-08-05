# Multi-agent `ask`

`ask` is a built-in public conversation tool, not private delegation.

```ts
const agents = [
  {
    id: "lead",
    name: "Lead",
    role: "Coordinate the answer",
    allowedAgents: ["researcher", "reviewer"],
    runtimes: { text: { type: "llm", provider: "openai" } },
  },
  {
    id: "researcher",
    name: "Researcher",
    role: "Find evidence",
    allowedAgents: [],
    runtimes: { text: { type: "llm", provider: "openai" } },
  },
];
```

When `lead` invokes `ask({ agent: "researcher", message: "..." })`:

1. the tool execution enters a waiting state;
2. Copilotz writes the lead's question as a public `message.created` addressed
   to the researcher;
3. the researcher receives a normal LLM attempt and writes a public answer
   message;
4. causation metadata completes the waiting ask;
5. after every tool in that batch settles, the lead receives a new attempt.

Nested asks carry their parent causal frame, so the innermost answer resumes its
caller and eventually the original caller. Parallel asks share a tool batch and
resume the caller once, after all answers settle. Every question and answer
remains participant-labelled in the public thread.

Tool results and reasoning continue to obey their visibility policies. Only
ordinary participant messages are unconditionally public. Explicit background
work may create another thread, but it is a separate workflow rather than hidden
conversation.

The built-in `create_thread` tool is the explicit background boundary. It
creates a graph-native child thread, adds its declared agent participants, and
optionally writes a public opening message to the first agent:

```ts
await context.createThread({
  name: "Background research",
  participants: ["researcher"],
  initialMessage: "Investigate this independently.",
});
```

The child uses its own correlation scope, so the parent run settles after the
tool reports that the workflow was started; it does not wait for the child
conversation. Parentage and participation are durable graph edges. This API is
also available to custom tools as `context.createThread()`. It is never used by
`ask`, whose question and answer remain in the current public thread.

Copilotz does not impose a single-speaker lock. In realtime use, simultaneous
agent output appears as separate participant-labelled streams; semantic ask and
tool lifecycle events remain in the same causal thread.
