/**
 * Builds the demo: `deno run -A contracts/web-demo/build.ts` writes
 * `contracts/web-demo/dist/` (bundle, stylesheet and page). Serve that
 * folder from any static server on localhost.
 * @module
 */
const root = new URL("../../", import.meta.url);
const here = new URL("./", import.meta.url);
const out = new URL("dist/", here);
await Deno.mkdir(out, { recursive: true });
const run = async (args: string[]) => {
  const result = await new Deno.Command(Deno.execPath(), {
    args,
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) throw new Error(`Failed: deno ${args.join(" ")}`);
};
await run([
  "bundle",
  "--platform=browser",
  "--node-modules-dir=auto",
  "--minify",
  "contracts/web-demo/main.tsx",
  "--output",
  "contracts/web-demo/dist/demo.js",
]);
await run([
  "run",
  "-A",
  "--node-modules-dir=auto",
  "npm:@tailwindcss/cli@4.1.12",
  "-i",
  "contracts/web-demo/styles.css",
  "-o",
  "contracts/web-demo/dist/demo.css",
]);
await Deno.copyFile(new URL("index.html", here), new URL("index.html", out));
// KaTeX's stylesheet loads its fonts from `fonts/` next to the CSS.
const fonts = new URL("node_modules/katex/dist/fonts/", root);
await Deno.mkdir(new URL("fonts/", out), { recursive: true });
for await (const font of Deno.readDir(fonts)) {
  if (font.name.endsWith(".woff2")) {
    await Deno.copyFile(
      new URL(font.name, fonts),
      new URL(`fonts/${font.name}`, out),
    );
  }
}
console.log("Built contracts/web-demo/dist");
