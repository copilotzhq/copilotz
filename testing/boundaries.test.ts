/**
 * The layers, and what each may import:
 *
 * - `runtime/`, the engine and its ports: nothing outside it.
 * - `stores/` and `exporters/`, the ports' implementations (where the runtime
 *   keeps things; where measurements go): the runtime.
 * - `plugins/`, the features: the runtime, the hosts' toolkits, their own
 *   files, and other plugins' `contract.ts` (shapes, no code). One plugin
 *   reaches another only through the runtime, by name: its Actions, the
 *   resource kinds it reads, its events. The web host's toolkit is
 *   `hosts/web/mod.ts`, nothing deeper.
 * - `hosts/`, the media the app is used through (a terminal): the runtime.
 *
 * Tests, examples and a theme's own `mod.ts` and `terminal.ts` compose the
 * layers, so they may import anything.
 */
import { assertEquals } from "@std/assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { test } from "./mod.ts";

const ROOT = normalize(join(dirname(new URL(import.meta.url).pathname), ".."));
const LAYERS = ["runtime", "stores", "exporters", "plugins", "hosts"];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === "tests" ? [] : files(path);
    return /\.tsx?$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Every relative import or re-export in a file, as a path from the root. */
function imports(path: string): string[] {
  const source = readFileSync(path, "utf8");
  const found = [...source.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)];
  return found.map(([, spec]) => relative(ROOT, normalize(join(dirname(path), spec))));
}

const PRIMITIVES = [
  "actions",
  "adapters",
  "collections",
  "events",
  "processors",
  "resources",
  "shared",
  "views",
];
const roots = new Map<string, string | undefined>();

/**
 * The plugin a file belongs to: the nearest folder under plugins/ laid out by
 * primitive (or with a contract.ts). A theme's own files belong to none.
 */
function pluginOf(path: string): string | undefined {
  for (let dir = dirname(path); dir.startsWith(`plugins${sep}`); dir = dirname(dir)) {
    if (!roots.has(dir)) {
      const names = readdirSync(join(ROOT, dir));
      const root = names.includes("contract.ts") ||
        names.some((name) =>
          PRIMITIVES.includes(name) && statSync(join(ROOT, dir, name)).isDirectory()
        );
      roots.set(dir, root ? dir : undefined);
    }
    if (roots.get(dir)) return dir;
  }
  return undefined;
}

/** What a file may not import, and why. */
function broken(from: string, to: string): string | undefined {
  const [top] = to.split(sep);
  const area = from.split(sep)[0];
  if (top === area && area !== "plugins") return undefined;
  if (area === "runtime") return `the runtime imports nothing outside it, not ${top}/`;
  if (area === "stores" || area === "exporters" || area === "hosts") {
    return top === "runtime" ? undefined : `${area}/ imports only the runtime, not ${top}/`;
  }
  const mine = pluginOf(from);
  if (!mine) return undefined; // A theme's mod.ts or terminal.ts: it composes its plugins.
  if (to.startsWith(join("hosts", "web") + sep) && to !== join("hosts", "web", "mod.ts")) {
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
