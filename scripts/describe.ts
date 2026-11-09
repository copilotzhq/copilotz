/**
 * Describes a plugin: what it keeps, who may call what, where it shows, what
 * it needs and what it requires, read from the plugin itself (see
 * runtime/describe.ts) and from its code (scripts/describe/sources.ts).
 *
 *   deno run -A scripts/describe.ts <module> [export]       # its declaration, as JSON
 *   deno run -A scripts/describe.ts <module> [export] --markdown   # its reference page
 *   deno run -A scripts/describe.ts --docs                  # every page, and plugins.json
 *   deno run -A scripts/describe.ts --docs --check          # …only says if they're stale
 *
 * Without an export, a module's default plugin, or else every plugin it
 * exports. `--docs` describes every plugin Copilotz exports (its entry
 * points, `deno.json`'s `exports`) into `docs/reference/plugins/<name>.md`,
 * with `docs/reference/plugins.json` beside them (the hub's seed): each in
 * the layer scripts/describe/catalog.ts says, and those moving to Compass
 * left out.
 */
import { parseArgs } from "@std/cli";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Plugin } from "../runtime/mod.ts";
import {
  type Declaration,
  DECLARATION_FORMAT,
  describe,
  type SettingDeclaration,
} from "../runtime/describe.ts";
import { LAYERS, type Placed } from "./describe/catalog.ts";
import { page } from "./describe/markdown.ts";
import { found, urlOf } from "./describe/sources.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs/reference");

const KEYS = [
  "collections",
  "actions",
  "events",
  "processors",
  "views",
  "resources",
  "adapters",
  "schedules",
  "routes",
  "who",
  "guard",
  "workers",
  "check",
];

/** Whether a value is a plugin: a name, and something a plugin declares. */
const isPlugin = (value: unknown): value is Plugin =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  typeof (value as Plugin).name === "string" && KEYS.some((key) => key in (value as object));

/** A module's exports, named ones first (a default is often one of them again). */
const exportsOf = (module: Record<string, unknown>) =>
  Object.entries(module).sort(([a], [b]) =>
    (a === "default" ? 1 : 0) - (b === "default" ? 1 : 0) || (a < b ? -1 : a > b ? 1 : 0)
  );

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));

/**
 * The package a module is in, and the `copilotz` it runs on: the nearest
 * package.json, else deno.json, with a name.
 */
function packageOf(module: string): { package?: Declaration["package"]; runtime?: string } {
  for (let dir = dirname(module); dir !== dirname(dir); dir = dirname(dir)) {
    for (const file of ["package.json", "deno.json"]) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      const config = readJson(path);
      if (typeof config.name !== "string") continue;
      const pkg = { name: config.name as string, version: config.version as string | undefined };
      if (["copilotz", "@copilotz/copilotz"].includes(pkg.name)) {
        return { package: pkg, runtime: pkg.version };
      }
      const deps = { ...config.dependencies, ...config.peerDependencies } as Record<string, string>;
      const imports = Object.values(config.imports ?? {}) as string[];
      const runtime = deps.copilotz ??
        imports.map((spec) => spec.match(/^(?:npm:copilotz|jsr:@copilotz\/copilotz)@([^/]+)/)?.[1])
          .find(Boolean);
      return { package: pkg, ...(runtime ? { runtime } : {}) };
    }
  }
  return {};
}

/** Describes one plugin, with what its code shows. */
async function declare(
  plugin: Plugin,
  entry: string,
  exportName: string,
  options: {
    layer?: string;
    package?: Declaration["package"];
    runtime?: string;
    settings?: (settings: SettingDeclaration[]) => SettingDeclaration[];
  } = {},
): Promise<Declaration> {
  const code = await found(entry, exportName.split(".")[0], plugin.name);
  return await describe(plugin, {
    ...(code.summary ? { summary: code.summary } : {}),
    reads: code.reads,
    settings: options.settings ? options.settings(code.settings) : code.settings,
    ...(options.layer ? { layer: options.layer } : {}),
    ...(options.package ? { package: options.package } : {}),
    ...(options.runtime ? { runtime: options.runtime } : {}),
  });
}

// ---------------------------------------------------------------------------
// One module

