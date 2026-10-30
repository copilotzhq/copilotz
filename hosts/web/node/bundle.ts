/**
 * The browser's code, bundled on Node with esbuild: the page's entry (the app's
 * `web({ root, plugins })`) and everything it imports, the web host and the
 * front ends included, as `webServer` serves it (`Code`). Split where the code
 * imports lazily (math, a terminal), so a page loads those only when it shows
 * them, as `deno bundle --code-splitting` does on Deno.
 *
 * esbuild is the app's to install (`npm install esbuild`): only bundling needs
 * it, so an app that bundles at build time serves without it.
 */
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Code } from "../server.ts";

export type BundleOptions = {
  /** Minified, for production (the default); `false` keeps names and React's checks. */
  minify?: boolean;
};

/** Bundles a page's entry (a path, or a `file:` URL such as `new URL("./browser.tsx", import.meta.url)`). */
export async function bundle(entry: string | URL, options: BundleOptions = {}): Promise<Code> {
  const minify = options.minify ?? true;
  const path = typeof entry === "string" ? entry : fileURLToPath(entry);
  const esbuild = await import("esbuild").catch((error) => {
    throw Object.assign(
      new Error("bundle: esbuild isn't installed; install it to bundle the browser's code"),
      { code: "missing_esbuild", cause: error },
    );
  });
  // Nothing is written: the files come back in memory, named as they'd be in `outdir`.
  const outdir = join(dirname(path), ".bundle");
  const result = await esbuild.build({
    entryPoints: [path],
    bundle: true,
    splitting: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    minify,
    outdir,
    entryNames: "[name]",
    chunkNames: "[name]-[hash]",
    write: false,
    metafile: true,
    logLevel: "silent",
    define: { "process.env.NODE_ENV": JSON.stringify(minify ? "production" : "development") },
  });
  const files: Code["files"] = {};
  for (const file of result.outputFiles) files[relative(outdir, file.path)] = file.text;
  const out = Object.entries(result.metafile.outputs).find(([, output]) => output.entryPoint);
  if (!out) throw Object.assign(new Error(`bundle: no entry for ${path}`), { code: "no_entry" });
  return { entry: basename(out[0]), files };
}
