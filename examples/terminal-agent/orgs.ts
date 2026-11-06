/**
 * The example app, serving many orgs behind one address (see design/tenancy.md
 * and the directory plugin): a directory runtime signs people in and knows
 * their orgs, and its `fetch` is the whole app; each org is a runtime of its
 * own, opened when first used, closed when idle (`runtimes`), its rows a
 * tenant of one shared schema with Postgres.
 *
 *   deno run -A --unstable-no-legacy-abort --env-file=.env examples/terminal-agent/orgs.ts [--port 8800]
 *     [--hostname 0.0.0.0]        everyone's, not this machine's alone: then no sign-in by name
 *     [--postgres=postgres://…]   every org a tenant of one shared schema, on one
 *                                 pool of connections (else in memory); staff
 *                                 can then move, export and delete orgs
 *     STAFF=you@example.com       platform staff, who go into any org
 *
 * Sign in by name on this machine (`ana@example.com`), or with Google when
 * GOOGLE_CLIENT_ID is set.
 */
import { parseArgs } from "@std/cli/parse-args";
import {
  createRuntime,
  definePlugin,
  type Runtime,
  runtimes,
  type Store,
} from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import {
  copyTenant,
  dropTenant,
  exportTenant,
  postgresPool,
  postgresStore,
} from "../../stores/sql/postgres/mod.ts";
import {
  devSignIn,
  directory,
  googleSignIn,
  identity,
  type Operations,
  type OrgInfo,
} from "../../plugins/access/mod.ts";
import { type Code, webPage } from "../../hosts/web/server.ts";
import { themeOf } from "../../hosts/web/theme/css.ts";
import { plugins } from "./app.ts";

const args = parseArgs(Deno.args, { string: ["port", "postgres", "hostname"] });
const port = Number(args.port ?? 8800);
/** Where it listens: this machine alone, unless said (`--hostname 0.0.0.0`: everyone's). */
const hostname = args.hostname ?? "127.0.0.1";
/** Signing in by name (staff's emails among them) only while nobody else can reach it. */
const local = hostname === "127.0.0.1" || hostname === "localhost";
const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
const google = clientId
  ? [googleSignIn, definePlugin({ name: "google", resources: { google: { clientId } } })]
  : [];

/** Every org's connections: one pool, however many orgs are open. */
const pool = args.postgres ? await postgresPool({ url: args.postgres }) : undefined;

/** Memory's stores, by org, while the process runs. */
const kept = new Map<string, Store>();
/** A store: an org's tenant of its schema, or memory. */
const storeOf = async (schema: string, tenant?: string): Promise<Store> => {
  if (pool) return await postgresStore({ pool, schema, ...(tenant ? { tenant } : {}) });
  const key = `${schema}/${tenant ?? ""}`;
  if (!kept.has(key)) kept.set(key, memoryStore());
  return kept.get(key)!;
};

/** What staff may do to an org's rows, where they are in Postgres. */
const operations: Operations | undefined = pool && {
  async move(org, to) {
    const from = { pool, schema: org.placement.schema };
    await copyTenant({ from, to: { pool, schema: to.schema }, tenant: org.id });
    await dropTenant({ ...from, tenant: org.id });
  },
  export: (org) => exportTenant({ pool, schema: org.placement.schema, tenant: org.id }),
  async drop(org) {
    await dropTenant({ pool, schema: org.placement.schema, tenant: org.id });
  },
};

/** The browser's code, bundled once, on the first page asked for: the lobby's and every org's. */
let bundled: Promise<Code> | undefined;
/** The page, the same wherever it's served (an org's under its address: `page.base`). */
const page = [
  webPage,
  definePlugin({
    name: "page",
    resources: {
      page: { title: "Copilotz", code: () => bundled ??= bundle() },
      theme: themeOf([]),
    },
  }),
];

/** Each org's runtime, opened on first use, closed after 30 minutes nobody's used it. */
const orgs = runtimes(async (id) => {
  const org = await dir.query<OrgInfo | null>("org.info", { org: id });
  if (!org) return undefined;
  return await createRuntime({
    store: await storeOf(org.placement.schema, org.id),
    plugins: [
      ...plugins,
      ...page,
      // Where its computers connect: its own address on this server.
      definePlugin({
        name: "computers-here",
        resources: { computers: { url: `http://127.0.0.1:${port}` } },
      }),
      directory.member(dir, org),
    ],
    executors: 2,
  });
});

/** The page for someone signed in nowhere: the sign-in page, the ways to the directory's. */
const lobby = await createRuntime({ store: memoryStore(), plugins: page });

const dir: Runtime = await createRuntime({
  store: await storeOf("directory"),
  plugins: [
    identity,
    directory,
    // Sign in by name on this machine (listening on it alone), and with Google when
    // GOOGLE_CLIENT_ID is set.
    ...(local ? [devSignIn] : []),
    ...google,
    definePlugin({
      name: "directory-settings",
      resources: {
        directory: {
          staff: (Deno.env.get("STAFF") ?? "").split(",").filter(Boolean),
          orgs,
          lobby,
          ...(operations ? { operations } : {}),
        },
      },
    }),
  ],
});

/** The browser's code, bundled once, split where it imports lazily. */
async function bundle(): Promise<Code> {
  const out = await Deno.makeTempDir();
  const entry = new URL("./browser.tsx", import.meta.url).pathname;
  const { success, stderr } = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      "--platform",
      "browser",
      "--minify",
      "--code-splitting",
      "--outdir",
      out,
      entry,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!success) throw new Error(new TextDecoder().decode(stderr));
  const files: Code["files"] = {};
  for await (const file of Deno.readDir(out)) {
    files[file.name] = await Deno.readTextFile(`${out}/${file.name}`);
  }
  await Deno.remove(out, { recursive: true });
  return { entry: "browser.js", files };
}

// Deno hands the directory each request's address, and sockets it forwards are Deno's to accept.
Deno.serve(
  { port, hostname, onListen: () => console.log(`http://${hostname}:${port}`) },
  dir.fetch,
);
