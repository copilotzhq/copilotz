import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { JSONSchema } from "../runtime/define.ts";

const primitives = [
  "collections",
  "actions",
  "events",
  "processors",
  "schedules",
  "resources",
  "routes",
  "adapters",
  "views",
] as const;
type Primitive = typeof primitives[number];
type Entry = { file: string; kind: Primitive; key: string; port?: string };
type Host = "mod" | "web" | "terminal";
type Folder = { name: string; source: string; fields?: string; entries: Record<Host, Entry[]> };

function entries(dir: string) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  );
}

function invalid(file: string): never {
  throw new Error(
    `Unexpected declaration ${file}. Keep one default export per file and put shared code in lib/.`,
  );
}

function scan(folder: Folder, kind: Primitive, parts: string[] = []) {
  const dir = join(folder.source, kind, ...parts);
  for (const item of entries(dir)) {
    const file = join(dir, item.name);
    if (item.isDirectory() && (kind === "views" || (kind === "adapters" && !parts.length))) {
      scan(folder, kind, [...parts, item.name]);
      continue;
    }
    let host: Host = "mod";
    let prefix = parts;
    if (kind === "views" && (parts[0] === "web" || parts[0] === "terminal")) {
      host = parts[0];
      prefix = parts.slice(1);
    }
    const extension = host === "mod" ? /\.ts$/ : /\.tsx?$/;
    if (!item.isFile() || !extension.test(item.name) || item.name.endsWith(".d.ts")) invalid(file);
    const stem = item.name.replace(extension, "");
    if (!stem || (kind === "actions" && !/^[^.]+(?:\.[^.]+)+$/.test(stem))) invalid(file);
    if (kind === "adapters" && parts.length !== 1) invalid(file);
    const key = kind === "routes"
      ? "/" + stem
      : kind === "views"
      ? [...prefix, stem].join(":")
      : stem;
    const entry = {
      file,
      kind,
      key,
      port: kind === "adapters" ? parts[0] : undefined,
    };
    if (
      folder.entries[host].some((e) =>
        e.kind === kind && e.port === entry.port && e.key === entry.key
      )
    ) {
      throw new Error(`${file}: duplicate ${kind} name "${entry.key}".`);
    }
    folder.entries[host].push(entry);
  }
}

/** Reads the declarations of each plugin the app still assembles by filename. */
export function folders(root: string): Folder[] {
  const plugins = join(root, "plugins");
  if (!existsSync(plugins)) return [];
  return entries(plugins).filter((p) => p.isDirectory()).flatMap(({ name }) => {
    const source = join(plugins, name);
    if (existsSync(join(source, "mod.ts"))) return [];
    const folder: Folder = { name, source, entries: { mod: [], web: [], terminal: [] } };
    for (const item of entries(source)) {
      const file = join(source, item.name);
      if (
        item.name === "lib" && item.isDirectory() || item.name === "contract.ts" && item.isFile()
      ) continue;
      if (item.name === "plugin.ts" && item.isFile()) folder.fields = file;
      else if (item.isDirectory() && primitives.includes(item.name as Primitive)) {
        scan(folder, item.name as Primitive);
      } else invalid(file);
    }
    return [folder];
  });
}

/** Turns a relative filesystem path into an import, with forward slashes on Windows. */
export function specifier(path: string): string {
  const portable = path.replaceAll("\\", "/");
  if (/[#?%]/.test(portable)) {
    throw new Error(`A module filename cannot contain #, ? or %: ${path}`);
  }
  return portable.startsWith("../") ? portable : "./" + portable;
}

/** Makes the three host modules in memory. Ejection changes only where their imports start. */
export function modules(
  folder: Folder,
  dest: string,
  schemas: ReadonlyMap<string, JSONSchema>,
): Map<string, string> {
  const files = new Map<string, string>();
  for (const host of ["mod", "web", "terminal"] as const) {
    const imports = ['import { definePlugin } from "copilotz";'];
    const props = [
      `  name: ${JSON.stringify(host === "mod" ? folder.name : folder.name + "-" + host)},`,
    ];
    const add = (id: string, file: string) =>
      imports.push(`import ${id} from ${JSON.stringify(specifier(relative(dest, file)))};`);
    if (host === "mod" && folder.fields) {
      add("plugin", folder.fields);
      props.push("  ...plugin,");
    }
    const groups = new Map<string, string[]>();
    const ports = new Map<string, string[]>();
    const documents: string[] = [];
    const bindings = new Set<string>();
    for (const entry of folder.entries[host]) {
      const words = [entry.port, entry.key].filter(Boolean).join(" ").match(/[a-zA-Z0-9]+/g) ?? [];
      const base = entry.kind.slice(0, -1) +
        words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
      let id = base;
      for (let suffix = 2; bindings.has(id); suffix++) id = base + suffix;
      bindings.add(id);
      add(id, entry.file);
      const group = entry.port ? ports : groups;
      const key = entry.port ?? entry.kind;
      const lines = group.get(key) ?? [];
      const schema = schemas.get(entry.file);
      const name = JSON.stringify(entry.key);
      if (schema === undefined) lines.push(`${name}: ${id},`);
      else {
        const key = entry.kind === "actions" ? "input" : "schema";
        // In a JS object literal this key needs brackets to remain an own property.
        const literal = JSON.stringify(schema, null, 2).replace(
          /^(\s*)"__proto__":/gm,
          '$1["__proto__"]:',
        );
        lines.push(
          `${name}: {`,
          `  ...${id},`,
          ...`${key}: ${literal},`.split("\n").map((line) => "  " + line),
          "},",
        );
        if (entry.kind === "collections") {
          documents.push(`      ${name}: DocumentOf<typeof ${id}>;`);
        }
      }
      group.set(key, lines);
    }
    if (ports.size) {
      groups.set(
        "adapters",
        [...ports].flatMap(([port, lines]) => [
          `${JSON.stringify(port)}: {`,
          ...lines.map((line) => "  " + line),
          "},",
        ]),
      );
    }
    for (const [kind, lines] of groups) {
      props.push(
        `  ${kind}: {`,
        ...lines.map((line) => "    " + line),
        "  },",
      );
    }
    const types: string[] = [];
    if (documents.length) {
      imports.push('import type { DocumentOf } from "copilotz";');
      types.push(
        'declare module "copilotz" {',
        "  interface AppDocuments {",
        `    ${JSON.stringify(folder.name)}: {`,
        ...documents,
        "    };",
        "  }",
        "}",
        "",
      );
    }
    files.set(
      join(dest, host + ".ts"),
      [...imports, "", ...types, "export default definePlugin({", ...props, "});", ""].join("\n"),
    );
  }
  return files;
}
