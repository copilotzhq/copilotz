import type { PluginResolver } from "../plugins/index.ts";

export type ModuleImporter = (specifier: string) => Promise<unknown>;

export type CreateModulePluginResolverOptions = Readonly<{
  /** Required only for relative plugin sources. */
  baseUrl?: string | URL;
  /** Runtime-owned module importer; package resolution is a host capability. */
  importModule: ModuleImporter;
  /** Optional import-map/package-policy rewrite before import. */
  resolveSpecifier?: (source: string) => string | Promise<string>;
}>;

function isRelative(source: string): boolean {
  return source.startsWith("./") || source.startsWith("../");
}

function baseHref(value: string | URL | undefined): string | undefined {
  if (value instanceof URL) return value.href;
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    return new URL(value).href;
  } catch (cause) {
    throw new TypeError("Plugin resolver baseUrl must be an absolute URL.", {
      cause,
    });
  }
}

/**
 * Creates a runtime-neutral ES module plugin resolver. Filesystem policy,
 * import maps, package authentication, and supported URL schemes remain owned
 * by the embedding runtime and its importer.
 */
export function createModulePluginResolver(
  options: CreateModulePluginResolverOptions,
): PluginResolver {
  if (typeof options?.importModule !== "function") {
    throw new TypeError("Plugin resolver requires a runtime module importer.");
  }
  const base = baseHref(options.baseUrl);
  const importModule = options.importModule;
  return Object.freeze({
    async resolve(input) {
      const source = input.trim();
      if (!source) throw new TypeError("Plugin source must be non-empty.");
      const resolved = await options.resolveSpecifier?.(source) ?? source;
      const specifier = isRelative(resolved)
        ? base ? new URL(resolved, base).href : (() => {
          throw new TypeError(
            `Relative plugin source '${resolved}' requires baseUrl.`,
          );
        })()
        : resolved;
      return await importModule(specifier);
    },
  });
}
