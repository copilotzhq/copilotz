/**
 * A Copilotz app served to browsers from Node: the app's plugins (app.ts)
 * beside the page (`webPage`, with a `page` resource for its code,
 * browser.tsx, bundled with esbuild as it starts, and a `theme`), served by
 * `runtime.fetch` through Oxian's Node adapter (`listen`, from
 * `copilotz/web/node`), browsers' sockets included. Sign in by name on this
 * machine (`devSignIn`).
 *
 *   node examples/web-node/server.ts [--port=8080] [--sqlite[=path]]
 *   node --env-file=.env examples/web-node/server.ts      # a real model (OPENAI_API_KEY)
 *
 * An app on the npm package writes the same with its names: `copilotz`,
 * `copilotz/stores/memory`, `copilotz/web/server`
 * and `copilotz/web/node` (see the README, "Serve it on the web").
 */
import { mkdirSync } from "node:fs";
import process from "node:process";
import { parseArgs } from "node:util";
import { createRuntime, definePlugin } from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { webPage } from "../../hosts/web/server.ts";
import { themeOf } from "../../hosts/web/theme/css.ts";
import { bundle, listen } from "../../hosts/web/node/mod.ts";
import { devSignIn } from "../../plugins/access/mod.ts";
import { plugins } from "./app.ts";

const { values } = parseArgs({
  options: { port: { type: "string", default: "8080" }, sqlite: { type: "string" } },
});
const sqlite = values.sqlite === undefined ? undefined : values.sqlite || ".data/web-node.sqlite";
if (sqlite === ".data/web-node.sqlite") mkdirSync(".data", { recursive: true });

const runtime = await createRuntime({
  store: sqlite ? await sqliteStore({ path: sqlite }) : memoryStore(),
  plugins: [
    ...plugins,
    // Signing in by name, from this machine only: leave it out of a deployed app.
    devSignIn,
    webPage,
    definePlugin({
      name: "page",
      resources: {
        // The code is bundled once, on the page's first request.
        page: { title: "Copilotz", code: () => bundle(new URL("./browser.tsx", import.meta.url)) },
        // The page's first paint, in the default theme (a brand gives its theme resources here).
        theme: themeOf([]),
      },
    }),
  ],
  executors: 2,
});

const server = await listen(runtime.fetch, { port: Number(values.port) });
console.log(`${server.url}`);

// Ctrl+C: stop listening, then the runtime.
process.once("SIGINT", async () => {
  await server.shutdown();
  await runtime.close();
  process.exit(0);
});
