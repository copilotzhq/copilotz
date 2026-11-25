/** Module resolution for a Deno app checked by the generator's TypeScript program. */
import { execFileSync } from "node:child_process";
import { dirname, extname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type ts from "typescript";

type Imports = Record<string, string | null>;
type ImportMap = { imports?: Imports; scopes?: Record<string, Imports>; importMap?: string };

type Dependency = {
  specifier: string;
  type?: { specifier?: string };
  code?: { specifier?: string };
};
type Module = {
  specifier: string;
  local?: string;
  dependencies?: Dependency[];
  npmPackage?: string;
  typesDependency?: { dependency?: { specifier?: string } };
};

/** Deno resolves its own graph (including scope, workspace, JSR redirects and npm versions).
 * The checker reads the cached sources under their original URLs, with their original extensions.
 */
function denoHost(api: typeof ts, config: string, files: string[], options: ts.CompilerOptions) {
  const roots = files.map((f) =>
    `import type {} from ${JSON.stringify(pathToFileURL(resolve(f)).href)};`
  ).join("\n");
  const graph: {
    modules: Module[];
    redirects: Record<string, string>;
    npmPackages?: Record<string, { name: string; localPath?: string }>;
  } = JSON.parse(
    execFileSync(process.execPath, [
      "info",
      "--json",
      "--frozen",
      "--config",
      config,
      "data:application/typescript," + encodeURIComponent(roots),
    ], { cwd: dirname(config), encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }),
  );
  const modules = new Map(graph.modules.map((m) => [m.specifier, m]));
  const lookup = (url?: string) => url && modules.get(graph.redirects[url] ?? url);
  const host = api.createCompilerHost(options);
  const cached = host.readFile;
  host.readFile = (path) => cached(modules.get(path)?.local ?? path);
  const cache = api.createModuleResolutionCache(
    dirname(config),
    host.getCanonicalFileName,
    options,
  );
  host.resolveModuleNameLiterals = (names, file, redirected, opts, source) => {
    const parent = modules.get(file) ?? modules.get(pathToFileURL(file).href);
    return names.map((name) => {
      const resolveName = (specifier: string, from = file) =>
        api.resolveModuleName(
          specifier,
          from,
          opts,
          host,
          cache,
          redirected,
          api.getModeForUsageLocation(source, name, opts),
        );
      const dep = parent?.dependencies?.find((d) => d.specifier === name.text);
      if (!dep) return resolveName(name.text);
      const target = dep.type?.specifier ?? dep.code?.specifier;
      if (!target) return resolveName(name.text); // An alias supplied only by tsconfig.
      const module = lookup(target);
      if (!module) return { resolvedModule: undefined };
      const types = lookup(module.typesDependency?.dependency?.specifier) || module;
      if (types.npmPackage) {
        const pkg = graph.npmPackages?.[types.npmPackage];
        const suffix = types.specifier.slice(("npm:/" + types.npmPackage).length);
        if (pkg?.localPath) {
          // Self-reference honors the package's exports. Older packages declare "types" at their root.
          const own = resolveName(pkg.name + suffix, join(pkg.localPath, "package.json"));
          if (own.resolvedModule) return own;
          return resolveName(join(pkg.localPath, suffix));
        }
        return resolveName((pkg?.name ?? name.text) + suffix);
      }
      if (types.specifier.startsWith("file:")) return resolveName(fileURLToPath(types.specifier));
      if (!types.local) return resolveName(name.text);
      return {
        resolvedModule: {
          resolvedFileName: types.specifier,
          extension: extname(new URL(types.specifier).pathname) || ".ts",
        },
      };
    });
  };
  return host;
}

export function importMapHost(api: typeof ts, files: string[], options: ts.CompilerOptions) {
  let dir = dirname(resolve(files[0]));
  let config: string | undefined;
  for (;;) {
    config = ["deno.json", "deno.jsonc"].map((name) => join(dir, name)).find(api.sys.fileExists);
    if (config || dirname(dir) === dir) break;
    dir = dirname(dir);
  }
  if (!config) return;
  if (process.versions.deno) return denoHost(api, config, files, options);
  // On Node and Bun, resolve local aliases and installed packages without requiring Deno.
  const read = (file: string): ImportMap => {
    const { config, error } = api.readConfigFile(file, api.sys.readFile);
    if (error) {
      throw new Error(`${file}: ${api.flattenDiagnosticMessageText(error.messageText, "\n")}`);
    }
    return config;
  };
  let map = read(config);
  let base = pathToFileURL(config);
  if (map.importMap) {
    base = new URL(map.importMap, base);
    map = read(fileURLToPath(base));
  }

  const urlLike = /^(?:\.\.?\/|\/|[a-z][a-z0-9+.-]*:)/i;
  const normalized = (key: string, from: URL) => urlLike.test(key) ? new URL(key, from).href : key;
  const entries = (imports: Imports = {}) =>
    Object.entries(imports)
      .map(([key, value]) => ({ key: normalized(key, base), value }))
      .sort((a, b) => b.key.length - a.key.length);
  const scopes = Object.entries(map.scopes ?? {}).map(([scope, imports]) => ({
    scope: new URL(scope, base).href,
    imports: entries(imports),
  })).sort((a, b) => b.scope.length - a.scope.length);
  const imports = entries(map.imports);
  if (!imports.length && !scopes.length) return;
  const host = api.createCompilerHost(options);
  const cache = api.createModuleResolutionCache(dir, host.getCanonicalFileName, options);
  host.resolveModuleNameLiterals = (names, file, redirected, opts, source) => {
    const from = pathToFileURL(file);
    const tables = scopes.filter(({ scope }) =>
      scope === from.href ||
      scope.endsWith("/") && from.href.startsWith(scope)
    ).map((s) => s.imports).concat([imports]);
    return names.map((name) => {
      let specifier = name.text;
      const key = normalized(specifier, from);
      for (const table of tables) {
        const entry = table.find((e) =>
          e.key === key || e.key.endsWith("/") && key.startsWith(e.key)
        );
        if (!entry) continue;
        if (!entry.value) return { resolvedModule: undefined };
        const suffix = key.slice(entry.key.length);
        if (suffix && !entry.value.endsWith("/")) return { resolvedModule: undefined };
        const target = new URL(entry.value + suffix, base);
        if (suffix && !target.href.startsWith(new URL(entry.value, base).href)) {
          return { resolvedModule: undefined };
        }
        if (target.protocol === "file:") specifier = fileURLToPath(target);
        // Packages installed beside the app use TypeScript's normal package export resolution.
        else if (target.protocol === "npm:" || target.protocol === "jsr:") {
          specifier = target.pathname.replace(/^((?:@[^/]+\/)?[^/@]+)@[^/]+/, "$1");
        } else {
          return { resolvedModule: undefined };
        }
        break;
      }
      return api.resolveModuleName(
        specifier,
        file,
        opts,
        host,
        cache,
        redirected,
        api.getModeForUsageLocation(source, name, opts),
      );
    });
  };
  return host;
}
