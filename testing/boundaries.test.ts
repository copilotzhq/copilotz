/**
 * The layers, and what each may import:
 *
 * - `runtime/`, the engine and its ports: nothing outside it.
 * - `stores/` and `exporters/`, the ports' implementations (where the runtime
 *   keeps things; where measurements go): the runtime.
 * - `plugins/`, the standard plugins: the runtime, the hosts' toolkits, their
 *   own files, and other plugins' `contract.ts` (shapes, no code). One plugin
 *   reaches another only through the runtime, by name: its Actions, the
 *   resource kinds it reads, its events. The web host's toolkit is
 *   `hosts/web/mod.ts`, nothing deeper (plus `hosts/web/words.ts`, the words
 *   and formats, which draws nothing, so code that isn't React can use it). A
 *   theme's `contract.ts` gathers its plugins' contracts, and nothing else.
 * - `hosts/`, the media the app is used through (a terminal): the runtime.
 * - `packages/`, the product plugins (see design/plugins.md): a package
 *   imports Copilotz by its public entry points alone (`copilotz`,
 *   `copilotz/web`, `copilotz/plugins/access/contract`…, as deno.json exports
 *   them) and other packages by their contracts (`@copilotz/<name>/contract`),
 *   never a file outside itself; inside it, its plugins keep to the rule
 *   above. Nothing in the core (its tests included) imports a package.
 *
 * Tests, examples and a theme's own `mod.ts` and `terminal.ts` (a package's
 * too) compose the layers, so they may import anything they may reach.
 */
import { assertEquals } from "@std/assert";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "./mod.ts";

const ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), ".."));
const LAYERS = ["runtime", "stores", "exporters", "plugins", "hosts"];
/** The core, tests included: none of it imports a package. */
const CORE = [...LAYERS, "testing"];
const PACKAGES = join(ROOT, "packages");

/** The code files under `dir`, tests too when asked. */
function files(dir: string, tests = false): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "node_modules" || (name === "tests" && !tests) ? [] : files(path, tests);
    }
    return /\.tsx?$/.test(name) && (tests || !/\.test\.tsx?$/.test(name)) ? [path] : [];
  });
}

/** Every module specifier a file imports or re-exports, as written (its comments aside). */
function specifiers(path: string): string[] {
  const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const found = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"'\n]+)["']/g)];
  return found.map(([, spec]) => spec);
}

/** Every relative import or re-export in a file, as a path from the root. */
function imports(path: string): string[] {
  return specifiers(path).filter((spec) => spec.startsWith("."))
    .map((spec) => relative(ROOT, normalize(join(dirname(path), spec))));
}

const PRIMITIVES = [
  "actions",
  "adapters",
  "collections",
  "events",
  "processors",
  "resources",
  "routes",
  "shared",
  "views",
];
const roots = new Map<string, string | undefined>();

/** Where a file's plugins live: `plugins` for the standard ones, or its package's folder. */
const homeOf = (path: string) =>
  path.startsWith(`packages${sep}`) ? path.split(sep).slice(0, 2).join(sep) : "plugins";
/** A theme's folder (plugins/access) or a package's: what may gather its plugins. */
const gatherer = (dir: string) => dirname(dir) === "plugins" || dir === homeOf(dir);

/**
 * The plugin a file belongs to: the nearest folder laid out by primitive (or
 * with a contract.ts), in a theme of plugins/ or in a package. A theme's or a
 * package's own files (its mod.ts, web.tsx, the contract.ts gathering its
 * plugins') belong to none, unless the theme or package is one plugin itself.
 */
function pluginOf(path: string): string | undefined {
  const home = homeOf(path);
  if (!path.startsWith(home + sep)) return undefined;
  for (let dir = dirname(path); dir !== "plugins" && dir !== "."; dir = dirname(dir)) {
    if (!roots.has(dir)) {
      const names = readdirSync(join(ROOT, dir));
      const laidOut = names.some((name) =>
        PRIMITIVES.includes(name) && statSync(join(ROOT, dir, name)).isDirectory()
      );
      const own = names.includes("contract.ts") && !gatherer(dir);
      roots.set(dir, laidOut || own ? dir : undefined);
    }
    if (roots.get(dir)) return dir;
    if (dir === home) return undefined;
  }
  return undefined;
}

/** A theme's or a package's contract.ts that gathers its plugins' (not a plugin's own). */
const gathering = (path: string) =>
  basename(path) === "contract.ts" && gatherer(dirname(path)) && !pluginOf(path);

