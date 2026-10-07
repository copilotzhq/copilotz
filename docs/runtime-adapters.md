---
title: "Runtimes and Host Capabilities"
description: "Which Copilotz features run on Deno, Node, Bun, browsers and Cloudflare Workers, and which host-specific entrypoints supply listeners, files and subprocesses."
section: Operate
order: 50
status: stable
---

# Runtimes and Host Capabilities

## The pain

Your Notes application runs under `deno run -A`. Then a teammate wants to run
the same application on Node. Someone else wants to put the HTTP API in a
Cloudflare Worker, or bundle a Skill into a browser build. Some features keep
working. Others fail at startup, or later on the first file read. You can't tell
in advance which is which.

## The problem

You need a contract that sorts each feature into one of two groups. The first
group is plain declarations that run anywhere JavaScript runs. The second group
needs something the host itself provides: a TCP listener, a local filesystem, a
subprocess, a database engine or a module-relative asset. You can't assume every
runtime has the same capabilities. A Worker has no local filesystem. A browser
can't start a subprocess. A bundle can move `import.meta.url` somewhere your
Skill files are not.

## The solution

Copilotz keeps that split visible in its import paths:

- **Runtime-neutral entrypoints.** These include the package root, `/plugins`,
  `/actions`, `/collections`, `/server`, `/core`, `/skills`, `/tools/openapi`
  and `/tools/mcp`. Importing one, or writing declarations with it, never forces
  host I/O: no file is read and no process is started. The operations you then
  run can still have requirements. A database-backed application needs a working
  database engine, a local Skill root needs a filesystem, and an MCP stdio
  connection needs subprocesses.
- **Host-specific entrypoints.** Each one names the host it needs. Import these
  only from host modules and entrypoints, never from pure definitions.

| Entrypoint                        | Host            | Provides                                                                                         |
| --------------------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `/adapters/deno`                  | Deno            | `listen` (HTTP or a caller-owned Hypervisor) and `denoAssetFilesystem` (filesystem asset access) |
| `/core/cli`                       | any             | A portable interactive CLI. You inject its input and output                                      |
| `/core/cli/node`                  | Node-compatible | The same CLI wired to readline, stdin and stdout                                                 |
| `/skills/deno`                    | Deno            | A build-time packer that turns a local Skill directory into a bundle                             |
| `/tools/deno`                     | Deno            | Workspace and process Actions and Tools                                                          |
| `/tools/mcp/stdio`                | subprocess host | `connectMcp`, which runs a local MCP server through the official MCP SDK                         |
| `/tools/persistent-terminal/deno` | Deno            | The persistent-terminal service                                                                  |
| `/build`                          | Deno            | The filesystem-authoring build                                                                   |

Copilotz has no generic `/adapters` entrypoint and no `/adapters/node`
entrypoint. On Node, serve `app.fetch` with a Fetch bridge such as
`@hono/node-server`, as `serve-node.ts` does in
[Expose an HTTP API](getting-started/part-4-release-to-users/15-expose-an-http-api.md).

### Serve on Deno with `listen`

This example uses the files from Chapter 15: `composition.ts` and the pure
`server.ts` factory. It assumes the `@copilotz/copilotz` import (`^0.85.3`) from
that chapter. Create `serve-listen.ts` as a Deno-only alternative to `serve.ts`:

```ts
// Deno host adapter: a Fetch listener with an explicit lifecycle.
import { listen } from "@copilotz/copilotz/adapters/deno";
// Host choices shared with every other entrypoint.
import { database, namespace } from "./composition.ts";
// The pure server definition and its principal type.
import { createServerApp } from "./server.ts";
import type { Principal } from "./server.ts";

// Local demo credential: a fixed string checked by exact match.
const devAuthorization = "Bearer local-dev-token";

// The one local demo identity this development host trusts.
const localUser: Principal = { actorId: "local-guide-user", namespace };

const app = await createServerApp({
  resolvePrincipal: (request) =>
    request.headers.get("authorization") === devAuthorization
      ? localUser
      : undefined,
  namespace,
  database,
});

try {
  // Without hostname/port, listen binds 127.0.0.1 on an ephemeral port.
  // Pass both explicitly when the address must be stable or exposed.
  const listener = listen(app, { hostname: "127.0.0.1", port: 8000 });
  console.log(`Notes API on ${listener.url}api`);

  // shutdown() stops accepting requests. It does not close the application.
  const stop = () => void listener.shutdown();
  try {
    Deno.addSignalListener("SIGINT", stop);
    Deno.addSignalListener("SIGTERM", stop);
    // Resolves once pending requests finish after shutdown().
    await listener.finished;
    console.log("listener stopped");
  } finally {
    // Stop the listener even if `finished` rejected; repeated calls are safe.
    await listener.shutdown();
    Deno.removeSignalListener("SIGINT", stop);
    Deno.removeSignalListener("SIGTERM", stop);
  }
} finally {
  // The host owns the application and its persistence. Close them separately.
  await app.close();
}
```

Run it with `deno run -A serve-listen.ts`.