async function one(path: string, wanted: string | undefined, markdown: boolean) {
  const entry = resolve(path);
  const module = await import(urlOf(entry)) as Record<string, unknown>;
  const picked: [string, Plugin][] = [];
  if (wanted) {
    const value = wanted.split(".").reduce<unknown>(
      (at, key) => (at as Record<string, unknown> | undefined)?.[key],
      module,
    );
    if (!isPlugin(value)) {
      throw new Error(
        typeof value === "function"
          ? `"${wanted}" makes a plugin: describe one it made, from a module of your own`
          : `"${wanted}" isn't a plugin ${path} exports`,
      );
    }
    picked.push([wanted, value]);
  } else if (isPlugin(module.default)) {
    picked.push(["default", module.default]);
  } else {
    const seen = new Set<unknown>();
    for (const [name, value] of exportsOf(module)) {
      if (isPlugin(value) && !seen.has(value)) picked.push([name, value]), seen.add(value);
    }
  }
  if (!picked.length) throw new Error(`${path} exports no plugin`);
  const where = packageOf(entry);
  const declarations = [];
  for (const [name, plugin] of picked) declarations.push(await declare(plugin, entry, name, where));
  if (markdown) {
    console.log(declarations.map((d) => page(d)).join("\n"));
  } else {
    console.log(
      JSON.stringify(declarations.length === 1 ? declarations[0] : declarations, null, 2),
    );
  }
}

// ---------------------------------------------------------------------------
// Every plugin Copilotz exports

type Found = {
  plugin: Plugin;
  /** Its export: `boards`, or `directory.member` for one a function makes. */
  name: string;
  /** The entry point it's exported from, as imported (`copilotz/plugins/work`). */
  module: string;
  entry: string;
  placed: Placed;
};

/** Every plugin in the package's entry points, by its layer. */
async function catalog(): Promise<{ found: Found[]; unplaced: string[] }> {
  const config = readJson(join(ROOT, "deno.json"));
  const npm = readJson(join(ROOT, "package.json")).name as string;
  const found: Found[] = [];
  const unplaced: string[] = [];
  const seen = new Set<unknown>();
  for (const [sub, path] of Object.entries(config.exports as Record<string, string>)) {
    const entry = join(ROOT, path);
    const module = await import(urlOf(entry)) as Record<string, unknown>;
    const as = `${npm}${sub.slice(1)}`;
    for (const [name, value] of exportsOf(module)) {
      if (seen.has(value)) continue;
      const placed = LAYERS[name];
      // A function that makes a plugin, and plugins a plugin carries (`directory.member`).
      const made = [
        ...typeof value === "function" && placed && placed !== "skip" && placed.make
          ? [[name, await placed.make(value)] as const]
          : [],
        ...isPlugin(value)
          ? Object.entries(value).flatMap(([key, inner]) => {
            const at = LAYERS[`${name}.${key}`];
            return typeof inner === "function" && at && at !== "skip" && at.make
              ? [[`${name}.${key}`, inner] as const]
              : [];
          })
          : [],
      ];
      for (const [madeName, maker] of made) {
        const at = LAYERS[madeName] as Placed;
        const plugin = typeof maker === "function" ? await at.make!(maker) : maker;
        found.push({ plugin, name: madeName, module: as, entry, placed: at });
      }
      if (!isPlugin(value)) continue;
      seen.add(value);
      if (!placed) unplaced.push(`${name} (${sub})`);
      else if (placed !== "skip") found.push({ plugin: value, name, module: as, entry, placed });
    }
  }
  return { found, unplaced };
}

