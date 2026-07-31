# Migrating to 0.55

Version 0.55 replaces configurable/explicit prompt caching with deterministic,
append-only history and provider defaults.

Remove these LLM configuration fields:

- `promptCache`
- `openaiPromptCacheKey`
- `openaiPromptCacheRetention`
- explicit content-part cache breakpoints

Remove application cache switches and Gemini cached-content lifecycle scripts.
OpenAI cache routing is now internal and scoped by namespace, thread, and agent.

Dynamic date and `<turn_control>` system messages are gone. Models receive
immutable per-message timestamps in projected history instead. Long-term-memory
rollover remains an expected cache reset.

Recovery fragments and cues are now durable graph messages. Adapters must keep
filtering `metadata.visibility === "internal"`; UIs can use
`metadata.recovery.chainId` and `joinSeparator` to hydrate linked visible
fragments as one bubble. `node.content` remains canonical message content;
`node.data` contains metadata and structured fields, not a duplicate content
copy.
