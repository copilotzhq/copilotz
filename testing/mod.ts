/**
 * One test suite on every runtime: `deno test`, `node --test` and `bun test`.
 * Tests use `test` and the helpers here instead of a runtime's own APIs:
 * temporary files, environment variables, a local HTTP server, a child
 * process, serving an owner's Hypervisor to remote executors, saying
 * who a request is (`testWho`, `ticketFor`), and what a kind of caller is let
 * into (`openTo`).
 *
 * Only tests import this module; library code uses web standards alone.
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hypervisor } from "@oxian/oxian-js";
import { type Actor, definePlugin, type Plugin, type Plugins } from "../runtime/mod.ts";
import { merge } from "../runtime/registry.ts";

type Fn = () => unknown;
type Options = { name: string; fn: Fn; ignore?: boolean };

// deno-lint-ignore no-explicit-any
const g = globalThis as any;

/** Which runtime runs the tests. */
export const runtime: "deno" | "bun" | "node" = g.Deno?.test ? "deno" : g.Bun ? "bun" : "node";

// Not literal, so no checker tries to resolve another runtime's module.
const BUN_TEST = "bun:test";
const NODE_TEST = "node:test";

const register: (options: Options) => void = runtime === "deno"
  ? (o) => g.Deno.test(o)
  : runtime === "bun"
  ? await import(BUN_TEST).then(({ test }) => (o: Options) =>
    o.ignore ? test.skip(o.name, o.fn) : test(o.name, o.fn, 60_000)
  )
  : await import(NODE_TEST).then(({ test }) => (o: Options) =>
    test(o.name, { skip: o.ignore }, o.fn)
  );

/**
 * A test: `test(name, fn)` or `test({ name, fn, ignore })`. What it made in
 * temporary directories goes when it ends (tests in a file run one by one).
 */
export function test(name: string | Options, fn?: Fn): void {
  const options = typeof name === "string" ? { name, fn: fn! } : name;
  register({
    ...options,
    fn: async () => {
      try {
        await options.fn();
      } finally {
        sweep();
      }
    },
  });
}

/** An environment variable, or undefined. */
export const env = (name: string): string | undefined =>
  runtime === "deno" ? g.Deno.env.get(name) : g.process?.env?.[name];

/** The arguments a script was run with. */
export const args = (): string[] => runtime === "deno" ? [...g.Deno.args] : g.process.argv.slice(2);

// What tests make, gone when each test ends, and (for what's made outside one) when the
// process does. Deno's test runner fires no `unload`.
const made: string[] = [];
function sweep() {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}
if (runtime === "deno") globalThis.addEventListener("unload", sweep);
else g.process?.on?.("exit", sweep);

/** A new, empty temporary directory, removed when the process ends. */
export const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "copilotz-"));
  made.push(dir);
  return dir;
};

/** A store whose `close` also deletes what it holds (a test's own Postgres schema). */
export async function temporary<S extends { close(): Promise<void>; drop?(): Promise<void> }>(
  store: S | Promise<S>,
): Promise<S> {
  const s = await store;
  return s.drop ? Object.assign(s, { close: () => s.drop!() }) : s;
}

/** A path for a new file in a temporary directory (the file isn't created). */
export const tempFile = (suffix = ""): string => join(tempDir(), `file${suffix}`);