/** What a file may not import, and why. */
function broken(from: string, to: string): string | undefined {
  const [top] = to.split(sep);
  const area = from.split(sep)[0];
  if (top === "packages") return "a package: the core imports none";
  if (top === area && area !== "plugins") return undefined;
  if (area === "runtime") return `the runtime imports nothing outside it, not ${top}/`;
  if (area === "stores" || area === "exporters" || area === "hosts") {
    return top === "runtime" ? undefined : `${area}/ imports only the runtime, not ${top}/`;
  }
  if (gathering(from)) {
    return basename(to) === "contract.ts" && dirname(dirname(to)) === dirname(from)
      ? undefined
      : "a theme's contract.ts gathers its plugins' contract.ts, nothing else";
  }
  const mine = pluginOf(from);
  if (!mine) return undefined; // A theme's mod.ts or terminal.ts: it composes its plugins.
  if (
    to.startsWith(join("hosts", "web") + sep) && to !== join("hosts", "web", "mod.ts") &&
    to !== join("hosts", "web", "words.ts")
  ) {
    return "the web host's insides: import its toolkit from hosts/web/mod.ts";
  }
  if (top === "runtime" || top === "hosts") return undefined;
  if (top !== "plugins") return `a plugin imports the runtime, hosts and contracts, not ${top}/`;
  const theirs = pluginOf(to);
  if (theirs === mine) return undefined;
  if (theirs && to === join(theirs, "contract.ts")) return undefined;
  return "another plugin's code: call it by name, or import its contract.ts";
}

test("each layer imports only what it may: plugins reach each other through the runtime", () => {
  const found = LAYERS.flatMap((dir) => files(join(ROOT, dir)))
    .flatMap((path) => {
      const from = relative(ROOT, path);
      return imports(path).flatMap((to) => {
        const why = broken(from, to);
        return why ? [`${from} → ${to}: ${why}`] : [];
      });
    });
  assertEquals(found, []);
});

/** The packages here, by folder (`packages/work`, published as `@copilotz/work`). */
const packages = existsSync(PACKAGES)
  ? readdirSync(PACKAGES).filter((name) => existsSync(join(PACKAGES, name, "deno.json")))
  : [];

test("the core imports no package, its tests neither", () => {
  const named = /^(?:jsr:|npm:)?@copilotz\/(?!copilotz(?:[/@]|$))/;
  const found = CORE.flatMap((dir) => files(join(ROOT, dir), true)).flatMap((path) => {
    const from = relative(ROOT, path);
    return specifiers(path).flatMap((spec) => {
      const to = spec.startsWith(".") ? relative(ROOT, normalize(join(dirname(path), spec))) : "";
      return named.test(spec) || to.split(sep)[0] === "packages" ? [`${from} → ${spec}`] : [];
    });
  });
  assertEquals(found, []);
});

test("a package imports Copilotz by its entry points, other packages by their contracts", () => {
  const deno = JSON.parse(readFileSync(join(ROOT, "deno.json"), "utf8")) as {
    exports: Record<string, string>;
    imports: Record<string, string>;
  };
  /** `copilotz` and `copilotz/<entry>`, as the core's deno.json exports them. */
  const entries = new Set(Object.keys(deno.exports).map((key) => `copilotz${key.slice(1)}`));
  const mapped = (spec: string, map: Record<string, string> = {}) =>
    Object.keys(map).some((name) => spec === name || spec.startsWith(`${name}/`));
  const found = packages.flatMap((name) => {
    const home = join(ROOT, "packages", name);
    const own = JSON.parse(readFileSync(join(home, "deno.json"), "utf8")) as {
      name: string;
      imports?: Record<string, string>;
    };
    const problems = own.name === `@copilotz/${name}`
      ? []
      : [`packages/${name}/deno.json: named ${own.name}, not @copilotz/${name}`];
    for (const path of files(home, true)) {
      const from = relative(ROOT, path);
      for (const spec of specifiers(path)) {
        const other = /^@copilotz\/([^/]+)/.exec(spec)?.[1];
        const why = spec.startsWith(".")
          ? within(relative(ROOT, home), from, relative(ROOT, normalize(join(dirname(path), spec))))
          : spec === "copilotz" || spec.startsWith("copilotz/")
          ? entries.has(spec) ? undefined : "not one of copilotz's entry points"
          : other
          ? other !== name && packages.includes(other) && spec === `@copilotz/${other}/contract`
            ? undefined
            : "another package's code: import its contract (@copilotz/<name>/contract)"
          : spec.startsWith("node:") || mapped(spec, deno.imports) || mapped(spec, own.imports)
          ? undefined
          : "neither Copilotz nor in the import map";
        if (why) problems.push(`${from} → ${spec}: ${why}`);
      }
    }
    return problems;
  });
  assertEquals(found, []);
});

/** Inside a package: its own files, its plugins reaching each other by their contracts. */
function within(home: string, from: string, to: string): string | undefined {
  if (!to.startsWith(home + sep)) {
    return "a file outside the package: import copilotz's entry points";
  }
  if (gathering(from)) {
    return basename(to) === "contract.ts"
      ? undefined
      : "a package's contract.ts gathers its plugins' contract.ts, nothing else";
  }
  const mine = pluginOf(from);
  if (!mine) return undefined; // The package's mod.ts, web.tsx, terminal.ts, tests: they compose.
  const theirs = pluginOf(to);
  if (theirs === mine) return undefined;
  if (!theirs) return "the package's own entry points: a plugin imports its own files";
  return to === join(theirs, "contract.ts")
    ? undefined
    : "another plugin's code: call it by name, or import its contract.ts";
}
