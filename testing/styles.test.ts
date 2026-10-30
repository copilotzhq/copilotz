/**
 * Plugins compose; they don't style. A plugin's own CSS (its `style.ts`
 * strings, `style={{…}}` props, SVG paint attributes) is only its layout, on
 * the theme's variables, so a theme rebrands every plugin. This fails on what
 * would escape the theme on the web:
 *
 * - **Colour literals**, anywhere in a declaration: hex (`#fff`), `rgb()`,
 *   `hsl()`, `hwb()`, `lab()`, `lch()`, `oklab()`, `oklch()`, `color()`, and
 *   named colours (`white`, `red`…) in properties that paint.
 * - **Raw shadows:** `box-shadow` and `text-shadow` whose layers aren't each
 *   a variable (`var(--shadow-md)`), and `drop-shadow()` of anything else.
 * - **Raw radii:** `border-radius` (and its corners) other than `0`, a
 *   radius variable (`var(--radius-lg)`, `var(--radius-full)`) or a
 *   `calc()` over one.
 *
 * It allows `var(--…)`, `color-mix()` over variables (`color-mix(in oklab,
 * var(--primary) 9%, var(--background))`), `transparent`, `currentColor`,
 * `inherit` (and `initial`, `unset`, `none`), and any length that isn't a
 * radius. Comments are ignored, and so is a plugin's own theme resource
 * (`resources/theme.ts`), where colours are data. Hosts aren't checked: the
 * web host's theme and toolkit are where the literals live.
 */
import { assertEquals } from "@std/assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { test } from "./mod.ts";

const ROOT = normalize(join(dirname(new URL(import.meta.url).pathname), ".."));

/** CSS's named colours (and `rebeccapurple`); `transparent` and `currentColor` are allowed. */
const NAMED = new Set(
  ("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue " +
    "blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk " +
    "crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki " +
    "darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen " +
    "darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue " +
    "dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite " +
    "gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki " +
    "lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan " +
    "lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen " +
    "magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen " +
    "mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream " +
    "mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid " +
    "palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum " +
    "powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown " +
    "seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen " +
    "steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow " +
    "yellowgreen").split(" "),
);

/** Properties that paint, where a word may be a named colour. */
const PAINTS =
  /^(--.*|color|background(-color|-image)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|fill|stroke|stop-color|flood-color|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?|scrollbar-color|box-shadow|text-shadow|filter)$/;