/** A local HTTP server answering with `handler`, streaming its responses. */
export async function serve(
  handler: (request: Request) => Response | Promise<Response>,
): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of req) chunks.push(chunk as Uint8Array);
    const body = chunks.length ? new Blob(chunks as BlobPart[]) : undefined;
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (typeof value === "string") headers.set(key, value);
      else if (Array.isArray(value)) { for (const v of value) headers.append(key, v); }
    }
    const response = await handler(
      new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, body }),
    );
    // Every cookie it sets: `Object.fromEntries` would keep only the last `set-cookie`.
    const cookies = response.headers.getSetCookie();
    res.writeHead(response.status, {
      ...Object.fromEntries(response.headers),
      ...(cookies.length ? { "set-cookie": cookies } : {}),
    });
    if (response.body) {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Runs a TypeScript file in a child process of this same runtime. */
export function spawn(
  script: string,
  options: { args?: string[]; env?: Record<string, string> } = {},
): { kill(): void; exited: Promise<number | null> } {
  const exec = runtime === "deno" ? g.Deno.execPath() : g.process.execPath;
  const argv = runtime === "deno"
    ? ["run", "-A", "--unstable-no-legacy-abort", script, ...options.args ?? []]
    : runtime === "bun"
    ? ["run", script, ...options.args ?? []]
    : [script, ...options.args ?? []];
  const child = spawnProcess(exec, argv, {
    env: { ...(g.process?.env ?? {}), ...options.env },
    stdio: "ignore",
  });
  return {
    kill: () => child.kill("SIGKILL"),
    exited: new Promise((resolve) => child.on("exit", (code: number | null) => resolve(code))),
  };
}

/** Serves an owner's Hypervisor (for remote executors) with this runtime's Oxian host adapter. */
export async function host(
  hypervisor: Hypervisor,
): Promise<{ url: string | URL; shutdown(): Promise<void> }> {
  // A full specifier: a published module has no import map to resolve a bare one.
  const adapter = runtime === "deno"
    ? "jsr:@oxian/oxian-js@0.23.6/adapters/deno"
    : "@oxian/oxian-js/adapters/node";
  const { serve } = await import(adapter);
  return await serve({ hypervisor, hostname: "127.0.0.1", port: 0 });
}

/** The header `testWho` believes: who a test's request is, as JSON (`{ kind, id }`). */
export const TEST_ACTOR = "x-test-actor";

/**
 * A test's way to say who a request is: a plugin whose `who` believes the
 * `x-test-actor` header (an actor, as JSON). For tests alone: in an app, it
 * would let anyone be anyone.
 */
export const testWho: Plugin = definePlugin({
  name: "test-who",
  who: (request) => {
    const said = request.headers.get(TEST_ACTOR);
    return said ? JSON.parse(said) as Actor : null;
  },
});

/**
 * A one-time ticket for `actor`, from the runtime's `POST /connect` (with
 * `testWho` among its plugins): what an in-process client connects with.
 */
export async function ticketFor(
  runtime: { fetch(request: Request): Promise<Response> },
  actor: Actor,
): Promise<string> {
  const response = await runtime.fetch(
    new Request("http://localhost/connect", {
      method: "POST",
      headers: { [TEST_ACTOR]: JSON.stringify(actor) },
    }),
  );
  if (!response.ok) throw new Error(`ticketFor: /connect answered ${response.status}`);
  return (await response.json() as { ticket: string }).ticket;
}

/**
 * What `actor` is let into of each of `plugins`, each on its own (some are
 * alternatives to each other): the Actions whose `allow` admits it, the named
 * queries that do, and the events it may hear, asked as it would ask about
 * itself (its own id wherever one is named), sorted. For checking that a kind
 * of caller (a contact, a key) reaches only what's opened to it:
 *
 * ```ts
 * assertEquals(openTo({ kind: "contact", id: "c-1" }, [boards, documents]), []);
 * ```
 */
export function openTo(actor: Actor, plugins: Plugins): string[] {
  const own = { person: actor.id, agent: actor.id, id: actor.id };
  return plugins.flat(Infinity as 1).flatMap((plugin) => {
    const registry = merge([plugin as Plugin], { elsewhere: true });
    return [
      ...Object.entries(registry.actions).filter(([, def]) => def.allow?.(actor, own))
        .map(([name]) => name),
      ...Object.entries(registry.collections).flatMap(([collection, def]) =>
        Object.entries(def.queries ?? {}).filter(([, query]) =>
          typeof query === "object" && query.allow(actor, own)
        ).map(([name]) => `${collection}.${name}`)
      ),
      ...Object.entries(registry.events).filter(([, def]) => def.allow?.(actor))
        .map(([type]) => type),
    ];
  }).sort();
}
