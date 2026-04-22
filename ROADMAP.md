## Cross-Runtime Compatibility

- Runtime detection helpers (`isDeno`/`isNode`/`isBun`) and centralized shims
  for env (`env.get`), filesystem, subprocess, timers.
- Database adapters: choose `omnipg` only on Deno (or make ominipg compatible
  with Node/Bun/Browser too); provide Node/Bun path using `pg`/`postgres.js`
  with Drizzle’s node driver; reconcile connection config + caching.
- Native tools refactor: wrap `Deno.*` usage in adapters, switch to
  `fs/promises`, `child_process.spawn`, or Bun equivalents; disable unsupported
  tools gracefully.
- CLI + examples: migrate `runCLI`, streaming callbacks, stdout writes to
  runtime-aware IO (`readline`, `process.stdout.write`, Bun streams).
- Packaging: introduce `package.json` with ESM/CJS builds, reuse `deno.json`
  export map, ensure bundler handles aliases (`@/`).
- Testing: add multi-runtime CI (Deno, Node, Bun) with representative smoke
  tests for DB connections and native tools.
- Docs: update README quick-starts per runtime, note limitations (e.g., command
  tool unavailable in browsers) and configuration differences.

## MCP Streaming Transport

- Define transport interface for MCP connectors (`send`, `onMessage`, `close`)
  and keep existing stdio implementation as a concrete adapter.
- Implement streaming HTTP transport (`fetch` + `ReadableStream` or WebSocket
  fallback) following MCP framing (JSON lines / SSE), including
  reconnect/backoff and auth headers.
- Allow MCP connector configs to select transport type (`stdio`, `http-stream`,
  etc.) and share lifecycle with agent event loop (request id multiplex).
- Add integration tests with mock MCP HTTP server across Deno/Node/Bun and
  document usage, limitations, and security considerations.

## Memory As A Resource

- Introduce a first-class `memory` resource family to unify long-lived context
  concepts that are currently spread across agent memory, participant/thread
  metadata, conversational history, and RAG.
- Keep `collections` focused on structured application data while positioning
  `memory` as the runtime/context recall layer for agents and conversations.
- Model RAG as one built-in memory strategy rather than the whole memory story,
  so retrieval-based memory can coexist with other strategies such as history,
  summaries, participant memory, and working memory.
- Revisit `update_my_memory`, prompt/history injection, and memory retrieval
  APIs so they compose around one explicit resource model instead of separate
  ad hoc mechanisms.
- Extract shared memory-oriented generation logic out of
  `resources/processors/new_message/generators` and into a runtime layer such
  as `runtime/memory`, similar to how LLM and storage logic already live under
  `runtime/*`.
- Apply the same organizational boundary to API and MCP execution helpers so
  resource-family runtime logic can move toward `runtime/api` and
  `runtime/mcp`, leaving processors focused on orchestration rather than owning
  resource internals.
- Define clear boundaries:
  `collections` = durable app state,
  `memory` = contextual recall and prompt injection.
- Plan the migration carefully so existing RAG and agent-memory features keep
  working while the higher-level `memory` abstraction is introduced.
