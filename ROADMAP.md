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
