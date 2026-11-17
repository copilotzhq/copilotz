/**
 * The toolkit's component tokens: each piece's sizes, radii, fonts and own
 * colours are CSS variables a theme sets (`theme.tokens`, `light`, `dark`),
 * each written with its default where it's used (`var(--button-height,
 * 36px)`). So every one has a default, the toolkit's guide lists every one,
 * and a theme's own tokens (`primary`, `radius`…) are never given a default
 * in a piece: those always come from the theme.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { assertEquals } from "@std/assert";
import { test } from "../../../testing/mod.ts";
import { DEFAULT_THEME } from "../theme/default.ts";

const toolkit = new URL("../toolkit/", import.meta.url).pathname;
const guide = readFileSync(
  new URL("../../../docs/guides/the-web-toolkit.md", import.meta.url),
  "utf8",
);

/** Every toolkit source file's text. */
const sources = () =>
  (readdirSync(toolkit, { recursive: true }) as string[])
    .filter((file) => /\.(ts|tsx)$/.test(file))
    .map((file) => ({ file, text: readFileSync(join(toolkit, file), "utf8") }));

/** The variables a piece uses with a default, by name, and where (the piece's own `--copilotz-*` aside). */
const defaulted = () => {
  const found = new Map<string, string>();
  for (const { file, text } of sources()) {
    for (const [, name] of text.matchAll(/var\(--([a-z][a-z0-9-]*)\s*,/g)) {
      if (!name.startsWith("copilotz-") && !found.has(name)) found.set(name, file);
    }
  }
  return found;
};

/** The theme's own tokens: its colours, radii and fonts. */
const THEME = new Set([
  ...Object.keys(DEFAULT_THEME.light ?? {}),
  ...Object.keys(DEFAULT_THEME.dark ?? {}),
  "radius",
  "radius-xs",
  "radius-sm",
  "radius-md",
  "radius-lg",
  "radius-xl",
  "radius-2xl",
  "radius-3xl",
  "radius-full",
  "font-sans",
  "font-display",
  "font-mono",
]);

test("every component token is in the toolkit's guide (docs/guides/the-web-toolkit.md)", () => {
  const missing = [...defaulted()].filter(([name]) => !guide.includes(`\`${name}\``))
    .map(([name, file]) => `${name} (${file})`);
  assertEquals(missing, []);
});

test("a theme's own tokens are never given a default in a piece", () => {
  const defaultedThemeTokens = [...defaulted()].filter(([name]) => THEME.has(name))
    .map(([name, file]) => `${name} (${file})`);
  assertEquals(defaultedThemeTokens, []);
});

test("a component token has the same default everywhere it's used", () => {
  const defaults = new Map<string, Set<string>>();
  for (const { text } of sources()) {
    // The default up to the first comma or bracket at its own depth: enough for the toolkit's own.
    for (const [, name, value] of text.matchAll(/var\(--([a-z][a-z0-9-]*)\s*,\s*([^(),]+)\)/g)) {
      if (name.startsWith("copilotz-")) continue;
      defaults.set(name, (defaults.get(name) ?? new Set()).add(value.trim()));
    }
  }
  const differing = [...defaults].filter(([, values]) => values.size > 1)
    .map(([name, values]) => `${name}: ${[...values].join(" | ")}`);
  assertEquals(differing, []);
});
