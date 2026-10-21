import { test } from "node:test";
import assert from "node:assert/strict";

const kit = new URL("../", import.meta.url);
const root = new URL("../../../", import.meta.url);

test("the kit stylesheet carries its own KaTeX, matching the KaTeX that renders math", async () => {
  const styles = await Deno.readTextFile(new URL("styles.css", kit));
  assert.match(styles, /@import "\.\/katex\/katex\.css";/);
  assert.doesNotMatch(styles, /@import "katex\//, "no bare package import");
  const css = await Deno.readTextFile(new URL("katex/katex.css", kit));
  const config = JSON.parse(
    await Deno.readTextFile(new URL("deno.json", root)),
  );
  const version = String(config.imports.katex).replace("npm:katex@", "");
  assert.ok(
    css.startsWith(`/*! KaTeX v${version} `),
    "re-run scripts/vendor-katex.ts after changing the katex version",
  );
  const fonts = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1]);
  assert.ok(fonts.length >= 20);
  for (const font of fonts) {
    assert.match(font, /^fonts\/KaTeX_[\w-]+\.woff2$/);
    await Deno.stat(new URL(`katex/${font}`, kit));
  }
});
