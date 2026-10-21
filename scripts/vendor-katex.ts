/**
 * Vendors KaTeX's stylesheet and fonts into the kit, so the kit stylesheet is
 * self-contained in linked checkouts and published installs alike. Run it
 * after changing the `katex` version: `deno run -A scripts/vendor-katex.ts`.
 * @module
 */
const root = new URL("../", import.meta.url);
const source = new URL("node_modules/katex/", root);
const target = new URL("plugins/ui-kit/katex/", root);
const { version } = JSON.parse(
  await Deno.readTextFile(new URL("package.json", source)),
) as { version: string };
const css = await Deno.readTextFile(new URL("dist/katex.min.css", source));
// Every supported browser reads woff2; drop the woff and ttf fallbacks so no
// URL points at a file the kit does not ship.
const woff2Only = css.replace(
  /,url\(fonts\/[\w-]+\.woff\) format\("woff"\),url\(fonts\/[\w-]+\.ttf\) format\("truetype"\)/g,
  "",
);
if (/\.(woff|ttf)\)/.test(woff2Only)) {
  throw new Error("KaTeX's stylesheet changed shape; update this script.");
}
await Deno.remove(target, { recursive: true }).catch(() => {});
await Deno.mkdir(new URL("fonts/", target), { recursive: true });
await Deno.writeTextFile(
  new URL("katex.css", target),
  `/*! KaTeX v${version} | MIT License | https://katex.org | vendored by scripts/vendor-katex.ts */\n${woff2Only}\n`,
);
await Deno.copyFile(new URL("LICENSE", source), new URL("LICENSE", target));
for await (const font of Deno.readDir(new URL("dist/fonts/", source))) {
  if (!font.name.endsWith(".woff2")) continue;
  await Deno.copyFile(
    new URL(`dist/fonts/${font.name}`, source),
    new URL(`fonts/${font.name}`, target),
  );
}
console.log(`Vendored KaTeX ${version} into plugins/ui-kit/katex/`);
