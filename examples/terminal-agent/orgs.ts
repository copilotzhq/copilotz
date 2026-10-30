/**
 * The example app, serving many orgs behind one address (see design/tenancy.md
 * and `hosts/orgs`): a directory signs people in and knows their orgs; each
 * org is a runtime of its own, opened when first used.
 *
 *   deno run -A --unstable-no-legacy-abort --env-file=.env examples/terminal-agent/orgs.ts [--port 8800]
 *     [--postgres=postgres://…]   every org a tenant of one shared schema, on one
 *                                 pool of connections (else in memory); staff
 *                                 can then move, export and delete orgs
 *     STAFF=you@example.com       platform staff, who go into any org
 *
 * Sign in by name on this machine (`ana@example.com`), or with Google when
 * GOOGLE_CLIENT_ID is set.
 */
import { parseArgs } from "jsr:@std/cli@1.0.24/parse-args";
import { handler } from "@oxian/oxian-js/adapters/deno";
import { createRuntime, definePlugin, type Store } from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import {
  copyTenant,
  dropTenant,
  exportTenant,
  postgresPool,
  postgresStore,
} from "../../stores/sql/postgres/mod.ts";
import { googleSignIn, identity } from "../../plugins/access/mod.ts";
import { directory } from "../../plugins/access/directory/mod.ts";
import { socket } from "../../hosts/web/server.ts";
import { themeOf } from "../../hosts/web/theme/css.ts";
import { type OrgInfo, orgsHost } from "../../hosts/orgs/mod.ts";
import { plugins } from "./app.ts";

const args = parseArgs(Deno.args, { string: ["port", "postgres"] });
const port = Number(args.port ?? 8800);
const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
const google = clientId
  ? [googleSignIn, definePlugin({ name: "google", resources: { google: { clientId } } })]
  : [];

/** Every org's connections: one pool, however many orgs are open. */
const pool = args.postgres ? await postgresPool({ url: args.postgres }) : undefined;

/** A store: an org's tenant of its schema, or memory. */
const storeOf = async (schema: string, tenant?: string): Promise<Store> =>
  pool ? await postgresStore({ pool, schema, ...(tenant ? { tenant } : {}) }) : memoryStore();

/** What staff may do to an org's rows, where they are in Postgres. */
const operations = pool && {
  async move(org: OrgInfo, to: OrgInfo["placement"]) {
    const from = { pool, schema: org.placement.schema };
    await copyTenant({ from, to: { pool, schema: to.schema }, tenant: org.id });
    await dropTenant({ ...from, tenant: org.id });
  },
  export: (org: OrgInfo) => exportTenant({ pool, schema: org.placement.schema, tenant: org.id }),
  async drop(org: OrgInfo) {
    await dropTenant({ pool, schema: org.placement.schema, tenant: org.id });
  },
};

const dir = await createRuntime({
  store: await storeOf("directory"),
  plugins: [
    identity,
    directory,
    ...google,
    definePlugin({
      name: "directory-settings",
      resources: {
        directory: { staff: (Deno.env.get("STAFF") ?? "").split(",").filter(Boolean) },
      },
    }),
  ],
});

const host = orgsHost({
  directory: dir,
  open: async (org, given) =>
    await createRuntime({
      store: await storeOf(org.placement.schema, org.id),
      plugins: [
        ...plugins,
        ...given.plugins,
        definePlugin({
          name: "computers-here",
          resources: { computers: { url: `http://127.0.0.1:${port}` } },
        }),
      ],
      executors: 2,
      transports: [socket],
      admit: given.admit,
    }),
  upgrade: (runtime, request) => handler(runtime.hypervisor)(request),
  ...(operations ? { operations } : {}),
  code: await bundle(),
  title: "Copilotz",
  theme: themeOf([]),
  dev: true,
  ...(clientId ? { google: { clientId } } : {}),
});

/** The browser's code, bundled once, split where it imports lazily. */
async function bundle() {
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
  const files: Record<string, string> = {};
  for await (const file of Deno.readDir(out)) {
    files[file.name] = await Deno.readTextFile(`${out}/${file.name}`);
  }
  await Deno.remove(out, { recursive: true });
  return { entry: "browser.js", files };
}

Deno.serve(
  { port, hostname: "127.0.0.1", onListen: () => console.log(`http://localhost:${port}`) },
  host.serve,
);
