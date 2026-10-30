/**
 * One test suite on every runtime: `deno test`, `node --test` and `bun test`.
 * Tests use `test` and the helpers here instead of a runtime's own APIs:
 * temporary files, environment variables, a local HTTP server, a child
 * process, and serving an owner's Hypervisor to remote executors.
 *
 * Only tests import this module; library code uses web standards alone.
 */
import { spawn as spawnProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hypervisor } from "@oxian/oxian-js";

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
  const adapter = runtime === "deno"
    ? "@oxian/oxian-js/adapters/deno"
    : "@oxian/oxian-js/adapters/node";
  const { serve } = await import(adapter);
  return await serve({ hypervisor, hostname: "127.0.0.1", port: 0 });
}
