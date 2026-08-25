# Contracts

This directory contains executable release contracts that intentionally sit
outside production source and the published JSR package.

- `package/` protects the package architecture, configuration model, public
  exports, downstream embedding boundary, and runtime-neutral dependency graph.
- `runtime/` contains portable smoke programs executed under Deno, Node, Bun, a
  browser-style isolate, and a Cloudflare Worker-style isolate.

Run `deno task test:contracts` for the package contracts. Runtime smoke tasks
are declared individually in `deno.json` because CI executes each target in its
native environment.
