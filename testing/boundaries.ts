/**
 * An app's plugins keep to their boundaries, as Copilotz's own do
 * (testing/boundaries.test.ts): a plugin's files import another of the app's
 * plugins only through its `contract.ts`, and only one it `requires`, so what
 * it builds on is there when it starts and nothing reaches into another's
 * code. A test asks it and expects nothing back:
 *
 * ```ts
 * assert.deepEqual(boundaries({ root: new URL("../plugins/", import.meta.url), plugins: plugins() }), []);
 * ```
 *
 * Each folder under `root` is one of the app's plugins, named as its folder
 * (`folders` maps one that isn't: `{ "task-list": "tasks" }`). Tests and
 * folders of no plugin given are left out.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin, Plugins } from "../runtime/mod.ts";

/** The code files under `dir`, tests aside. */
function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "node_modules" || name === "tests" ? [] : files(path);
    }
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

/** Every relative module a file imports or re-exports, as written (its comments aside). */
function imports(path: string): string[] {
  const source = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  return [...source.matchAll(/(?:^|[\s}(=;,])(?:from|import)\s*\(?\s*(["'])([^"'\n]+)\1/g)]
    .map(([, , spec]) => spec)
    .filter((spec) => spec.startsWith("."));
}

/**
 * What breaks the boundaries of the app's plugins under `root`: each as
 * `<file> → <import>: why`, its paths from `root`. None when they're kept.
 */
export function boundaries(options: {
  root: string | URL;
  plugins: Plugins;
  folders?: Record<string, string>;
}): string[] {
  const root = normalize(
    typeof options.root === "string" ? options.root : fileURLToPath(options.root),
  );
  const byName = new Map(
    ((options.plugins as unknown[]).flat(Infinity) as Plugin[]).map((p) => [p.name, p]),
  );
  const nameOf = (folder: string) => options.folders?.[folder] ?? folder;
  const out: string[] = [];
  for (const folder of readdirSync(root)) {
    const plugin = byName.get(nameOf(folder));
    if (!plugin || !statSync(join(root, folder)).isDirectory()) continue;
    for (const file of files(join(root, folder))) {
      for (const spec of imports(file)) {
        const target = relative(root, normalize(join(dirname(file), spec)));
        const [other, ...rest] = target.split(sep);
        if (other === folder || other === ".." || !rest.length) continue;
        const otherPlugin = byName.get(nameOf(other));
        if (!otherPlugin) continue;
        const at = `${relative(root, file).split(sep).join("/")} → ${spec}`;
        if (rest.join("/") !== "contract.ts") {
          out.push(`${at}: another plugin's code; import its contract.ts`);
        } else if (!(plugin.requires ?? []).includes(otherPlugin.name)) {
          out.push(`${at}: "${plugin.name}" builds on "${otherPlugin.name}": add it to requires`);
        }
      }
    }
  }
  return out.sort();
}
