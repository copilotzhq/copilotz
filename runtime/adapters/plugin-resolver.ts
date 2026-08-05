import type { PluginResolver } from "@/plugins/types.ts";

function runtimeBaseUrl(): string {
  const global = globalThis as typeof globalThis & {
    Deno?: { cwd?: () => string };
    process?: { cwd?: () => string };
    document?: { baseURI?: string };
  };
  if (global.document?.baseURI) return global.document.baseURI;
  const cwd = global.Deno?.cwd?.() ?? global.process?.cwd?.();
  if (!cwd) return import.meta.url;
  const normalized = cwd.replaceAll("\\", "/");
  return `file://${normalized.endsWith("/") ? normalized : `${normalized}/`}`;
}

function resolveSpecifier(source: string, baseUrl: string): string {
  if (
    source.startsWith("./") || source.startsWith("../") ||
    source.startsWith("/")
  ) {
    return new URL(source, baseUrl).href;
  }
  return source;
}

/** Runtime adapter for package, URL, and local plugin modules. */
export function createDefaultPluginResolver(
  baseUrl = runtimeBaseUrl(),
): PluginResolver {
  return {
    resolve(source) {
      return import(resolveSpecifier(source, baseUrl));
    },
  };
}
