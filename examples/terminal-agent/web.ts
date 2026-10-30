/**
 * The terminal agent's app, served to browsers: the same plugins as the
 * terminal (app.ts), the web host's server half, and the browser's code
 * (browser.tsx), bundled on start. Sign in by name on this machine (dev), or
 * with Google when GOOGLE_CLIENT_ID is set. It's Copilotz, the web host's
 * default look (its fonts and icons served by the host itself);
 * `BRAND=harbor` serves the same app as another brand (harbor.tsx: one theme
 * resource, with its own logo), with its fonts from this server (fonts/, as
 * the app's assets), not Google's. People connect their computers here too
 * (`deno task computer connect http://127.0.0.1:<port> --code <code>`).
 *
 *   [BRAND=harbor] deno task web [--port=8790] [--sqlite[=path]]
 */
import { parseArgs } from "jsr:@std/cli@1.0.24/parse-args";
import { handler } from "@oxian/oxian-js/adapters/deno";
import { createRuntime, definePlugin, type Plugins } from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { googleSignIn } from "../../plugins/access/mod.ts";
import { createTickets } from "../../hosts/web/tickets.ts";
import { type Asset, type Code, socket, webServer } from "../../hosts/web/server.ts";
import { themeOf } from "../../hosts/web/theme/css.ts";
import { plugins } from "./app.ts";
import { harbor } from "./brands.ts";

const args = parseArgs(Deno.args, { string: ["port", "sqlite"] });
const port = Number(args.port ?? 8790);
const sqlite = args.sqlite === undefined ? undefined : args.sqlite || ".data/web.sqlite";
if (sqlite) await Deno.mkdir(".data", { recursive: true });
const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
/**
 * The page's code: the app's own, or a brand's (`BRAND=harbor`: harbor.tsx), the name it goes
 * by, its theme (the front ends' `theme` resources), which the page carries for its first paint,
 * and its own fonts (in fonts/: a stylesheet and the files it names), served at /assets/fonts/.
 * Copilotz needs none of its own: the web host serves the default theme's.
 */
const BRANDS: Record<string, { entry: string; title: string; theme: Plugins; fonts?: string[] }> = {
  copilotz: { entry: "./browser.tsx", title: "Copilotz", theme: [] },
  harbor: {
    entry: "./harbor.tsx",
    title: "Harbor",
    theme: [harbor],
    fonts: ["harbor.css", "plus-jakarta-sans-v12-latin.woff2", "jetbrains-mono-v24-latin.woff2"],
  },
};
const brand = BRANDS[Deno.env.get("BRAND") || "copilotz"];
if (!brand) throw new Error(`BRAND is one of ${Object.keys(BRANDS).join(", ")}`);

/** The brand's fonts, read from disk, as the server's assets. */
const assets: Record<string, Asset> = Object.fromEntries(
  await Promise.all(
    (brand.fonts ?? []).map(async (name) => [
      `/assets/fonts/${name}`,
      await Deno.readFile(new URL(`./fonts/${name}`, import.meta.url)),
    ]),
  ),
);

const tickets = createTickets();
const runtime = await createRuntime({
  store: sqlite ? await sqliteStore({ path: sqlite }) : memoryStore(),
  plugins: [
    ...plugins,
    ...(clientId
      ? [googleSignIn, definePlugin({ name: "google", resources: { google: { clientId } } })]
      : []),
    // Where computers connect: this server's socket.
    definePlugin({
      name: "computers-here",
      resources: { computers: { url: `http://127.0.0.1:${port}` } },
    }),
  ],
  executors: 2,
  transports: [socket],
  admit: tickets.admit,
});

/**
 * The browser's code, bundled for it, split where it imports lazily (math, a
 * terminal), so a page loads those only when it shows them.
 */
async function bundle(): Promise<Code> {
  const out = await Deno.makeTempDir();
  const entry = new URL(brand.entry, import.meta.url).pathname;
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
  return { entry: entry.split("/").pop()!.replace(/\.tsx?$/, ".js"), files };
}

const code = await bundle();
Deno.serve(
  { port, hostname: "127.0.0.1", onListen: () => console.log(`http://localhost:${port}`) },
  webServer({
    runtime,
    tickets,
    code,
    upgrade: handler(runtime.hypervisor),
    title: brand.title,
    theme: themeOf(brand.theme),
    assets,
    dev: true,
    ...(clientId ? { google: { clientId } } : {}),
  }),
);
