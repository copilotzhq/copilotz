/**
 * The npm packages, built from the TypeScript sources: Copilotz (`copilotz`)
 * into `dist/npm/`, and each product package (`packages/<name>`,
 * `@copilotz/<name>`) into `dist/packages/<name>/`: the entry points its
 * `deno.json` exports (the same names on JSR and npm) and everything they
 * import, as JavaScript with `.d.ts` beside it.
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
 * - A product package imports Copilotz by its entry points (`copilotz/web`…),
 *   typed by the core's build, so the core is built first. Copilotz is its
 *   peer at the same version (one runtime per app, as React is one), and so is
 *   any other package it imports (a contract). Every version agrees: the
 *   package's deno.json and package.json, the Copilotz its deno.json imports,
 *   and Copilotz's own.
 *
 * Type errors stop the build. Runs on Node 24 (and Deno, Bun):
 *
 *   npm run build                              # --all: the core, then every package
 *   node scripts/npm/build.ts                  # the core alone [--out=dist/npm]
 *   node scripts/npm/build.ts --package=work   # one package, once the core is built
 *   cd dist/npm && npm pack                    # what npm would publish
 */
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const arg = (name: string) =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const CORE = resolve(ROOT, arg("out") ?? "dist/npm");
/** Where each package's build goes: `dist/packages/<name>/`. */
const PACKAGES = join(ROOT, "dist", "packages");

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
/** Copied beside the code, as they are. AGENTS.md is the guide an app's coding agent finds there. */
const FILES = [
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "LICENSE",
  "hosts/web/theme/files/OFL-Manrope.txt",
  "hosts/web/theme/files/OFL-SpaceGrotesk.txt",
];

const fail = (message: string): never => {
  console.error(`npm build: ${message}`);
  process.exit(1);
};

type Deno = {
  name: string;
  version: string;
  exports: Record<string, string>;
  imports: Record<string, string>;
};
type Npm = {
  name: string;
  version: string;
  description: string;
  engines: Record<string, string>;
  exports?: Record<string, string>;
};
const json = async <T>(path: string) => JSON.parse(await readFile(path, "utf8")) as T;

const deno = await json<Deno>(join(ROOT, "deno.json"));
const root = await json<Npm>(join(ROOT, "package.json"));
if (root.version !== deno.version) {
  fail(`package.json is ${root.version}, deno.json ${deno.version}: make them the same`);
}
// In this repo, Node and Bun find `copilotz/…` by package.json's exports: the same as deno.json's.
if (JSON.stringify(root.exports) !== JSON.stringify(deno.exports)) {
  fail("package.json's exports aren't deno.json's: make them the same");
}

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

function host(): ts.FormatDiagnosticsHost {
  return {
    getCanonicalFileName: (name) => name,
    getCurrentDirectory: () => ROOT,
    getNewLine: () => "\n",
  };
}

/** The compiler's options, for sources under `rootDir` built into `outDir`. */
function optionsFor(rootDir: string, outDir: string, paths?: Record<string, string[]>) {
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
    rootDir,
    outDir,
    ...(paths ? { paths } : {}),
  }, ROOT);
  if (config.errors.length) fail(ts.formatDiagnostics(config.errors, host()));
  return config.options;
}

/** Type-checks `program` and writes it out (Oxian and Ominipg by their npm names): what it wrote. */
function emit(program: ts.Program): string[] {
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
  return written;
}

/** What the built code imports, as written (`copilotz/web`, `react/jsx-runtime`). */
async function specifiersIn(written: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (const file of written.filter((name) => /\.(js|d\.ts)$/.test(name))) {
    const { importedFiles } = ts.preProcessFile(await readFile(file, "utf8"), true, true);
    for (const { fileName: spec } of importedFiles) {
      if (!spec.startsWith(".") && !/^(node|bun):/.test(spec)) found.add(spec);
    }
  }
  return found;
}

/** The packages specifiers name (`react/jsx-runtime` is `react`). */
const packagesOf = (specs: Set<string>) =>
  new Set(
    [...specs].map((spec) =>
      spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
    ),
  );

const js = (path: string) => path.replace(/\.tsx?$/, ".js");
const types = (path: string) => path.replace(/\.tsx?$/, ".d.ts");

