/**
 * Copilotz on Node: what an app needs beside its runtime to serve it there.
 * `listen` serves a fetch handler with Node's HTTP server, through Oxian's
 * Node adapter, sockets included (`runtime.fetch` accepts its own); `bundle`
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
 */
export { bundle, type BundleOptions } from "./bundle.ts";
export { listen, type Listener, type ListenOptions } from "./serve.ts";
