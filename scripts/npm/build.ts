/**
 * The npm package (`copilotz`), built from the TypeScript sources into
 * `dist/npm/`: the entry points `deno.json` exports (the same names on JSR and
 * npm) and everything they import, as JavaScript with `.d.ts` beside it.
 *
 * - Relative `.ts` and `.tsx` imports become `.js` (TypeScript's
 *   `rewriteRelativeImportExtensions`); JSX becomes `react/jsx-runtime` calls,
 *   so an app's bundler takes the browser's code (Views, the web host) as it is.
 * - Oxian and Ominipg go by their npm names (`oxianjs`, `ominipg`), at the
 *   versions `deno.json` pins for JSR.
 * - Its `package.json` lists the packages the built code imports: React as a
 *   peer (one copy, the app's), esbuild and PGlite as optional peers (bundling
 *   on Node, Postgres in the process), and the rest pinned as `deno.json` pins
 *   them. The web host's fonts and icon are modules, so they ship as code; their
 *   licenses ship beside them.
 *
 * Type errors stop the build. Runs on Node 24 (and Deno, Bun):
 *
 *   npm run build                       # node scripts/npm/build.ts [--out=dist/npm]
 *   cd dist/npm && npm pack             # what npm would publish
 */
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const outArg = process.argv.find((arg) => arg.startsWith("--out="))?.slice("--out=".length);
const OUT = resolve(ROOT, outArg ?? "dist/npm");

/** JSR packages, by the npm name they're published under. */
const ON_NPM: Record<string, string> = {
  "@oxian/oxian-js": "oxianjs",
  "@oxian/ominipg": "ominipg",
};
/** The app's own, so there's one copy of each: React, whose hooks need a single instance. */
const PEERS = new Set(["react", "react-dom"]);
/** Needed only for what uses them, by the app's choice (and its version). */
const OPTIONAL: Record<string, string> = {
  // The web host on Node bundles the browser's code with it (`copilotz/web/node`).
  esbuild: ">=0.20.0",
  // Postgres in this process (`postgresStore({ url: ":memory:" | "file://…" })`).
  "@electric-sql/pglite": "^0.4.5",
  // The front ends' types, for TypeScript.
  "@types/react": "^19.3.0",
};
/** What the stores need beyond what the sources import: Ominipg loads `pg` for `postgres://` URLs. */
const EXTRA: Record<string, string> = { pg: "8.23.1" };
/** Copied beside the code, as they are. */
const FILES = [
  "README.md",
  "CHANGELOG.md",
  "LICENSE",
  "hosts/web/theme/files/OFL-Manrope.txt",
  "hosts/web/theme/files/OFL-SpaceGrotesk.txt",
];

const fail = (message: string): never => {
  console.error(`npm build: ${message}`);
  process.exit(1);
};

const deno = JSON.parse(await readFile(join(ROOT, "deno.json"), "utf8")) as {
  version: string;
  exports: Record<string, string>;
  imports: Record<string, string>;
};
const root = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  description: string;
  engines: Record<string, string>;
};
if (root.version !== deno.version) {
  fail(`package.json is ${root.version}, deno.json ${deno.version}: make them the same`);
}

const entries = Object.entries(deno.exports);
const missing = [];
for (const [, path] of entries) {
  if (!(await stat(join(ROOT, path)).catch(() => undefined))) missing.push(path);
}
if (missing.length) fail(`deno.json exports files that aren't there: ${missing.join(", ")}`);

/** What each bare import resolves to on npm: its package and version, from deno.json's imports. */
const versions = new Map<string, string>();
for (const target of Object.values(deno.imports)) {
  const npm = /^npm:((?:@[^/@]+\/)?[^/@]+)@([^/]+)/.exec(target);
  const jsr = /^jsr:((?:@[^/@]+\/)[^/@]+)@([^/]+)/.exec(target);
  if (npm) versions.set(npm[1], npm[2]);
  else if (jsr && ON_NPM[jsr[1]]) versions.set(ON_NPM[jsr[1]], jsr[2]);
}

