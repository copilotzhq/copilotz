/**
 * The terminal agent's app, served to browsers: the same plugins as the
 * terminal (app.ts), the page (`webPage`), and the browser's code
 * (browser.tsx), bundled on start, all served by `runtime.fetch`. Sign in by name on this machine (dev), or
 * with Google when GOOGLE_CLIENT_ID is set. It's Copilotz, the web host's
 * default look (its fonts and icons served by the host itself);
 * `BRAND=harbor` serves the same app as another brand (harbor.tsx: one theme
 * resource, with its own logo), with its fonts from this server (fonts/, as
 * the app's assets), not Google's. People connect their computers here too:
 * with the computer program's release built (`node scripts/computer/build.ts`),
 * the app serves it, and the connect flow installs it; else from this code
 * (`deno task computer connect http://127.0.0.1:<port> --code <code>`).
 * With `EMAIL=1`, people sign in with an email and a password too
 * (`emailSignIn`): its codes and links are written to this terminal, or sent
 * with Resend when `RESEND_API_KEY` and `EMAIL_FROM` are set; with
 * `EMAIL_INVITE=<address>` as well, that address is invited as it starts
 * (its link, to choose a password, written here too).
 *
 *   [BRAND=harbor] [EMAIL=1] deno task web [--port=8790] [--sqlite[=path]]
 */
import { parseArgs } from "@std/cli/parse-args";
import { createRuntime, definePlugin, type Plugins } from "../../runtime/mod.ts";
import { memoryStore } from "../../stores/memory/mod.ts";
import { sqliteStore } from "../../stores/sql/sqlite/mod.ts";
import { devSignIn, email, emailSignIn, googleSignIn } from "../../plugins/access/mod.ts";
import { type Asset, type Code, webPage } from "../../hosts/web/server.ts";
import { themeOf } from "../../hosts/web/theme/css.ts";
import { computerDownloads } from "../../plugins/compute/computers/resources/downloads.ts";
import { VERSION } from "../../plugins/compute/computers/program/version.ts";
import { plugins } from "./app.ts";
import { harbor } from "./brands.ts";

const args = parseArgs(Deno.args, { string: ["port", "sqlite"] });
const port = Number(args.port ?? 8790);
const sqlite = args.sqlite === undefined ? undefined : args.sqlite || ".data/web.sqlite";
if (sqlite) await Deno.mkdir(".data", { recursive: true });
const clientId = Deno.env.get("GOOGLE_CLIENT_ID");
const resendKey = Deno.env.get("RESEND_API_KEY");

/**
 * Email sign-in, with `EMAIL=1`: links to this server, its codes sealed with a
 * secret made each start (codes in flight don't outlive it), and messages
 * written here unless Resend's key and a sender are given.
 */
const byEmail = Deno.env.get("EMAIL")
  ? [
    email,
    emailSignIn,
    definePlugin({
      name: "email-here",
      resources: {
        links: {
          origin: `http://localhost:${port}`,
          secret: `${crypto.randomUUID()}${crypto.randomUUID()}`,
        },
        email: resendKey && Deno.env.get("EMAIL_FROM")
          ? { adapter: "resend", apiKey: resendKey, from: Deno.env.get("EMAIL_FROM")! }
          : { adapter: "console" },
      },
    }),
  ]
  : [];
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

/** The computer program's release, when it's been built: served at /computer/download/. */
const release = new URL(`../../dist/computer/${VERSION}/`, import.meta.url);
const downloads = await Deno.stat(release).then(() => true, () => false)
  ? [await computerDownloads({ dir: release.pathname })]
  : [];

const runtime = await createRuntime({
  store: sqlite ? await sqliteStore({ path: sqlite }) : memoryStore(),
  plugins: [
    ...plugins,
    // Sign in by name on this machine, with Google when GOOGLE_CLIENT_ID is set, by email with EMAIL.
    devSignIn,
    ...(clientId
      ? [googleSignIn, definePlugin({ name: "google", resources: { google: { clientId } } })]
      : []),
    ...byEmail,
    // Where computers connect: this server's socket.
    definePlugin({
      name: "computers-here",
      resources: { computers: { url: `http://127.0.0.1:${port}` } },
    }),
    ...downloads,
    webPage,
    definePlugin({
      name: "page",
      resources: {
        // The code is bundled once, on the page's first request.
        page: { title: brand.title, code: bundle, assets },
        theme: themeOf(brand.theme),
      },
    }),
  ],
  executors: 2,
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

// Someone invited by email as it starts, to try the link: what trusted code (a webhook) does.
const invited = Deno.env.get("EMAIL_INVITE");
if (invited && byEmail.length) await runtime.call("email.invite", { email: invited });

// This machine alone (dev sign-in is its own); Deno hands the runtime each request's address.
Deno.serve(
  { port, hostname: "127.0.0.1", onListen: () => console.log(`http://localhost:${port}`) },
  runtime.fetch,
);
