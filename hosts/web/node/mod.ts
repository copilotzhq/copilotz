/**
 * Copilotz on Node: what an app needs beside its runtime to serve it there.
 * `listen` serves a fetch handler with Node's HTTP server, through Oxian's
 * Node adapter, sockets included (`runtime.fetch` accepts its own); `serve`
 * serves a runtime through a deploy (below); `bundle`
 * makes the browser's code with esbuild (code splitting, as on Deno), for
 * the page (`webPage`'s `code`). Bun and Deno run it too.
 *
 * ```ts
 * import { createRuntime, definePlugin } from "copilotz";
 * import { webPage } from "copilotz/web/server";
 * import { bundle, listen } from "copilotz/web/node";
 *
 * const code = await bundle(new URL("./browser.tsx", import.meta.url));
 * const runtime = await createRuntime({
 *   store,
 *   plugins: [...plugins, webPage, definePlugin({ name: "settings", resources: { page: { code } } })],
 * });
 * const server = await listen(runtime.fetch, { port: 8080 });
 * console.log(`${server.url}`);
 * process.once("SIGTERM", async () => {
 *   await server.shutdown();
 *   await runtime.close({ drain: 8_000 });
 * });
 * ```
 *
 * `serve` does what a deploy needs around that: it listens first (requests
 * are told it's starting), takes the store's lease (`lease` from
 * `copilotz/stores/postgres`), waiting for the previous process to hand
 * over, then opens the runtime; and it hands over in turn when a newer
 * process asks, so no two processes write the store at once and browsers
 * reconnect to the newer one instead of being fenced.
 *
 * ```ts
 * import { lease, postgresPool, postgresStore } from "copilotz/stores/postgres";
 * import { serve } from "copilotz/web/node";
 *
 * const pool = await postgresPool({ url: process.env.DATABASE_URL!, writes: 5, reads: 5 });
 * const sigterm = new AbortController();
 * process.once("SIGTERM", () => sigterm.abort());
 * const { server } = await serve(
 *   async () => createRuntime({ store: await postgresStore({ pool }), plugins }),
 *   {
 *     hostname: "0.0.0.0",
 *     port: 8080,
 *     signal: sigterm.signal,
 *     // Each deploy's number (Cloud Run's revision: app-00015-8bs is 15) asks older ones only.
 *     hold: (on) => lease(pool, { revision: Number(process.env.K_REVISION?.split("-").at(-2) ?? 0), ...on }),
 *     stopped: (code) => void pool.close().finally(() => process.exit(code)),
 *   },
 * );
 * ```
 */
export { bundle, type BundleOptions } from "./bundle.ts";
export {
  type App,
  type Holding,
  listen,
  type Listener,
  type ListenOptions,
  serve,
  type ServeOptions,
} from "./serve.ts";