/** The npm names of Oxian and Ominipg, in every string the code holds them in. */
const renamed = (text: string) =>
  text.replace(
    /(["'`])(@oxian\/oxian-js|@oxian\/ominipg)(?=[/"'`])/g,
    (_, quote: string, name: string) => quote + ON_NPM[name],
  );
/** Relative `.ts`/`.tsx` imports in declarations, as the `.js` files they declare. */
const declared = (text: string) =>
  text.replace(
    /(["'])(\.\.?\/[^"'\n]*?)\.tsx?\1/g,
    (_, quote: string, path: string) => `${quote}${path}.js${quote}`,
  );

const config = ts.convertCompilerOptionsFromJson({
  target: "ES2022",
  module: "NodeNext",
  moduleResolution: "NodeNext",
  lib: ["ES2024", "DOM", "DOM.Iterable"],
  types: ["node"],
  jsx: "react-jsx",
  jsxImportSource: "react",
  rewriteRelativeImportExtensions: true,
  resolveJsonModule: true,
  declaration: true,
  strict: true,
  skipLibCheck: true,
  newLine: "lf",
  rootDir: ROOT,
  outDir: OUT,
}, ROOT);
if (config.errors.length) fail(ts.formatDiagnostics(config.errors, host()));

function host(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => "\n",
  };
}

await rm(OUT, { recursive: true, force: true });
const program = ts.createProgram({
  rootNames: entries.map(([, path]) => join(ROOT, path)),
  options: config.options,
});

/**
 * What looks like it's meant to be imported (a theme or plugin's `mod.ts`, a front end, a host or
 * a store) yet no entry point reaches: a plugin added without its theme's `mod.ts`, `web.tsx` or
 * `terminal.ts` naming it, or a module deno.json doesn't export. Said, not refused.
 */
const reached = new Set(program.getSourceFiles().map((file) => relative(ROOT, file.fileName)));
const PUBLIC =
  /^(plugins\/[^/]+(\/[^/]+)?\/(mod\.ts|web\.tsx|terminal\.ts)|(hosts|stores(\/[^/]+)?)\/[^/]+\/mod\.ts)$/;
const unreached: string[] = [];
const walk = async (dir: string): Promise<void> => {
  for (const entry of await readdir(join(ROOT, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory() && entry.name !== "tests") await walk(path);
    else if (PUBLIC.test(path) && !reached.has(path.split("/").join(sep))) unreached.push(path);
  }
};
for (const dir of ["plugins", "hosts", "stores"]) await walk(dir);
if (unreached.length) {
  console.warn(
    `npm build: no entry point reaches these (deno.json's exports, or their theme's mod.ts, web.tsx ` +
      `or terminal.ts, should name them):\n${unreached.map((path) => `  ${path}`).join("\n")}`,
  );
}

const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host()));
  fail(`${diagnostics.length} type errors`);
}

const written: string[] = [];
const emitted = program.emit(undefined, (file, text) => {
  const code = /\.(js|d\.ts)$/.test(file)
    ? renamed(file.endsWith(".d.ts") ? declared(text) : text)
    : text;
  written.push(file);
  ts.sys.writeFile(file, code);
});
if (emitted.emitSkipped || emitted.diagnostics.length) {
  fail(ts.formatDiagnostics(emitted.diagnostics, host()) || "emit skipped");
}
// JSON the code imports (the models catalog), as it is.
for (const source of program.getSourceFiles()) {
  if (!source.fileName.endsWith(".json") || source.fileName.includes("/node_modules/")) continue;
  const to = join(OUT, relative(ROOT, source.fileName));
  if (!written.includes(to)) {
    await mkdir(dirname(to), { recursive: true });
    await copyFile(source.fileName, to);
    written.push(to);
  }
}
for (const file of FILES) {
  await mkdir(dirname(join(OUT, file)), { recursive: true });
  await copyFile(join(ROOT, file), join(OUT, file));
}

/** The packages the built code imports, by name (`react/jsx-runtime` is `react`). */
const used = new Set<string>();
for (const file of written.filter((name) => /\.(js|d\.ts)$/.test(name))) {
  const { importedFiles } = ts.preProcessFile(await readFile(file, "utf8"), true, true);
  for (const { fileName: spec } of importedFiles) {
    if (spec.startsWith(".") || /^(node|bun):/.test(spec)) continue;
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0];
    used.add(name);
  }
}
const unknown = [...used].filter((name) => !versions.has(name) && !(name in OPTIONAL));
if (unknown.length) fail(`imported, but not in deno.json's imports: ${unknown.join(", ")}`);

const dependencies: Record<string, string> = { ...EXTRA };
const peerDependencies: Record<string, string> = {};
for (const name of [...used].sort()) {
  if (name in OPTIONAL) peerDependencies[name] = OPTIONAL[name];
  else if (PEERS.has(name)) peerDependencies[name] = `^${versions.get(name)}`;
  else if (name.startsWith("@types/")) continue;
  else dependencies[name] = versions.get(name)!;
}
// The front ends' declarations name React's types.
if (used.has("react")) peerDependencies["@types/react"] = OPTIONAL["@types/react"];
for (const name of Object.keys(OPTIONAL)) peerDependencies[name] ??= OPTIONAL[name];

const js = (path: string) => path.replace(/\.tsx?$/, ".js");
const types = (path: string) => path.replace(/\.tsx?$/, ".d.ts");
const manifest = {
  name: root.name,
  version: deno.version,
  description: root.description,
  keywords: ["agents", "ai", "llm", "runtime", "event-sourcing", "react", "deno", "bun"],
  homepage: "https://github.com/copilotzhq/copilotz#readme",
  bugs: "https://github.com/copilotzhq/copilotz/issues",
  repository: { type: "git", url: "git+https://github.com/copilotzhq/copilotz.git" },
  license: "MIT",
  type: "module",
  engines: root.engines,
  sideEffects: false,
  types: types(deno.exports["."]),
  exports: {
    ...Object.fromEntries(
      entries.map(([name, path]) => [name, { types: types(path), default: js(path) }]),
    ),
    "./package.json": "./package.json",
  },
  files: [
    ...new Set(
      written.map((file) => relative(OUT, file).split(sep)[0]).concat(
        FILES.map((file) => file.split("/")[0]),
      ),
    ),
  ].sort(),
  dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
  peerDependencies: Object.fromEntries(Object.entries(peerDependencies).sort()),
  peerDependenciesMeta: Object.fromEntries(
    Object.keys(OPTIONAL).sort().map((name) => [name, { optional: true }]),
  ),
};
await writeFile(join(OUT, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const size = async (dir: string): Promise<number> => {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await size(path) : (await stat(path)).size;
  }
  return total;
};
console.log(
  `${manifest.name}@${manifest.version}: ${entries.length} entry points, ${written.length} files, ` +
    `${(await size(OUT) / 1e6).toFixed(1)} MB in ${relative(ROOT, OUT)}/`,
);