When you call `listen(app)`, it serves only `app.fetch`, which is plain HTTP.
WebSocket Worker connections need a Hypervisor that the host creates and owns.
Pass it as `listen({ hypervisor })`, as described in
[Deployment Topologies](embedding-and-hypervisors.md).

## Reference

### Host capability matrix

| Capability                                              | Deno                     | Node                          | Bun                      | Browser           | Cloudflare Workers       |
| ------------------------------------------------------- | ------------------------ | ----------------------------- | ------------------------ | ----------------- | ------------------------ |
| Runtime-neutral definitions and in-memory Asset helpers | yes                      | yes                           | yes                      | yes               | yes                      |
| Full database-backed application (`app.send`)           | yes                      | yes                           | not validated            | not validated     | not validated            |
| HTTP serving                                            | `listen` or `Deno.serve` | Fetch bridge over `app.fetch` | the host's Fetch serving | not a server host | the host's Fetch serving |
| Local filesystem Skill roots                            | yes                      | yes                           | yes                      | no                | no                       |
| Filesystem asset backend                                | `denoAssetFilesystem`    | supply your own access        | supply your own access   | no                | no                       |
| Subprocesses (MCP stdio, `/tools/deno`)                 | yes                      | MCP stdio                     | MCP stdio, not validated | no                | no                       |
| PGlite (`file://`, `:memory:`)                          | yes                      | yes                           | not validated            | not validated     | not validated            |
| PostgreSQL                                              | yes                      | not validated                 | not validated            | no                | not validated            |
| `/build`, `/skills/deno`                                | yes                      | no                            | no                       | no                | no                       |
| HTTP(S) Skill roots                                     | yes                      | yes                           | yes                      | yes, needs CORS   | yes                      |

Deno and Node application examples are checked against the database-backed
runtime; the narrower CI coverage is listed below. "Not validated" means this
documentation does not establish that combination. It might work, but you have
to validate the database and runtime integration yourself. On Bun and Workers,
the HTTP row only says that the host can serve a Fetch handler. It does not
promise that an exported `app.fetch` works with a database there.

### Assets on the filesystem

`denoAssetFilesystem(root)` returns filesystem _access_, not a complete body
store. To use it, set `assets.storage` to
`{ type: "filesystem", config: { backendId, access } }`. The `config` object can
also take `prefix` and `protectionMs`. Locks are held per process, even when
`root` is a mounted shared directory. This backend is not cluster-safe fencing.
Multi-host deployments need an object store or a custom backend. See
[Content and Assets](content-assets.md).

### Skills across hosts

`defineSkill` comes from the same `/skills` import on every supported host. The
root locator decides what the host must provide:

- **HTTP(S) roots** use only `fetch`, so they work everywhere. Browsers also
  need CORS on the Skill server.
- **Local paths and `file:` URLs** are read through Node-compatible built-in
  modules, loaded lazily when a Skill is first read. Importing `/skills` does
  not load them. Browsers and Workers have no such filesystem, so a `file:` root
  is invalid there.
- **`new URL("./skills/notes/", import.meta.url)`** resolves against wherever
  the module ends up. Bundlers and Workers move modules but not the Skill files
  next to them. Copy those files as deployment assets, or serve them over HTTP.
- **`/skills/deno`** packs a local Skill directory into a bundle at build time.
  It is a Deno tool, not a portable runtime reader.

### Providers, adapters and dynamic imports

The runtime graph never loads Node's filesystem module unconditionally. Features
that need a host capability reach it lazily through the host, and they fail with
a clear error when the host lacks it.

Built-in model providers need no extra import. You configure them directly in an
LLM connection. You import and register an adapter only for a custom provider or
a host capability. Copilotz never loads providers, presets or adapters from
strings or package paths at runtime.

### What CI actually checks

The release workflow runs these jobs:

- **Deno.** The complete suite runs against PGlite and PostgreSQL, together with
  architecture and package-surface checks.
- **Portable smoke tests on Deno, Node, Bun and a browser isolate.** These cover
  Web primitives, in-memory assets, plugin and resource composition, and HTTP
  Skills. The browser isolate runs in a Node VM. Deno, Node and Bun also read a
  local filesystem Skill root: Deno runs the source fixture, while Node and Bun
  run the bundled fixture.
- **Cloudflare Workers.** A bundled Worker runs in a VM isolate, followed by a
  Wrangler dry-run build.

The smoke tests do not run a full database-backed application or a live model
provider on Node, Bun, the browser or Workers. If you rely on those host
combinations, verify them in your own environment.

## What this unlocks

Your pure Notes definitions, server factory and agent declarations move between
hosts unchanged. Only the small host module and entrypoint change. You can tell
before you deploy which features need a filesystem, a subprocess or copied
assets. You can also tell which host combinations are your own responsibility to
test.

## Next steps

- [Expose an HTTP API](getting-started/part-4-release-to-users/15-expose-an-http-api.md):
  the Deno and Node listener entrypoints.
- [Deployment Topologies](embedding-and-hypervisors.md): split roles and
  Hypervisor-backed listeners.
- [Skills](skills.md): Skill roots, packaging and authorization.
- [Integrations](integrations.md): MCP stdio and generated API tools.