/** Formats files as `deno fmt` would, with the repository's settings. */
async function formatted(files: Record<string, string>): Promise<Record<string, string>> {
  const dir = await Deno.makeTempDir();
  try {
    for (const [name, text] of Object.entries(files)) {
      await Deno.mkdir(dirname(join(dir, name)), { recursive: true });
      await Deno.writeTextFile(join(dir, name), text);
    }
    const fmt = await new Deno.Command(Deno.execPath(), {
      args: ["fmt", "--config", join(ROOT, "deno.json"), "--quiet", dir],
      stdout: "null",
      stderr: "inherit",
    }).output();
    if (!fmt.success) throw new Error("deno fmt failed on the pages");
    const out: Record<string, string> = {};
    for (const name of Object.keys(files)) out[name] = await Deno.readTextFile(join(dir, name));
    return out;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

async function docs(check: boolean) {
  const version = readJson(join(ROOT, "deno.json")).version as string;
  const npm = readJson(join(ROOT, "package.json")).name as string;
  const { found: all, unplaced } = await catalog();
  if (unplaced.length) {
    throw new Error(
      `No layer says where these ship (scripts/describe/catalog.ts): ${unplaced.join(", ")}`,
    );
  }
  const listed = all.filter((f) => f.placed.layer !== "private");
  const left = all.filter((f) => f.placed.layer === "private");
  // What each plugin's code shows, then its declaration; a front end's settings are its plugin's.
  const code = new Map(
    await Promise.all(
      listed.map(async (f) =>
        [f.plugin.name, await found(f.entry, f.name.split(".")[0], f.plugin.name)] as const
      ),
    ),
  );
  const described: { d: Declaration; f: Found }[] = [];
  for (const f of listed) {
    const own = code.get(f.plugin.name)!;
    const required = new Set(
      (f.plugin.requires ?? []).flatMap((name) => code.get(name)?.settings ?? []).map((s) =>
        s.kind
      ),
    );
    const standard = f.placed.layer === "standard";
    const d = await describe(f.plugin, {
      ...(own.summary ? { summary: own.summary } : {}),
      reads: own.reads,
      settings: own.settings.filter((s) => !required.has(s.kind)),
      layer: f.placed.layer,
      package: standard ? { name: npm, version } : { name: f.placed.package! },
      runtime: standard ? version : `^${version}`,
    });
    described.push({ d: f.placed.name ? { ...d, name: f.placed.name } : d, f });
  }
  described.sort((a, b) => a.d.name < b.d.name ? -1 : 1);
  const declarations = described.map(({ d }) => d);
  const pages = new Set(declarations.map((d) => d.name));
  const files: Record<string, string> = {};
  // A front end draws a plugin: `<name>-web`, or one that requires it (never a shell's).
  const front = /-(web|terminal)$/;
  for (const { d, f } of described) {
    const frontEnds = declarations.filter((other) =>
      other.name === `${d.name}-web` || other.name === `${d.name}-terminal` ||
      (front.test(other.name) && other.requires.includes(d.name) && !front.test(d.name) &&
        !/(^|-)shell$|^terminal$/.test(d.name))
    ).map((other) => other.name);
    files[`plugins/${d.name}.md`] = page(d, {
      module: f.module,
      export: f.name,
      frontEnds,
      pages,
      ...(f.placed.example ? { example: f.placed.example } : {}),
    });
  }
  files["plugins.md"] = index(declarations);
  files["plugins.json"] = JSON.stringify(
    { format: DECLARATION_FORMAT, runtime: version, plugins: declarations },
    null,
    2,
  ) + "\n";
  const out = await formatted(files);
  const stale: string[] = [];
  for (const [name, text] of Object.entries(out)) {
    const path = join(DOCS, name);
    const had = existsSync(path) ? await Deno.readTextFile(path) : undefined;
    if (had === text) continue;
    stale.push(name);
    if (!check) {
      await Deno.mkdir(dirname(path), { recursive: true });
      await Deno.writeTextFile(path, text);
    }
  }
  // Pages of plugins that are gone.
  const dir = join(DOCS, "plugins");
  for (const entry of existsSync(dir) ? Deno.readDirSync(dir) : []) {
    if (!entry.name.endsWith(".md") || `plugins/${entry.name}` in out) continue;
    stale.push(`plugins/${entry.name}`);
    if (!check) await Deno.remove(join(dir, entry.name));
  }
  const problems = declarations.filter((d) => !d.listing.listable).map((d) => d.name);
  console.error(
    `${declarations.length} plugins described; left out, moving to Compass: ${
      left.map((f) => f.plugin.name).join(", ")
    }.`,
  );
  if (problems.length) console.error(`Not listable as they are: ${problems.join(", ")}.`);
  if (check && stale.length) {
    console.error(`Stale: ${stale.join(", ")}. Run: deno run -A scripts/describe.ts --docs`);
    Deno.exit(1);
  }
  if (!check) console.error(stale.length ? `Wrote ${stale.length} files.` : "Nothing changed.");
}

/** The index of every page, by layer. */
function index(declarations: Declaration[]): string {
  const layers: [string, string][] = [
    ["standard", "In `copilotz`"],
    ["package", "In packages of their own"],
  ];
  const lines = [
    "---",
    'title: "Plugins"',
    `description: "Every plugin Copilotz exports: what it keeps, who may call what, where it shows, what it needs."`,
    "---",
    "",
    "<!-- Made by scripts/describe.ts from the plugins themselves: run it again rather than edit this page. -->",
    "",
    "# Plugins",
    "",
    "Each page here is read from the plugin itself, so it says what the code does. " +
    "`plugins.json` has the same, as data.",
    "",
  ];
  for (const [layer, title] of layers) {
    const here = declarations.filter((d) => d.layer === layer);
    if (!here.length) continue;
    lines.push(`## ${title}`, "");
    for (const d of here) {
      const from = layer === "package" ? ` In \`${d.package?.name}\`.` : "";
      lines.push(`- [\`${d.name}\`](plugins/${d.name}.md): ${d.summary ?? ""}${from}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

if (import.meta.main) {
  const args = parseArgs(Deno.args, { boolean: ["markdown", "docs", "check", "help"] });
  const [path, wanted] = args._.map(String);
  if (args.help || (!args.docs && !path)) {
    console.error(
      "deno run -A scripts/describe.ts <module> [export] [--markdown]\n" +
        "deno run -A scripts/describe.ts --docs [--check]",
    );
    Deno.exit(args.help ? 0 : 2);
  }
  try {
    if (args.docs) await docs(args.check);
    else await one(path, wanted, args.markdown);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(1);
  }
}