const size = async (dir: string): Promise<number> => {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? await size(path) : (await stat(path)).size;
  }
  return total;
};

/** Copilotz itself, `copilotz`, into `out`. */
async function buildCore(out: string) {
  const entries = Object.entries(deno.exports);
  const missing = [];
  for (const [, path] of entries) {
    if (!(await stat(join(ROOT, path)).catch(() => undefined))) missing.push(path);
  }
  if (missing.length) fail(`deno.json exports files that aren't there: ${missing.join(", ")}`);

  await rm(out, { recursive: true, force: true });
  const program = ts.createProgram({
    rootNames: entries.map(([, path]) => join(ROOT, path)),
    options: optionsFor(ROOT, out),
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

  const written = emit(program);
  // JSON the code imports (the models catalog), as it is.
  for (const source of program.getSourceFiles()) {
    if (!source.fileName.endsWith(".json") || source.fileName.includes("/node_modules/")) continue;
    const to = join(out, relative(ROOT, source.fileName));
    if (!written.includes(to)) {
      await mkdir(dirname(to), { recursive: true });
      await copyFile(source.fileName, to);
      written.push(to);
    }
  }
  for (const file of FILES) {
    await mkdir(dirname(join(out, file)), { recursive: true });
    await copyFile(join(ROOT, file), join(out, file));
  }

  const used = packagesOf(await specifiersIn(written));
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
        written.map((file) => relative(out, file).split(sep)[0]).concat(
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
  await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `${manifest.name}@${manifest.version}: ${entries.length} entry points, ${written.length} files, ` +
      `${(await size(out) / 1e6).toFixed(1)} MB in ${relative(ROOT, out)}/`,
  );
}

/** The product packages here: each folder of `packages/` with a deno.json. */
async function packageNames(): Promise<string[]> {
  const found = await readdir(join(ROOT, "packages"), { withFileTypes: true });
  return found.filter((entry) =>
    entry.isDirectory() && existsSync(join(ROOT, "packages", entry.name, "deno.json"))
  ).map((entry) => entry.name).sort();
}

/** A product package, `@copilotz/<name>`, into `dist/packages/<name>/`, typed by the core's build. */
async function buildPackage(name: string) {
  const home = join(ROOT, "packages", name);
  if (!existsSync(join(home, "deno.json"))) fail(`there's no packages/${name}/deno.json`);
  const own = await json<Deno>(join(home, "deno.json"));
  const npm = await json<Npm>(join(home, "package.json"));
  const core = await json<{ version: string; exports: Record<string, unknown> }>(
    join(CORE, "package.json"),
  ).catch(() => fail(`build the core first: there's no ${relative(ROOT, CORE)}/package.json`));
  const said: Record<string, string | undefined> = {
    "its deno.json": own.version,
    "its package.json": npm.version,
    "the Copilotz its deno.json imports": /^jsr:@copilotz\/copilotz@(.+)$/.exec(
      own.imports?.copilotz ?? "",
    )?.[1],
    "Copilotz's deno.json": deno.version,
    "Copilotz's build": core.version,
  };
  if (new Set(Object.values(said)).size !== 1) {
    const each = Object.entries(said).map(([where, v]) => `${where} ${v ?? "(none)"}`);
    fail(`${own.name}: the versions disagree: ${each.join(", ")}`);
  }
  if (own.name !== `@copilotz/${name}` || npm.name !== own.name) {
    fail(`packages/${name}: deno.json names ${own.name}, package.json ${npm.name}`);
  }

  // Copilotz by its entry points, as the core's build declares them; other packages' contracts,
  // as their builds do (those built already).
  const paths: Record<string, string[]> = {};
  for (const [entry, path] of Object.entries(deno.exports)) {
    paths[`copilotz${entry.slice(1)}`] = [join(CORE, types(path))];
  }
  for (const other of existsSync(PACKAGES) ? await readdir(PACKAGES) : []) {
    if (other === name || !existsSync(join(ROOT, "packages", other, "deno.json"))) continue;
    const theirs = await json<Deno>(join(ROOT, "packages", other, "deno.json"));
    for (const [entry, path] of Object.entries(theirs.exports)) {
      paths[`@copilotz/${other}${entry.slice(1)}`] = [join(PACKAGES, other, types(path))];
    }
  }

  const out = join(PACKAGES, name);
  await rm(out, { recursive: true, force: true });
  const entries = Object.entries(own.exports);
  const program = ts.createProgram({
    rootNames: entries.map(([, path]) => join(home, path)),
    options: optionsFor(home, out, paths),
  });
  // The package's own sources, nothing else: Copilotz is a package beside it.
  const outside = program.getSourceFiles().map((file) => file.fileName).filter((file) =>
    !file.endsWith(".d.ts") && !file.includes("/node_modules/") && !file.startsWith(home + sep)
  );
  if (outside.length) {
    fail(`${own.name} imports files outside it:\n${outside.map((f) => `  ${f}`).join("\n")}`);
  }
  const written = emit(program);
  for (const file of ["README.md", "WORDS.md"]) {
    if (existsSync(join(home, file))) await copyFile(join(home, file), join(out, file));
  }
  await copyFile(join(ROOT, "LICENSE"), join(out, "LICENSE"));

  const specs = await specifiersIn(written);
  const named = Object.keys(core.exports).map((entry) => `copilotz${entry.slice(1)}`);
  const strange = [...specs].filter((spec) =>
    (spec === "copilotz" || spec.startsWith("copilotz/")) && !named.includes(spec)
  );
  if (strange.length) {
    fail(`${own.name} imports what Copilotz doesn't export: ${strange.join(", ")}`);
  }
  const used = packagesOf(specs);
  const dependencies: Record<string, string> = {};
  const peerDependencies: Record<string, string> = { copilotz: own.version };
  const unknown: string[] = [];
  for (const dep of [...used].sort()) {
    if (dep === "copilotz") continue;
    else if (dep.startsWith("@copilotz/")) peerDependencies[dep] = own.version;
    else if (dep in OPTIONAL) peerDependencies[dep] = OPTIONAL[dep];
    else if (PEERS.has(dep)) peerDependencies[dep] = `^${versions.get(dep)}`;
    else if (dep.startsWith("@types/")) continue;
    else if (versions.has(dep)) dependencies[dep] = versions.get(dep)!;
    else unknown.push(dep);
  }
  if (unknown.length) {
    fail(`${own.name} imports, not in deno.json's imports: ${unknown.join(", ")}`);
  }
  // The front ends' declarations name React's types.
  if (used.has("react")) peerDependencies["@types/react"] = OPTIONAL["@types/react"];

  const manifest = {
    name: own.name,
    version: own.version,
    description: npm.description,
    keywords: ["copilotz", "agents", "ai", "plugin"],
    homepage: `https://github.com/copilotzhq/copilotz/tree/main/packages/${name}#readme`,
    bugs: "https://github.com/copilotzhq/copilotz/issues",
    repository: {
      type: "git",
      url: "git+https://github.com/copilotzhq/copilotz.git",
      directory: `packages/${name}`,
    },
    license: "MIT",
    type: "module",
    engines: root.engines,
    sideEffects: false,
    types: types(own.exports["."]),
    exports: {
      ...Object.fromEntries(
        entries.map(([entry, path]) => [entry, { types: types(path), default: js(path) }]),
      ),
      "./package.json": "./package.json",
    },
    files: [
      ...new Set(
        written.map((file) => relative(out, file).split(sep)[0]).concat(
          ["README.md", "WORDS.md", "LICENSE"].filter((file) => existsSync(join(out, file))),
        ),
      ),
    ].sort(),
    dependencies: Object.fromEntries(Object.entries(dependencies).sort()),
    peerDependencies: Object.fromEntries(Object.entries(peerDependencies).sort()),
    ...(peerDependencies["@types/react"]
      ? { peerDependenciesMeta: { "@types/react": { optional: true } } }
      : {}),
  };
  await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `${manifest.name}@${manifest.version}: ${entries.length} entry points, ${written.length} files, ` +
      `${(await size(out) / 1e6).toFixed(1)} MB in ${relative(ROOT, out)}/`,
  );
}

const one = arg("package");
if (one) await buildPackage(one);
else {
  await buildCore(CORE);
  if (process.argv.includes("--all")) {
    await rm(PACKAGES, { recursive: true, force: true });
    for (const name of await packageNames()) await buildPackage(name);
  }
}
