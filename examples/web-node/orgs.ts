/**
 * The same app serving many orgs behind one address, on Node (see
 * design/tenancy.md and the directory plugin): a directory runtime signs
 * people in and knows their orgs, and its `fetch` is the whole app; each org
 * is a runtime of its own (app.ts's plugins, the page, and
 * `directory.member`), opened when first used and closed when idle
 * (`runtimes`), in memory here. The directory hands each request it doesn't
 * answer itself, sockets included, to its org's runtime. Sign in by name on
 * this machine (`ana@example.com`): the first page makes your personal org;
 * then make team orgs, and invite people by email.
 *
 *   node examples/web-node/orgs.ts [--port=8080]
 */
import process from "node:process";
import { parseArgs } from "node:util";
import {
  contactsPool,
  createRuntime,
  definePlugin,
  type Runtime,
  runtimes,
  type Store,
} from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { devSignIn, directory, identity, type OrgInfo } from "../../plugins/access/mod.ts";
import { type Code, webPage } from "../../hosts/web/server.ts";
import { themeOf } from "../../hosts/web/theme/css.ts";
import { bundle, listen } from "../../hosts/web/node/mod.ts";
import { plugins } from "./app.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8080" } } });

/** The browser's code, bundled once, on the first page asked for: the lobby's and every org's. */
let bundled: Promise<Code> | undefined;
const code = () => bundled ??= bundle(new URL("./browser.tsx", import.meta.url));

/** The page, the same wherever it's served (an org's under its address: `page.base`). */
const page = [
  webPage,
  definePlugin({
    name: "page",
    resources: { page: { title: "Copilotz", code }, theme: themeOf([]) },
  }),
];

/** Each org's rows, while the process runs. */
const stores = new Map<string, Store>();
/** Every org's visitors' connections, counted together: they share this listener. */
const visitors = contactsPool();

/** Each org's runtime, opened on first use, closed after 30 minutes nobody's used it. */
const orgs = runtimes(async (id) => {
  const org = await dir.query<OrgInfo | null>("org.info", { org: id });
  if (!org) return undefined;
  if (!stores.has(id)) stores.set(id, memoryStore());
  return await createRuntime({
    store: stores.get(id)!,
    plugins: [...plugins, ...page, directory.member(dir, org)],
    executors: 2,
    browsers: { pool: visitors },
  });
});

/** The page for someone signed in nowhere: the sign-in page, the ways to the directory's. */
const lobby = await createRuntime({ store: memoryStore(), plugins: page });

// The directory signs people in: by name, from this machine only.
const dir: Runtime = await createRuntime({
  store: memoryStore(),
  plugins: [
    identity,
    directory,
    devSignIn,
    definePlugin({ name: "directory-settings", resources: { directory: { orgs, lobby } } }),
  ],
});

const server = await listen(dir.fetch, { port: Number(values.port) });
console.log(`${server.url}`);

process.once("SIGINT", async () => {
  await server.shutdown();
  await orgs.close();
  await dir.close();
  await lobby.close();
  process.exit(0);
});
