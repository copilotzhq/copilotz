/**
 * A Copilotz app served to browsers from Node: the app's plugins (app.ts)
 * beside the web host's server half, the page's code (browser.tsx) bundled
 * with esbuild as it starts, and browsers' sockets taken through Oxian's Node
 * adapter (`copilotz/web/node`). Sign in by name on this machine (dev).
 *
 *   node examples/web-node/server.ts [--port=8080] [--sqlite[=path]]
 *   node --env-file=.env examples/web-node/server.ts      # a real model (OPENAI_API_KEY)
 *
 * An app on the npm package writes the same with its names: `copilotz`,
 * `copilotz/stores/memory`, `copilotz/web/server`, `copilotz/web/tickets`
 * and `copilotz/web/node` (see the README, "Serve it on Node").
 */
import { mkdirSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { createRuntime } from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { socket } from "../../hosts/web/server.ts";
import { createTickets } from "../../hosts/web/tickets.ts";
import { themeOf } from "../../hosts/web/theme/css.ts";
import { bundle, serve } from "../../hosts/web/node/mod.ts";
import { plugins } from "./app.ts";

const { values } = parseArgs({
  options: { port: { type: "string", default: "8080" }, sqlite: { type: "string" } },
});
const sqlite = values.sqlite === undefined ? undefined : values.sqlite || ".data/web-node.sqlite";
if (sqlite === ".data/web-node.sqlite") mkdirSync(".data", { recursive: true });

// Browsers trade their session for a one-time ticket, and connect to the owner with it.
const tickets = createTickets();
const runtime = await createRuntime({
  store: sqlite ? await sqliteStore({ path: sqlite }) : memoryStore(),
  plugins,
  executors: 2,
  transports: [socket],
  admit: tickets.admit,
});

const server = await serve({
  runtime,
  tickets,
  code: await bundle(new URL("./browser.tsx", import.meta.url)),
  port: Number(values.port),
  // The page's first paint, in the default theme (a brand gives its theme resources here).
  theme: themeOf([]),
  dev: true,
});
console.log(`${server.url}`);

// Ctrl+C: stop listening, then the runtime.
process.once("SIGINT", async () => {
  await server.shutdown();
  await runtime.close();
  process.exit(0);
});
