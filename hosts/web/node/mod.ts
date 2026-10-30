/**
 * The web host on Node: what an app needs beside `webServer` to serve it
 * there. `bundle` makes the browser's code with esbuild (code splitting, as on
 * Deno), and `serve` listens with Node's HTTP server, taking browsers'
 * sockets through Oxian's Node adapter; `listen` does it for any fetch
 * handler, each socket going to the runtime it's for (a host with one runtime
 * per org). Bun and Deno run it too.
 *
 * ```ts
 * import { createRuntime } from "copilotz";
 * import { socket } from "copilotz/web/server";
 * import { createTickets } from "copilotz/web/tickets";
 * import { bundle, serve } from "copilotz/web/node";
 *
 * const tickets = createTickets();
 * const runtime = await createRuntime({
 *   store, plugins, transports: [socket], admit: tickets.admit,
 * });
 * const server = await serve({
 *   runtime,
 *   tickets,
 *   code: await bundle(new URL("./browser.tsx", import.meta.url)),
 *   port: 8080,
 * });
 * console.log(`${server.url}`);
 * ```
 */
export { bundle, type BundleOptions } from "./bundle.ts";
export { listen, type Listener, type ListenOptions, serve, type ServeOptions } from "./serve.ts";