const HEX = /(?<![\w&#-])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![\w-])/i;
const FUNCTION = /(?<![\w-])(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(/i;
const KEYWORD = /^(none|inherit|initial|unset|revert)$/;
const RADIUS =
  /^(0|0px|var\(--radius[\w-]*\)|calc\(.*var\(--radius[\w-]*\).*\)|inherit|initial|unset|revert)$/;

/** A value's parts at its top level, split by `by` (commas, or spaces and slashes). */
function parts(value: string, by: RegExp): string[] {
  const out: string[] = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    else if (value[i] === ")") depth--;
    else if (depth === 0 && by.test(value[i])) {
      out.push(value.slice(at, i));
      at = i + 1;
    }
  }
  out.push(value.slice(at));
  return out.map((p) => p.trim()).filter(Boolean);
}

/** What's wrong with one declaration, if anything. */
export function problem(property: string, raw: string): string | undefined {
  const name = property.trim().replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`).toLowerCase();
  const value = raw.trim().replace(/\s*!important$/, "");
  // Names in variables and quoted strings (font names) aren't colours.
  const words = value.replace(/var\(--[\w-]+/g, "var(").replace(/(["'])[^"']*\1/g, "");
  const hex = HEX.exec(words);
  if (hex) return `the colour ${hex[0]}: use a theme variable`;
  const fn = FUNCTION.exec(words);
  if (fn) return `the colour ${fn[1]}(): use a theme variable, or color-mix() over them`;
  if (PAINTS.test(name)) {
    const named = words.toLowerCase().match(/[a-z]+/g)?.find((w) => NAMED.has(w));
    if (named) return `the colour "${named}": use a theme variable`;
  }
  if (name === "box-shadow" || name === "text-shadow") {
    const raw = parts(value, /,/).find((layer) =>
      !KEYWORD.test(layer) && !/^var\(--[\w-]+\)$/.test(layer)
    );
    if (raw) {
      return `the shadow "${raw}": use var(--shadow-sm), var(--shadow-md) or var(--shadow-lg)`;
    }
  }
  if (/drop-shadow\((?!\s*var\(--[\w-]+\)\s*\))/.test(value)) {
    return "a drop-shadow() of its own: use a shadow variable";
  }
  if (/^border(-[a-z]+)*-radius$/.test(name)) {
    const raw = parts(value, /[\s/]/).find((r) => !RADIUS.test(r));
    if (raw) return `the radius ${raw}: use var(--radius-…)`;
  }
  return undefined;
}

/** The source with its comments blanked (line breaks kept, so lines still count). */
function uncommented(source: string): string {
  const keep = (text: string) => text.replace(/[^\n]/g, " ");
  return source
    .replace(/\/\*[\s\S]*?\*\//g, keep)
    .replace(
      /(^|[ \t])\/\/.*$/gm,
      (all, before: string) => before + keep(all.slice(before.length)),
    );
}

const line = (source: string, at: number) => source.slice(0, at).split("\n").length;

/**
 * Every problem in one file's source, as `line: what`. Stylesheets are the
 * template literals given to something (`= \``, `(\``, `{\``) that hold
 * rules; inline styles are `style={{…}}`; paint is SVG's `fill`, `stroke`,
 * `stopColor` and `floodColor` attributes. (Ink's `color="cyan"`, in a
 * terminal View, is the terminal's palette, not the web's.)
 */
export function problems(source: string): string[] {
  const code = uncommented(source);
  const found: string[] = [];
  const check = (property: string, value: string, at: number) => {
    const why = problem(property, value);
    if (why) found.push(`${line(source, at)}: ${property.trim()}: ${value.trim()} (${why})`);
  };
  for (const m of code.matchAll(/[=({,]\s*`((?:[^`\\]|\\.)*)`/g)) {
    const css = m[1];
    if (!/[^{}]+\{[^{}]*:[^{}]*\}/.test(css)) continue;
    const at = m.index + m[0].indexOf("`") + 1;
    for (const d of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+)(?=[;}])/gi)) {
      check(d[1], d[2], at + d.index);
    }
  }
  for (const m of code.matchAll(/style=\{\{([\s\S]*?)\}\}/g)) {
    for (
      const d of m[1].matchAll(/([\w$]+|"[^"]+"|'[^']+')\s*:\s*("[^"]*"|'[^']*'|`[^`]*`|[^,}\n]+)/g)
    ) {
      check(d[1].replace(/["']/g, ""), d[2].replace(/^["'`]|["'`]$/g, ""), m.index + d.index);
    }
  }
  for (const m of code.matchAll(/\b(fill|stroke|stopColor|floodColor)=\{?\s*(["'`])([^"'`]*)\2/g)) {
    if (/^(none|currentColor|transparent|inherit)$|^url\(#/.test(m[3])) continue;
    check(m[1] === "stopColor" ? "stop-color" : m[1], m[3], m.index);
  }
  return found;
}

/** A plugin's code: its .ts and .tsx files, but not its tests or its own theme resource. */
function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "tests" ? [] : files(path);
    if (!/\.tsx?$/.test(name) || name.endsWith(".test.ts") || name.endsWith(".test.tsx")) return [];
    return path.endsWith(join("resources", "theme.ts")) ? [] : [path];
  });
}

test("the styles rule: what it allows, and what it doesn't", () => {
  const allowed = [
    ["color", "var(--muted-foreground)"],
    ["background", "color-mix(in oklab, var(--primary) 9%, var(--background))"],
    ["border", "1px solid var(--border)"],
    ["outline", "2px solid transparent"],
    ["color", "currentColor"],
    ["fill", "inherit"],
    ["box-shadow", "var(--shadow-sm), var(--shadow-md)"],
    ["box-shadow", "none"],
    ["border-radius", "var(--radius-xs) var(--radius-2xl) var(--radius-2xl) var(--radius-2xl)"],
    ["border-radius", "calc(var(--radius) * 2)"],
    ["border-radius", "0"],
    ["font-family", '"Gold Sans", var(--font-sans)'],
    ["grid-template-columns", "30px minmax(0, 1fr)"],
    ["animation", "chat-rise .2s ease-out"],
    ["--tone", "var(--warning)"],
  ];
  for (const [property, value] of allowed) assertEquals(problem(property, value), undefined, value);
  const refused = [
    ["color", "#fff"],
    ["background", "linear-gradient(#eef0ff, var(--card))"],
    ["border-color", "rgb(0 0 0 / .1)"],
    ["background", "oklch(0.7 0.1 250)"],
    ["background", "color-mix(in oklab, var(--primary) 50%, white)"],
    ["outline", "2px solid red"],
    ["--star", "#d97706"],
    ["box-shadow", "0 1px 2px var(--border)"],
    ["box-shadow", "var(--shadow-sm), 0 0 0 3px var(--ring)"],
    ["filter", "drop-shadow(0 1px 2px var(--border))"],
    ["border-radius", "12px"],
    ["border-top-left-radius", "50%"],
    ["borderRadius", "8"],
  ];
  for (const [property, value] of refused) {
    assertEquals(typeof problem(property, value), "string", value);
  }
  assertEquals(
    problems([
      "// A comment may say #fff.",
      "const STYLE = `.a { color: var(--fg); } /* red */",
      ".b:hover { background: #eee; border-radius: 6px; }`;",
      'const el = <svg><path fill="#fff" /><i style={{ boxShadow: "0 0 2px black" }} /></svg>;',
      'const ok = <i style={{ background: `var(--${token})`, gap: 10 }} fill="currentColor" />;',
    ].join("\n")).map((p) => p.split(" (")[0]),
    [
      "3: background: #eee",
      "3: border-radius: 6px",
      "4: boxShadow: 0 0 2px black",
      "4: fill: #fff",
    ],
  );
});

test("plugins style only their layout, on the theme's variables", () => {
  const found = files(join(ROOT, "plugins")).flatMap((path) =>
    problems(readFileSync(path, "utf8")).map((p) =>
      `${relative(ROOT, path).split(sep).join("/")}:${p}`
    )
  );
  assertEquals(found, []);
});
