const repositoryRoot = new URL("../", import.meta.url);
const denoConfig = JSON.parse(
  await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
) as Readonly<{ imports?: Readonly<Record<string, string>> }>;
const selfImports = denoConfig.imports ?? {};

async function* productionSources(
  directory: URL,
  prefix = "",
): AsyncGenerator<Readonly<{ path: string; text: string }>> {
  for await (const entry of Deno.readDir(directory)) {
    if ([".git", ".deno", "dist", "node_modules"].includes(entry.name)) {
      continue;
    }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) yield* productionSources(url, path);
    else if (
      entry.isFile && path.endsWith(".ts") && !path.endsWith(".test.ts")
    ) {
      yield { path, text: await Deno.readTextFile(url) };
    }
  }
}

function posixJoin(fromFile: string, spec: string): string {
  const parts = fromFile.split("/").slice(0, -1);
  for (const part of spec.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function resolvedImport(fromFile: string, spec: string): string | undefined {
  const selfTarget = selfImports[spec];
  if (selfTarget) {
    return selfTarget.startsWith("./") ? selfTarget.slice(2) : selfTarget;
  }
  if (spec.startsWith("./") || spec.startsWith("../")) {
    return posixJoin(fromFile, spec);
  }
  return undefined;
}

const importSpec = /from\s+["']([^"']+)["']/g;
const failures: string[] = [];

for await (const file of productionSources(repositoryRoot)) {
  if (file.path === "scripts/check-plugin-boundaries.ts") continue;
  if (/\bcreateCorePlugin\b/.test(file.text)) {
    failures.push(`${file.path}: hidden createCorePlugin factory`);
  }
  for (const match of file.text.matchAll(importSpec)) {
    const spec = match[1];
    const isRelative = spec.startsWith("./") || spec.startsWith("../");
    const resolved = resolvedImport(file.path, spec);
    if (!resolved) continue;
    const normalized = resolved.replace(/\.ts$/, "");
    if (
      file.path.startsWith("runtime/") &&
      (normalized === "plugins" || normalized.startsWith("plugins/"))
    ) {
      failures.push(`${file.path}: runtime imports plugins (${spec})`);
    }
    if (
      isRelative && file.path.startsWith("plugins/") &&
      (normalized === "runtime" || normalized.startsWith("runtime/"))
    ) {
      failures.push(`${file.path}: plugin relative-imports runtime (${spec})`);
    }
  }
  if (/export const PLUGIN_RESOURCE_TYPES/.test(file.text)) {
    failures.push(`${file.path}: exported PLUGIN_RESOURCE_TYPES`);
  }
}

if (failures.length) {
  throw new Error(`Plugin boundary check failed:\n${failures.join("\n")}`);
}
