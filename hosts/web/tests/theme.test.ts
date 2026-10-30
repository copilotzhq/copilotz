/**
 * The web host's theme: the defaults (Copilotz's) with the front ends'
 * `theme` resources merged over them in order, as CSS variables for light
 * and dark; fonts and the logo each given whole; radii that scale with
 * `radius`; values that can't end a declaration are left out; fonts load
 * only from Google Fonts or the app's own origin; a logo is path data and
 * colours, or a plain path, and nothing else; the page's icon is its mark.
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { definePlugin } from "../../../runtime/mod.ts";
import { test } from "../../../testing/mod.ts";
import { fontsOf, plainColour, preloadsOf, themeCss, themeOf } from "../theme/css.ts";
import { COPILOTZ_FULL, COPILOTZ_MARK } from "../theme/copilotz.ts";
import { DEFAULT_THEME, SYSTEM_MONO, SYSTEM_SANS } from "../theme/default.ts";
import { iconSvg } from "../theme/icon.ts";
import { pictureOf } from "../theme/picture.ts";

const theme = (name: string, value: unknown) =>
  definePlugin({ name, resources: { theme: value as Record<string, unknown> } });

test("themes merge over the defaults in order; null takes a token out", () => {
  const merged = themeOf([
    theme("a", { radius: "6px", light: { primary: "#111111", ring: null } }),
    theme("b", { light: { primary: "#0f766e" }, dark: { primary: "#2dd4bf" } }),
  ]);
  assertEquals(merged.radius, "6px");
  assertEquals(merged.light?.primary, "#0f766e");
  assertEquals(merged.dark?.primary, "#2dd4bf");
  assertEquals(merged.light?.ring, undefined);
  assertEquals(merged.light?.background, DEFAULT_THEME.light?.background);
  assertEquals(themeOf([]), DEFAULT_THEME);
});

test("as CSS: light on :root, dark under the media query, radii from radius", () => {
  const css = themeCss(themeOf([theme("brand", { radius: "8px", light: { primary: "#0f766e" } })]));
  assertMatch(css, /^:root \{\n  color-scheme: light dark;/);
  assertMatch(css, /--radius: 8px;/);
  assertMatch(css, /--radius-xl: calc\(var\(--radius\) \* 7 \/ 6\);/);
  assertMatch(css, /--primary: #0f766e;/);
  assertMatch(css, /@media \(prefers-color-scheme: dark\) \{\n:root \{\n[^}]*--primary: #1bdada;/);
});

test("Copilotz by default: its logo, Manrope for text and Space Grotesk for headings, its own", () => {
  const theme = themeOf([]);
  assertEquals(theme.logo?.mark, COPILOTZ_MARK);
  assertEquals(theme.logo?.full, COPILOTZ_FULL);
  const css = themeCss(theme);
  assertMatch(css, /--font-sans: "Manrope", ui-sans-serif/);
  assertMatch(css, /--font-display: "Space Grotesk", "Manrope", ui-sans-serif/);
  assertEquals(fontsOf(theme), "/assets/copilotz/fonts.css");
  assertEquals(preloadsOf(theme), [
    { href: "/assets/copilotz/manrope-v23-latin.woff2", type: "font/woff2" },
    { href: "/assets/copilotz/space-grotesk-v22-latin.woff2", type: "font/woff2" },
  ]);
});

test("fonts and the logo are given whole: one brand's never mix with another's", () => {
  const merged = themeOf([
    theme("brand", {
      font: { sans: '"Inter", sans-serif', url: "/assets/fonts/inter.css" },
      logo: { mark: { viewBox: "0 0 8 8", paths: [{ d: "M0 0h8v8H0z" }] } },
      light: { primary: "#0f766e" },
    }),
    theme("later", { light: { ring: "#2dd4bf" } }),
  ]);
  assertEquals(merged.font, { sans: '"Inter", sans-serif', url: "/assets/fonts/inter.css" });
  assertEquals(merged.logo, { mark: { viewBox: "0 0 8 8", paths: [{ d: "M0 0h8v8H0z" }] } });
  assertEquals(preloadsOf(merged), [], "the defaults' fonts aren't fetched for another brand");
  const css = themeCss(merged);
  assertMatch(css, /--font-display: var\(--font-sans\);/);
  assertMatch(css, new RegExp(`--font-mono: ${SYSTEM_MONO.replace(/[()"]/g, "\\$&")};`));
  assertMatch(css, /--primary: #0f766e;/);
  assertMatch(css, /--background: #ffffff;/, "colours still patch token by token");
  // Null: none at all; the system's fonts.
  const bare = themeOf([theme("bare", { font: null, logo: null })]);
  assertEquals(bare.logo, undefined);
  assertEquals(bare.font, undefined);
  assertMatch(themeCss(bare), new RegExp(`--font-sans: ${SYSTEM_SANS.replace(/[()"]/g, "\\$&")};`));
});

test("a logo is path data and colours, or a plain path on the app's own origin", () => {
  const box = (paths: unknown[], viewBox = "0 0 10 10") => pictureOf({ viewBox, paths });
  const good = { viewBox: "0 0 10 10", paths: [{ d: "M0 0h10v10H0z", fill: "currentColor" }] };
  assertEquals(pictureOf(good), good);
  for (
    const fill of [
      "#19F9F0",
      "teal",
      "var(--primary)",
      "light-dark(#0f766e, #2dd4bf)",
      "color-mix(in oklab, var(--primary) 50%, white)",
      "oklch(0.7 0.1 210)",
    ]
  ) assert(box([{ d: "M0 0h1v1z", fill }]), fill);
  for (
    const [what, paths, viewBox] of [
      ["a url", [{ d: "M0 0h1v1z", fill: "url(https://evil.example/x.svg#a)" }]],
      ["a url, spaced", [{ d: "M0 0h1v1z", fill: "url (x)" }]],
      ["markup in a colour", [{ d: "M0 0h1v1z", fill: '"><script>alert(1)</script>' }]],
      ["markup in a path", [{ d: 'M0 0"/><script>alert(1)</script>' }]],
      ["a style in a colour", [{ d: "M0 0h1v1z", fill: "red; background: url(x)" }]],
      ["no paths", []],
      ["a path that's not one", [{ d: 42 }]],
      ["a bad box", [{ d: "M0 0h1v1z" }], "0 0 10"],
      ["markup in the box", [{ d: "M0 0h1v1z" }], '0 0 10 10"><script>'],
    ] as [string, unknown[], string?][]
  ) assertEquals(box(paths, viewBox), undefined, what);
  assertEquals(pictureOf("/assets/brand/logo.png"), "/assets/brand/logo.png");
  for (
    const refused of [
      "https://evil.example/logo.png",
      "//evil.example/logo.png",
      "javascript:alert(1)",
      "/assets/../app.js",
      '/assets/logo.png"><script>',
    ]
  ) assertEquals(pictureOf(refused), undefined, refused);
});

test("the page's icon is the mark, square, in the theme's text colours", () => {
  const svg = iconSvg(themeOf([]))!;
  assertMatch(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="100 184 400 400">/);
  assertMatch(
    svg,
    /svg\{color:#131b2f\}@media \(prefers-color-scheme:dark\)\{svg\{color:#eaf0f5\}\}/,
  );
  assertMatch(svg, /fill="currentColor"/);
  assertMatch(svg, /fill="#19F9F0"/);
  const wide = iconSvg(
    themeOf([
      theme("wide", { logo: { mark: { viewBox: "0 0 20 10", paths: [{ d: "M0 0h20v10H0z" }] } } }),
    ]),
  )!;
  assertMatch(wide, /viewBox="0 -5 20 20"/, "a wide mark is centred in a square");
  assertEquals(
    iconSvg(themeOf([theme("file", { logo: { mark: "/assets/mark.png" } })])),
    undefined,
  );
  assertEquals(iconSvg(themeOf([theme("none", { logo: null })])), undefined);
});

test("a colour for the browser's own parts is plain: no variables, nothing that ends an attribute", () => {
  for (
    const ok of ["#0c101d", "white", "rgb(19 27 47)", "hsl(224 42% 8%)", "oklch(70% 0.1 210deg)"]
  ) {
    assertEquals(plainColour(ok), ok);
  }
  for (
    const no of ["var(--background)", "color-mix(in oklab, red, blue)", '#fff" onload="x', "red;"]
  ) {
    assertEquals(plainColour(no), undefined, no);
  }
});

test("only font files on the app's own origin are preloaded", () => {
  const preload = (files: unknown) => preloadsOf({ font: { preload: files as string[] } });
  assertEquals(preload(["/assets/fonts/a.woff2", "/assets/fonts/b.ttf?v=2"]), [
    { href: "/assets/fonts/a.woff2", type: "font/woff2" },
    { href: "/assets/fonts/b.ttf?v=2", type: "font/ttf" },
  ]);
  assertEquals(
    preload(["https://fonts.gstatic.com/a.woff2", "/assets/fonts/a.css", "/assets/../a.woff2", 7]),
    [],
  );
  assertEquals(preload("/assets/fonts/a.woff2"), []);
});

test("a theme without dark is light only", () => {
  const css = themeCss(themeOf([theme("light-only", { dark: null })]));
  assertMatch(css, /color-scheme: light;/);
  assert(!css.includes("prefers-color-scheme"));
});

test("what can't be a token is left out", () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const css = themeCss({
      light: { primary: "red; } body { display: none", "--card": "#fff", "Bad Name": "#000" },
    });
    assert(!css.includes("display: none"));
    assert(!css.includes("Bad Name"));
    assertMatch(css, /--card: #fff;/);
  } finally {
    console.warn = warn;
  }
});

test("fonts come from Google Fonts, or a plain path on the app's own origin", () => {
  const fonts = (url: string) => fontsOf({ font: { url } });
  const google = "https://fonts.googleapis.com/css2?family=Inter&display=swap";
  assertEquals(fonts(google), google);
  assertEquals(fonts("/assets/fonts/harbor.css"), "/assets/fonts/harbor.css");
  assertEquals(fonts("/assets/fonts/brand.css?v=2"), "/assets/fonts/brand.css?v=2");
  for (
    const refused of [
      "https://evil.example/fonts.css",
      "http://fonts.googleapis.com/css2?family=Inter",
      `${google}" onload="x`,
      "//evil.example/fonts.css",
      "assets/fonts/harbor.css",
      "/assets/../app.js",
      "/assets/%2e%2e/app.js",
      "/assets/fonts%2Fharbor.css",
      "/assets\\fonts.css",
      "/assets/my fonts.css",
      "/assets/fonts.css'",
      '/assets/fonts.css"><script>',
      "javascript:alert(1)",
      "",
    ]
  ) assertEquals(fonts(refused), undefined, refused);
});
