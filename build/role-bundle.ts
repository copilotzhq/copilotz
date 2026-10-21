/** Build-host-only worker role compiler. Audits and snapshots executable edges
 * before optimization; it never substitutes a reduced public subpath barrel. */
import ts from "typescript";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = new URL("../", import.meta.url);
const workerEntry = new URL("../worker.ts", import.meta.url).href;
// Reviewed Core runtime seams. User plugin modules are traversed, never pruned.
const runtimeModules = new Set([
  "authoring.ts",
  "dependencies/async-hooks.ts",
  "dependencies/ajv.ts",
  "dependencies/croner.ts",
  "dependencies/oxian-work.ts",
  "dependencies/oxian-worker.ts",
  "runtime/actions/content.ts",
  "runtime/actions/caller-identity.ts",
  "runtime/actions/continuation.ts",
  "runtime/actions/define.ts",
  "runtime/actions/effect-client.ts",
  "runtime/actions/effects.ts",
  "runtime/actions/errors.ts",
  "runtime/actions/execution-context.ts",
  "runtime/actions/protected-context.ts",
  "runtime/actions/secret.ts",
  "runtime/actions/transaction-identity.ts",
  "runtime/actions/value.ts",
  "runtime/application/worker.ts",
  "runtime/authorization/invocation.ts",
  "runtime/application/shard-worker.ts",
  "runtime/application/shard-identity.ts",
  "runtime/collections/definition.ts",
  "runtime/collections/errors.ts",
  "runtime/collections/validate.ts",
  "runtime/content/decode.ts",
  "runtime/content/digest.ts",
  "runtime/content/errors.ts",
  "runtime/content/input.ts",
  "runtime/content/json.ts",
  "runtime/content/preparer.ts",
  "runtime/content/schema.ts",
  "runtime/data-only-json.ts",
  "runtime/events/types.ts",
  "runtime/events/workflow-id.ts",
  "runtime/execution/diagnostics.ts",
  "runtime/execution/owner-capability-wire.ts",
  "runtime/execution/owner-capture.ts",
  "runtime/execution/owner-capability-worker.ts",
  "runtime/failure.ts",
  "runtime/json.ts",
  "runtime/plugins/contribution.ts",
  "runtime/plugins/match.ts",
  "runtime/plugins/processor.ts",
  "runtime/plugins/registry.ts",
  "runtime/plugins/types.ts",
  "runtime/schedules/delegation.ts",
  "runtime/streams/json.ts",
  "runtime/views/definition.ts",
  "runtime/views/index.ts",
  "runtime/views/renderer.ts",
  "runtime/views/resolution.ts",
  "worker.ts",
]);
const npmNames = new Set([
  "ajv",
  "ajv-formats",
  "fast-deep-equal",
  "fast-uri",
  "json-schema-traverse",
  "require-from-string",
]);
type Dependency = {
  specifier: string;
  code?: { specifier?: string };
  type?: { specifier?: string };
};
type Module = {
  kind: string;
  specifier: string;
  local?: string;
  mediaType?: string;
  dependencies?: Dependency[];
  npmPackage?: string;
  error?: string;
};
type NpmPackage = {
  name: string;
  version: string;
  dependencies: string[];
  registryUrl: string;
  localPath: string;
};
type ResolvedGraph = {
  roots: string[];
  modules: Module[];
  redirects: Record<string, string>;
  npmPackages: Record<string, NpmPackage>;
};
export type WorkerRoleGraph = Readonly<{
  role: "worker";
  entry: string;
  artifact: Readonly<{ sha256: string; platform: "browser" | "deno" }>;
  modules: readonly Readonly<
    { source: string; sha256: string; imports: readonly string[] }
  >[];
  packages: readonly Readonly<
    { id: string; files: readonly Readonly<{ path: string; sha256: string }>[] }
  >[];
}>;
export type WorkerRoleBundleOptions = Readonly<{
  output: string;
  platform?: "browser" | "deno";
  /** Optional local Deno config. Otherwise discovered from the entry directory. */
  config?: string;
}>;
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes as BufferSource),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
async function run(args: string[]): Promise<string> {
  const result = await new Deno.Command(Deno.execPath(), {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(
      `Worker role command failed: ${args[0]}\n${
        new TextDecoder().decode(result.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(result.stdout);
}
function parseConfig(text: string, label: string): Record<string, unknown> {
  const parsed = ts.parseConfigFileTextToJson(label, text);
  if (parsed.error || !parsed.config || typeof parsed.config !== "object") {
    throw new TypeError(`Invalid role build config: ${label}`);
  }
  return parsed.config;
}
async function readConfig(path: string): Promise<Record<string, unknown>> {
  return parseConfig(await Deno.readTextFile(path), path);
}
/** @internal Package-loader seam; not re-exported from the public build entry.
 * The compiler passes only its own import.meta-relative, version-pinned config. */
export async function readWorkerRolePackageConfig(
  url: URL,
): Promise<Record<string, unknown>> {
  if (url.protocol === "file:") {
    return parseConfig(await Deno.readTextFile(url), url.href);
  }
  if (
    url.protocol !== "https:" || url.hostname !== "jsr.io" ||
    !/^\/@[^/]+\/[^/]+\/\d+\.\d+\.\d+(?:-[^/]+)?\/deno\.json$/.test(
      url.pathname,
    ) ||
    url.search || url.hash || url.username || url.password || url.port
  ) {
    throw new TypeError(
      "Worker package config must be a local or version-pinned JSR package URL.",
    );
  }
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) {
    throw new Error(
      `Cannot read worker package config: ${url.href} (${response.status})`,
    );
  }
  return parseConfig(await response.text(), url.href);
}
async function configuration(entry: string, explicit?: string) {
  if (explicit) return resolve(explicit);
  for (let directory = dirname(entry);;) {
    for (const name of ["deno.json", "deno.jsonc"]) {
      const path = join(directory, name);
      if (await Deno.stat(path).then((s) => s.isFile).catch(() => false)) {
        return path;
      }
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}
function mappings(value: unknown, base: URL): Record<string, string | null> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Invalid role build import map.");
  }
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, target]) => {
      if (target !== null && typeof target !== "string") {
        throw new TypeError("Invalid role import target.");
      }
      const mapped =
        target && (target.startsWith(".") || target.startsWith("/"))
          ? new URL(target, base).href
          : target;
      const name = key.startsWith(".") || key.startsWith("/")
        ? new URL(key, base).href
        : key;
      // Hierarchical jsr:/ and npm:/ prefixes preserve Deno config package
      // subpath expansion in a standalone standard import map.
      return [
        [name, mapped],
        ...(
          typeof mapped === "string" && /^(jsr|npm):/.test(mapped) &&
            !name.endsWith("/") && !mapped.endsWith("/")
            ? [[name + "/", mapped.replace(/^(jsr|npm):\/?/, "$1:/") + "/"]]
            : []
        ),
      ];
    }),
  );
}
async function roleImportMap(config?: string) {
  let data = config ? await readConfig(config) : {};
  let base = config ? pathToFileURL(config) : packageRoot;
  if (data.importMap !== undefined) {
    if (typeof data.importMap !== "string") {
      throw new TypeError("Invalid config importMap.");
    }
    const url = new URL(data.importMap, base);
    if (url.protocol !== "file:") {
      throw new TypeError("Worker role build requires a local import map.");
    }
    data = await readConfig(decodeURIComponent(url.pathname));
    base = url;
  }
  const ownConfig = await readWorkerRolePackageConfig(
    new URL("deno.json", packageRoot),
  );
  const ownMappings = mappings(
    ownConfig.imports,
    new URL("deno.json", packageRoot),
  );
  // Explicit public subpaths retain their actual complete published entry. Only
  // the deliberately selected role root changes its implementation surface.
  const imports = {
    ...Object.fromEntries(
      Object.entries(ownMappings).filter(([name]) =>
        name.startsWith("@copilotz/copilotz/")
      ),
    ),
    ...mappings(data.imports, base),
  };
  imports["@copilotz/copilotz"] = workerEntry;
  const scopes: Record<string, Record<string, string | null>> = {};
  if (data.scopes !== undefined) {
    if (
      !data.scopes || typeof data.scopes !== "object" ||
      Array.isArray(data.scopes)
    ) throw new TypeError("Invalid import scopes.");
    for (const [scope, values] of Object.entries(data.scopes)) {
      scopes[new URL(scope, base).href] = {
        ...mappings(values, base),
        "@copilotz/copilotz": workerEntry,
      };
    }
  }
  scopes[packageRoot.href] = {
    ...ownMappings,
    ...scopes[packageRoot.href],
    "@copilotz/copilotz": workerEntry,
  };
  return { imports, scopes };
}
function permitted(source: string) {
  if (source.startsWith(packageRoot.href)) {
    const path = source.slice(packageRoot.href.length);
    if (
      (path.startsWith("runtime/") || path.startsWith("dependencies/") ||
        !path.includes("/")) && !runtimeModules.has(path)
    ) {
      throw new Error(`Unsupported worker runtime module: ${path}`);
    }
  } else if (!source.startsWith("file:")) {
    if (
      !/^https:\/\/jsr\.io\/@oxian\/oxian-js\/[^/]+\/src\/(protocol|transport|worker|work)\/.+\.ts$/
        .test(source)
    ) {
      throw new Error(`Unsupported worker external module: ${source}`);
    }
  }
}
function directGlobalName(expression: ts.Expression): string | undefined {
  while (ts.isParenthesizedExpression(expression)) {
    expression = expression.expression;
  }
  if (ts.isIdentifier(expression)) return expression.text;
  if (
    ts.isPropertyAccessExpression(expression) ||
    ts.isElementAccessExpression(expression)
  ) {
    let owner: ts.Expression = expression.expression;
    while (ts.isParenthesizedExpression(owner)) owner = owner.expression;
    if (
      !ts.isIdentifier(owner) ||
      !["globalThis", "self", "window"].includes(owner.text)
    ) return undefined;
    if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
    if (
      expression.argumentExpression &&
      ts.isStringLiteralLike(expression.argumentExpression)
    ) return expression.argumentExpression.text;
  }
}
function emitted(source: string, path: string) {
  const result = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
      sourceMap: false,
    },
  });
  const tree = ts.createSourceFile(
    path,
    result.outputText,
    ts.ScriptTarget.Latest,
    true,
  );
  const imports: { specifier: string; start: number; end: number }[] = [];
  // The reviewed ambient-context wrapper has one lazy native dependency.
  // It remains lazy in browser artifacts; unsupported hosts fail closed when
  // execution starts. Plugin dynamic imports remain forbidden.
  const nativeContextWrapper =
    path === new URL("dependencies/async-hooks.ts", packageRoot).href &&
    tree.statements.some((statement) =>
      ts.isVariableStatement(statement) &&
      (statement.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      statement.declarationList.declarations.some((declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === "ASYNC_HOOKS_SPECIFIER" &&
        declaration.initializer &&
        ts.isStringLiteral(declaration.initializer) &&
        declaration.initializer.text === "node:async_hooks"
      )
    );
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      if (!ts.isStringLiteral(node.moduleSpecifier)) {
        throw new Error(`Nonliteral worker module edge: ${path}`);
      }
      imports.push({
        specifier: node.moduleSpecifier.text,
        start: node.moduleSpecifier.getStart(tree),
        end: node.moduleSpecifier.end,
      });
    } else if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const name = directGlobalName(node.expression);
      if (name && ["Worker", "SharedWorker", "importScripts"].includes(name)) {
        throw new Error(`Nested worker module loading is unsupported: ${path}`);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
          name === "require") &&
        !(nativeContextWrapper &&
          node.expression.kind === ts.SyntaxKind.ImportKeyword &&
          node.arguments.length === 1 &&
          ts.isIdentifier(node.arguments[0]) &&
          node.arguments[0].text === "ASYNC_HOOKS_SPECIFIER")
      ) {
        throw new Error(
          `Dynamic worker module loading is unsupported: ${path}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return { text: result.outputText, imports };
}
async function publishPair(artifact: string, output: string, evidence: string) {
  const paths = [output, output + ".graph.json"];
  for (const path of paths) {
    const existing = await Deno.lstat(path).catch((error) => {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    });
    if (existing && !existing.isFile) {
      throw new Error(
        `Worker publication destination must be a regular file: ${path}`,
      );
    }
  }
  const temporary = await Deno.makeTempFile({
    dir: dirname(output),
    prefix: ".worker-role-",
  });
  const evidenceTemporary = temporary + ".graph.json";
  const state = paths.map((path) => ({
    path,
    backup: undefined as string | undefined,
    published: false,
  }));
  const unusedBackups: string[] = [];
  let preserveBackups = false;
  try {
    await Deno.copyFile(artifact, temporary);
    await Deno.writeTextFile(evidenceTemporary, evidence);
    for (const item of state) {
      const exists = await Deno.lstat(item.path).catch((error) => {
        if (error instanceof Deno.errors.NotFound) return undefined;
        throw error;
      });
      if (!exists) continue;
      if (!exists.isFile) {
        throw new Error(`Worker publication destination changed: ${item.path}`);
      }
      const backup = await Deno.makeTempFile({
        dir: dirname(output),
        prefix: ".worker-role-prior-",
      });
      unusedBackups.push(backup);
      await Deno.rename(item.path, backup);
      item.backup = backup;
    }
    await Deno.rename(temporary, output);
    state[0].published = true;
    await Deno.rename(evidenceTemporary, paths[1]);
    state[1].published = true;
  } catch (error) {
    const restoreErrors: unknown[] = [];
    for (const item of [...state].reverse()) {
      try {
        if (item.backup) await Deno.rename(item.backup, item.path);
        else if (item.published) await Deno.remove(item.path);
      } catch (restoreError) {
        restoreErrors.push(restoreError);
      }
    }
    if (restoreErrors.length) {
      // Never discard the last good bytes when the filesystem itself refuses
      // rollback. Report their retained destination-local backup paths.
      preserveBackups = true;
      throw new AggregateError(
        [error, ...restoreErrors],
        `Worker publication rollback failed; retained backups: ${
          unusedBackups.join(", ")
        }`,
      );
    }
    throw error;
  } finally {
    await Deno.remove(temporary).catch(() => undefined);
    await Deno.remove(evidenceTemporary).catch(() => undefined);
    if (!preserveBackups) {
      for (const backup of unusedBackups) {
        await Deno.remove(backup).catch(() => undefined);
      }
    }
  }
}

/** Builds a real worker-role entry, not a declaration-only fixture. Every emitted
 * Core edge is audited before any tree shaking. Unsupported dependencies fail
 * closed, even when unused. Reviewed npm packages are explicit runtime seams:
 * their entire transitive package bytes are copied and hashed before bundling.
 * This is an executable-dependency audit for trusted plugin source, not a JS
 * sandbox. Dynamic import/require and direct Worker/SharedWorker/importScripts
 * forms are refused. Reflective, code-generated or aliased runtime loading is
 * outside this static analysis; injected factories remain trusted capabilities. */
export async function buildWorkerRole(
  input: string,
  options: WorkerRoleBundleOptions,
): Promise<WorkerRoleGraph> {
  const entry = resolve(input);
  const output = resolve(options.output);
  if (
    options.platform !== undefined &&
    !["browser", "deno"].includes(options.platform)
  ) throw new TypeError("Invalid worker bundle platform.");
  const config = await configuration(entry, options.config);
  const stage = await Deno.makeTempDir({ prefix: "copilotz-worker-role-" });
  const map = join(stage, "imports.json");
  try {
    await Deno.writeTextFile(map, JSON.stringify(await roleImportMap(config)));
    // Source-cohort links are explicit local configuration, never published.
    // Keep them when the entry lives in a temporary fixture outside this tree.
    const ownConfigUrl = new URL("deno.json", packageRoot);
    const ownConfig = await readWorkerRolePackageConfig(ownConfigUrl);
    const selected = config ? await readConfig(config) : {};
    const links = [
      ...new Set([
        ...(Array.isArray(ownConfig.links)
          ? ownConfig.links.map((link) =>
            new URL(String(link) + "/", ownConfigUrl).href
          )
          : []),
        ...(Array.isArray(selected.links)
          ? selected.links.map((link) =>
            new URL(String(link) + "/", pathToFileURL(config!)).href
          )
          : []),
      ]),
    ];
    const selectedConfig = join(stage, "deno.json");
    await Deno.writeTextFile(
      selectedConfig,
      JSON.stringify({
        compilerOptions: selected.compilerOptions ?? ownConfig.compilerOptions,
        // Preserve the caller's dependency policy (or this package's policy)
        // when staging an external entry, including explicit release exceptions.
        minimumDependencyAge: selected.minimumDependencyAge ??
          ownConfig.minimumDependencyAge,
        ...(links.length ? { links } : {}),
        nodeModulesDir: "auto",
      }),
    );
    const flags = ["--config", selectedConfig, "--import-map", map];
    await run(["check", ...flags, entry]);
    const graph: ResolvedGraph = JSON.parse(
      await run(["info", "--json", ...flags, entry]),
    );
    const targets = await Promise.all(
      [output, output + ".graph.json"].map(async (path) =>
        await Deno.realPath(path).catch(() => path)
      ),
    );
    const originalConfig = config ? await readConfig(config) : {};
    const originalImportMap =
      config && typeof originalConfig.importMap === "string"
        ? new URL(originalConfig.importMap, pathToFileURL(config))
        : undefined;
    const protectedPaths = [
      entry,
      ...config ? [config] : [],
      ...originalImportMap?.protocol === "file:"
        ? [decodeURIComponent(originalImportMap.pathname)]
        : [],
      ...packageRoot.protocol === "file:"
        ? [new URL("deno.json", packageRoot).pathname]
        : [],
      ...graph.modules.flatMap((mod) => mod.local ? [mod.local] : []),
    ];
    for (const path of protectedPaths) {
      const canonical = await Deno.realPath(path).catch(() => resolve(path));
      if (targets.includes(canonical)) {
        throw new Error(
          "Worker output and evidence must not overwrite a source or config file.",
        );
      }
    }
    for (const pkg of Object.values(graph.npmPackages ?? {})) {
      const canonical = await Deno.realPath(pkg.localPath);
      if (
        targets.some((target) =>
          target === canonical || target.startsWith(canonical + "/")
        )
      ) {
        throw new Error(
          "Worker output and evidence must not overwrite a dependency snapshot.",
        );
      }
    }
    const modules = new Map(graph.modules.map((m) => [m.specifier, m]));
    const canonical = (source: string) => {
      const seen = new Set<string>();
      while (graph.redirects[source]) {
        if (seen.has(source)) throw new Error("Cyclic worker module redirect.");
        seen.add(source);
        source = graph.redirects[source];
      }
      return source;
    };
    const roots = graph.roots.map(canonical);
    const snapshots = new Map<
      string,
      {
        text: string;
        imports: { target: string; start: number; end: number }[];
        json: boolean;
      }
    >();
    const npmEntries = new Map<string, { name: string; id: string }>();
    const pending = [...roots];
    while (pending.length) {
      const source = canonical(pending.pop()!);
      if (snapshots.has(source) || npmEntries.has(source)) continue;
      if (snapshots.size > 2048) {
        throw new Error("Worker executable graph exceeds its module bound.");
      }
      const mod = modules.get(source);
      if (!mod || mod.error) {
        throw new Error(`Unresolved worker module: ${source}`);
      }
      if (mod.kind === "npm") {
        const pkg = graph.npmPackages[mod.npmPackage!];
        // Only the reviewed Cron ESM root is admitted, not its other versions
        // or package subpaths. Its source snapshot uses the same audit below.
        const cron = pkg?.name === "croner" && pkg.version === "9.0.0" &&
          source === "npm:/croner@9.0.0";
        if (!pkg || !["ajv", "ajv-formats"].includes(pkg.name) && !cron) {
          throw new Error(`Unsupported worker npm entry: ${source}`);
        }
        const prefix = `npm:/${pkg.name}@${pkg.version}`;
        if (
          !source.startsWith(prefix) ||
          source.length > prefix.length && source[prefix.length] !== "/"
        ) throw new Error(`Invalid worker npm resolution: ${source}`);
        npmEntries.set(source, {
          name: pkg.name + source.slice(prefix.length),
          id: mod.npmPackage!,
        });
        continue;
      }
      if (
        (mod.kind !== "esm" &&
          !(mod.kind === "asserted" && mod.mediaType === "Json")) || !mod.local
      ) {
        throw new Error(`Unsupported worker module kind: ${source}`);
      }
      permitted(source);
      if (source.startsWith("file:")) {
        // A symlinked package path cannot disguise a forbidden Core module as
        // ordinary user source outside the package directory.
        permitted(pathToFileURL(await Deno.realPath(mod.local)).href);
      }
      if (source === pathToFileURL(output).href) {
        throw new Error("Worker output must not overwrite a source module.");
      }
      const text = await Deno.readTextFile(mod.local);
      const json = mod.mediaType === "Json";
      const value = json ? { text, imports: [] } : emitted(text, source);
      const imports = value.imports.map((edge) => {
        const resolved = mod.dependencies?.find((dep) =>
          dep.specifier === edge.specifier
        );
        const target = resolved?.code?.specifier ?? resolved?.type?.specifier;
        if (!target) {
          throw new Error(
            `Unresolved executable worker edge: ${source} -> ${edge.specifier}`,
          );
        }
        pending.push(target);
        return { ...edge, target: canonical(target) };
      });
      snapshots.set(source, { text: value.text, imports, json });
    }
    const packageSnapshots: {
      id: string;
      files: { path: string; sha256: string }[];
    }[] = [];
    const installed = new Map<string, string>();
    const packageQueue = [...npmEntries.values()].map((value) => value.id);
    while (packageQueue.length) {
      const id = packageQueue.pop()!;
      const pkg = graph.npmPackages[id];
      if (
        !pkg ||
        !(npmNames.has(pkg.name) ||
          pkg.name === "croner" && pkg.version === "9.0.0" &&
            pkg.dependencies.length === 0) ||
        pkg.registryUrl !== "https://registry.npmjs.org/"
      ) throw new Error(`Unsupported transitive worker npm package: ${id}`);
      if (installed.has(pkg.name)) {
        if (installed.get(pkg.name) !== id) {
          throw new Error(`Conflicting worker npm versions: ${pkg.name}`);
        }
        continue;
      }
      installed.set(pkg.name, id);
      packageQueue.push(...pkg.dependencies);
      const destination = join(stage, "node_modules", pkg.name);
      const files: { path: string; sha256: string }[] = [];
      let bytes = 0;
      const copy = async (relative = ""): Promise<void> => {
        await Deno.mkdir(join(destination, relative), { recursive: true });
        for await (const item of Deno.readDir(join(pkg.localPath, relative))) {
          const path = relative ? relative + "/" + item.name : item.name;
          if (item.isSymlink) {
            throw new Error(`Symlink in worker npm snapshot: ${id}/${path}`);
          }
          if (item.isDirectory) await copy(path);
          else if (item.isFile) {
            const content = await Deno.readFile(join(pkg.localPath, path));
            bytes += content.byteLength;
            if (files.length >= 10_000 || bytes > 64 * 1024 * 1024) {
              throw new Error(`Worker npm snapshot exceeds bound: ${id}`);
            }
            await Deno.writeFile(join(destination, path), content);
            files.push({ path, sha256: await digest(content) });
          } else throw new Error(`Unsupported worker npm file: ${id}/${path}`);
        }
      };
      await copy();
      packageSnapshots.push({
        id,
        files: files.sort((a, b) => a.path.localeCompare(b.path)),
      });
    }
    await Deno.writeTextFile(
      join(stage, "package.json"),
      JSON.stringify({
        dependencies: Object.fromEntries(
          [...installed].map((
            [name, id],
          ) => [name, graph.npmPackages[id].version]),
        ),
      }),
    );
    await Deno.writeTextFile(
      join(stage, "deno.json"),
      JSON.stringify({ nodeModulesDir: "manual", lock: false }),
    );
    const sources = [...snapshots.keys()].sort();
    const names = new Map(
      sources.map((
        source,
        index,
      ) => [
        source,
        `module-${index}.${snapshots.get(source)!.json ? "json" : "mjs"}`,
      ]),
    );
    const audit: { source: string; sha256: string; imports: string[] }[] = [];
    for (const source of sources) {
      const snapshot = snapshots.get(source)!;
      let text = snapshot.text;
      for (
        const edge of [...snapshot.imports].sort((a, b) => b.start - a.start)
      ) {
        const target = names.get(edge.target);
        const external = npmEntries.get(edge.target);
        if (!target && !external) {
          throw new Error(`Missing audited worker edge: ${edge.target}`);
        }
        const specifier = target ? "./" + target : external!.name;
        text = text.slice(0, edge.start) + JSON.stringify(specifier) +
          text.slice(edge.end);
      }
      const bytes = new TextEncoder().encode(text);
      await Deno.writeFile(join(stage, names.get(source)!), bytes);
      audit.push({
        source,
        sha256: await digest(bytes),
        imports: snapshot.imports.map((edge) => edge.target),
      });
    }
    const artifact = join(stage, "worker.js");
    await run([
      "bundle",
      "--config",
      join(stage, "deno.json"),
      "--format=esm",
      "--platform=" + (options.platform ?? "browser"),
      "--output",
      artifact,
      join(stage, names.get(roots[0])!),
    ]);
    const result: WorkerRoleGraph = {
      role: "worker",
      entry: roots[0],
      artifact: {
        sha256: await digest(await Deno.readFile(artifact)),
        platform: options.platform ?? "browser",
      },
      modules: audit,
      packages: packageSnapshots.sort((a, b) => a.id.localeCompare(b.id)),
    };
    await Deno.mkdir(dirname(output), { recursive: true });
    await publishPair(artifact, output, JSON.stringify(result, null, 2) + "\n");
    return result;
  } finally {
    await Deno.remove(stage, { recursive: true });
  }
}
