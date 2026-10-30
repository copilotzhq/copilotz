/**
 * The same app serving many orgs behind one address, on Node (see
 * design/tenancy.md and `hosts/orgs`): a directory signs people in and knows
 * their orgs; each org is a runtime of its own, opened when first used, in
 * memory here. Sign in by name on this machine (`ana@example.com`): you get a
 * personal org, and can make team orgs.
 *
 *   node examples/web-node/orgs.ts [--port=8080]
 *
 * Node takes a socket before any handler runs, so `listen` hands each one to
 * its org's runtime, open since the page loaded (`openRuntime`); a socket
 * whose org isn't open is told to connect again.
 */
import process from "node:process";
import { parseArgs } from "node:util";
import { createRuntime } from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { identity } from "../../plugins/access/mod.ts";
import { directory } from "../../plugins/access/directory/mod.ts";
import { socket } from "../../hosts/web/server.ts";
import { themeOf } from "../../hosts/web/theme/css.ts";
import { orgsHost } from "../../hosts/orgs/mod.ts";
import { bundle, listen } from "../../hosts/web/node/mod.ts";
import { plugins } from "./app.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8080" } } });

const host = orgsHost({
  directory: await createRuntime({ store: memoryStore(), plugins: [identity, directory] }),
  open: async (_org, given) =>
    await createRuntime({
      store: memoryStore(),
      plugins: [...plugins, ...given.plugins],
      executors: 2,
      transports: given.transports,
      admit: given.admit,
    }),
  upgrade: () => new Response("Connect again", { status: 503 }),
  code: await bundle(new URL("./browser.tsx", import.meta.url)),
  theme: themeOf([]),
  dev: true,
});

const server = await listen({
  fetch: host.serve,
  hypervisor: (request) => host.openRuntime(request)?.hypervisor,
  port: Number(values.port),
});
console.log(`${server.url}`);

process.once("SIGINT", async () => {
  await server.shutdown();
  process.exit(0);
});
