/** Build-host-only plugin discovery and source generation. Never imported by runtime. @module */
import ts from "typescript";
import { dirname, join, relative, resolve } from "node:path";

export interface BuildConfig {
  id: string;
  version: string;
  /** Relative entry path to explicit runtime alias. */
  aliases?: Record<string, string>;
  /** Statically imported plugin dependencies. */
  plugins?: { from: string; export: string }[];
  /** Deliberately selected entries. Omit to discover every conventional entry. */
  include?: string[];
}

export interface Entry {
  path: string;
  category: string;
  namespace?: string;
  alias: string;
}

const categories = [
  "collections",
  "actions",
  "processors",
  "resources",
  "adapters",
];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const aliasFrom = (name: string) =>
  name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
const aliasPattern = /^[a-z][a-zA-Z0-9_]*$/;

async function configArguments(root: string): Promise<string[]> {
  for (let directory = resolve(root);;) {
    for (const name of ["deno.json", "deno.jsonc"]) {
      const path = join(directory, name);
      if (await Deno.stat(path).then(() => true).catch(() => false)) {
        return ["--config", path];
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return [];
    directory = parent;
  }
}

async function files(directory: string, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (
      entry.isDirectory && ["internal", "dependencies"].includes(entry.name)
    ) {
      throw new Error(
        `${prefix}${entry.name}: use primitive-local helpers, shared/, or manifest plugin imports.`,
      );
    }
    if (
      ["shared", "authoring", "node_modules", "dist", ".git"].includes(
        entry.name,
      )
    ) continue;
    const name = prefix + entry.name;
    if (entry.isDirectory && !entry.isSymlink) {
      result.push(...await files(join(directory, entry.name), name + "/"));
    } else if (entry.isFile) result.push(name);
  }
  return result.sort(compare);
}

/** Validate an already-read source inventory without filesystem access. */
export function inventory(
  sources: Readonly<Record<string, string>>,
  config: BuildConfig,
): Entry[] {
  if (!config.id?.trim() || !config.version?.trim()) {
    throw new Error("copilotz.json requires id and version.");
  }
  if (
    config.include &&
    (!Array.isArray(config.include) ||
      config.include.some((path) => typeof path !== "string") ||
      new Set(config.include).size !== config.include.length)
  ) throw new TypeError("include must contain distinct entry paths.");
  if (
    config.aliases &&
    (typeof config.aliases !== "object" || Array.isArray(config.aliases))
  ) throw new TypeError("aliases must be a path-to-alias map.");
  if (config.plugins !== undefined) {
    if (!Array.isArray(config.plugins)) {
      throw new TypeError("plugins must be an array.");
    }
    const seen = new Set<string>();
    for (const entry of config.plugins) {
      if (
        !entry || typeof entry.from !== "string" || !entry.from.trim() ||
        typeof entry.export !== "string" ||
        !/^[A-Za-z_$][\w$]*$/.test(entry.export)
      ) {
        throw new TypeError(
          "plugins entries require from and a valid export name.",
        );
      }
      const key = `${entry.from}#${entry.export}`;
      if (seen.has(key)) throw new Error(`Duplicate plugin import: ${key}`);
      seen.add(key);
    }
  }
  const entries: Entry[] = [];
  const aliases = new Map<string, string>();
  const matched = new Set<string>();
  for (const path of Object.keys(sources).sort(compare)) {
    const parts = path.split("/");
    const category = parts[0];
    if (!categories.includes(category) || parts.at(-1) !== "index.ts") continue;
    const namespaced = category === "resources" || category === "adapters";
    if (parts.length !== (namespaced ? 4 : 3)) continue;
    if (config.include && !config.include.includes(path)) continue;
    matched.add(path);
    const source = sources[path];
    const tree = ts.createSourceFile(
      path,
      source,
      ts.ScriptTarget.Latest,
      true,
    );
    const hasDefault = tree.statements.some((node) =>
      ts.isExportAssignment(node) && !node.isExportEquals ||
      ts.isExportDeclaration(node) && node.exportClause &&
        ts.isNamedExports(node.exportClause) &&
        node.exportClause.elements.some((item) =>
          item.name.text === "default"
        ) ||
      ts.canHaveModifiers(node) &&
        ts.getModifiers(node)?.some((m) =>
          m.kind === ts.SyntaxKind.DefaultKeyword
        )
    );
    if (!hasDefault) throw new Error(`${path}: expected a default export.`);
    const namespace = namespaced ? parts[1] : undefined;
    const alias = config.aliases?.[path] ?? aliasFrom(parts.at(-2)!);
    for (const name of [alias, ...(namespace ? [namespace] : [])]) {
      if (
        !aliasPattern.test(name) ||
        ["constructor", "prototype", "__proto__"].includes(name)
      ) {
        throw new Error(`${path}: invalid alias or namespace '${name}'.`);
      }
    }
    const key = [category, namespace, alias].filter(Boolean).join(".");
    if (aliases.has(key)) {
      throw new Error(`Duplicate ${key}: ${aliases.get(key)} and ${path}.`);
    }
    aliases.set(key, path);
    entries.push({ path, category, namespace, alias });
  }
  for (
    const path of [
      ...Object.keys(config.aliases ?? {}),
      ...config.include ?? [],
    ]
  ) {
    if (!matched.has(path)) {
      throw new Error(`Configured entry '${path}' was not discovered.`);
    }
  }
  return entries;
}

export async function discover(
  root: string,
  config: BuildConfig,
): Promise<Entry[]> {
  const paths = (await files(root)).filter((path) =>
    path.endsWith("/index.ts")
  );
  const sources = await Promise.all(
    paths.map(async (path) =>
      [path, await Deno.readTextFile(join(root, path))] as const
    ),
  );
  return inventory(Object.fromEntries(sources), config);
}

/** Generate ordinary static imports. Discovery never evaluates source modules. */
export async function generate(root: string): Promise<string> {
  const config: BuildConfig = JSON.parse(
    await Deno.readTextFile(join(root, "copilotz.json")),
  );
  return emitPlugin(config, await discover(root, config));
}

/** Deterministic ESM-compatible TypeScript composition, independent of I/O. */
export function emitPlugin(
  config: BuildConfig,
  entries: readonly Entry[],
): string {
  const lines = [
    "// Generated by copilotz build. Edit source declarations, not this file.",
    'import { definePlugin, type DefinedPlugin } from "@copilotz/copilotz/plugins";',
    ...entries.map((entry, i) =>
      `import entry${i} from ${JSON.stringify("./" + entry.path)};`
    ),
    ...(config.plugins ?? []).map((entry, i) =>
      `import { ${entry.export} as dependency${i} } from ${
        JSON.stringify(entry.from)
      };`
    ),
    "const definition = {",
    `  id: ${JSON.stringify(config.id)},`,
    `  version: ${JSON.stringify(config.version)},`,
  ];
  if (config.plugins?.length) {
    lines.push(
      `  plugins: [${
        config.plugins.map((_, i) => `dependency${i}`).join(", ")
      }],`,
    );
  }
  for (const category of categories) {
    const group = entries.map((entry, i) => ({ ...entry, i })).filter((e) =>
      e.category === category
    );
    if (!group.length) continue;
    if (category === "resources" || category === "adapters") {
      lines.push(`  ${category}: {`);
      for (
        const namespace of [...new Set(group.map((e) => e.namespace!))].sort(
          compare,
        )
      ) {
        lines.push(`    ${JSON.stringify(namespace)}: {`);
        for (const e of group.filter((e) => e.namespace === namespace)) {
          lines.push(`      ${JSON.stringify(e.alias)}: entry${e.i},`);
        }
        lines.push("    },");
      }
      lines.push("  },");
    } else {
      lines.push(`  ${category}: {`);
      for (const e of group) {
        lines.push(`    ${JSON.stringify(e.alias)}: entry${e.i},`);
      }
      lines.push("  },");
    }
  }
  lines.push(
    "} as const;",
    "const plugin: DefinedPlugin<typeof definition> = definePlugin(definition);",
    "export default plugin;",
    "",
  );
  return lines.join("\n");
}

export async function build(
  root: string,
  options: {
    check?: boolean;
    sourceOnly?: boolean;
    output?: string;
    platform?: "browser" | "deno";
  } = {},
) {
  root = resolve(root);
  const source = await generate(root);
  const entry = join(root, "plugin.generated.ts");
  if (options.check) {
    if (await Deno.readTextFile(entry).catch(() => "") !== source) {
      throw new Error(`${entry} is stale. Run copilotz build.`);
    }
    return;
  }
  await Deno.writeTextFile(entry, source);
  if (options.sourceOnly) return;
  const output = resolve(options.output ?? join(root, "dist/plugin.js"));
  if (!relative(root, output)) throw new Error("Output must be a file.");
  await Deno.mkdir(dirname(output), { recursive: true });
  const config = await configArguments(root);
  const check = await new Deno.Command(Deno.execPath(), {
    args: ["check", ...config, entry],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!check.success) throw new Error("Generated plugin type check failed.");
  const validation = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--allow-read",
      ...config,
      new URL("./validate.ts", import.meta.url).href,
      entry,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!validation.success) {
    throw new Error("Generated plugin composition validation failed.");
  }
  const temporary = output + ".tmp.js";
  const bundle = await new Deno.Command(Deno.execPath(), {
    args: [
      "bundle",
      ...config,
      "--format=esm",
      "--platform=" + (options.platform ?? "browser"),
      "--output=" + temporary,
      entry,
    ],
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!bundle.success) {
    await Deno.remove(temporary).catch(() => undefined);
    throw new Error(
      "Plugin ESM build failed; use --platform=deno for native adapters.",
    );
  }
  await Deno.rename(temporary, output);
}

if (import.meta.main) {
  const [command, ...args] = Deno.args;
  if (command !== "build") {
    throw new Error(
      "Usage: copilotz build [roots...] [--source-only] [--check] [--output=path] [--platform=browser|deno]",
    );
  }
  const unknown = args.find((arg) =>
    arg.startsWith("--") && !["--source-only", "--check"].includes(arg) &&
    !arg.startsWith("--output=") && !arg.startsWith("--platform=")
  );
  if (unknown) throw new Error(`Unknown argument ${unknown}`);
  const platform = args.find((arg) =>
    arg.startsWith("--platform=")
  )?.slice(11) ?? "browser";
  if (platform !== "browser" && platform !== "deno") {
    throw new Error("platform must be browser or deno");
  }
  const roots = args.filter((arg) => !arg.startsWith("--"));
  if (!roots.length) roots.push(".");
  const output = args.find((arg) => arg.startsWith("--output="))?.slice(9);
  if (roots.length > 1 && output) {
    throw new Error("--output requires a single root.");
  }
  // Inventory all explicit roots before checking dependency imports between them.
  for (const root of roots) {
    await build(root, { sourceOnly: true, check: args.includes("--check") });
  }
  if (!args.includes("--source-only") && !args.includes("--check")) {
    for (const root of roots) {
      await build(root, { platform, output });
    }
  }
}

export { validatePlugin } from "./validate.ts";
