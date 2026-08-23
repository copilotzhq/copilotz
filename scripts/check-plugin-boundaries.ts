const SELF_PACKAGE = "@copilotz/copilotz";

export type BoundarySource = Readonly<{ path: string; text: string }>;

export type BoundaryMappings = Readonly<{
  imports?: Readonly<Record<string, string>>;
  exports?: Readonly<Record<string, string>>;
}>;

type Token = Readonly<{
  kind: "identifier" | "string" | "punctuation";
  value: string;
}>;

function identifierStart(value: string): boolean {
  return /[A-Za-z_$]/.test(value);
}

function identifierPart(value: string): boolean {
  return /[A-Za-z0-9_$]/.test(value);
}

function tokens(source: string): readonly Token[] {
  const result: Token[] = [];
  let index = 0;
  while (index < source.length) {
    const value = source[index];
    if (/\s/.test(value)) {
      index += 1;
      continue;
    }
    if (value === "/" && source[index + 1] === "/") {
      index += 2;
      while (index < source.length && !"\r\n".includes(source[index])) {
        index += 1;
      }
      continue;
    }
    if (value === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      index = end < 0 ? source.length : end + 2;
      continue;
    }
    if (value === '"' || value === "'") {
      const quote = value;
      let decoded = "";
      index += 1;
      while (index < source.length) {
        const current = source[index];
        if (current === quote) {
          index += 1;
          break;
        }
        if (current === "\\") {
          const escaped = source[index + 1];
          if (escaped === undefined) break;
          decoded += escaped;
          index += 2;
          continue;
        }
        decoded += current;
        index += 1;
      }
      result.push({ kind: "string", value: decoded });
      continue;
    }
    if (value === "`") {
      index += 1;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "`") {
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }
    if (identifierStart(value)) {
      const start = index++;
      while (index < source.length && identifierPart(source[index])) index++;
      result.push({ kind: "identifier", value: source.slice(start, index) });
      continue;
    }
    result.push({ kind: "punctuation", value });
    index += 1;
  }
  return result;
}

/** Extracts static imports, export-from clauses, side-effect imports, and literal dynamic imports. */
export function moduleSpecifiers(source: string): readonly string[] {
  const parsed = tokens(source);
  const result: string[] = [];
  for (let index = 0; index < parsed.length; index++) {
    const token = parsed[index];
    if (
      token.kind !== "identifier" ||
      (token.value !== "import" && token.value !== "export")
    ) continue;
    if (token.value === "import" && parsed[index + 1]?.value === ".") continue;
    if (
      token.value === "import" && parsed[index + 1]?.value === "(" &&
      parsed[index + 2]?.kind === "string"
    ) {
      result.push(parsed[index + 2].value);
      continue;
    }
    if (token.value === "import" && parsed[index + 1]?.kind === "string") {
      result.push(parsed[index + 1].value);
      continue;
    }
    for (let cursor = index + 1; cursor < parsed.length; cursor++) {
      const candidate = parsed[cursor];
      if (candidate.value === ";") break;
      if (
        candidate.kind === "identifier" && candidate.value === "from" &&
        parsed[cursor + 1]?.kind === "string"
      ) {
        result.push(parsed[cursor + 1].value);
        break;
      }
    }
  }
  return Object.freeze(result);
}

function posixJoin(fromFile: string, specifier: string): string {
  const parts = fromFile.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function localTarget(target: string): string | undefined {
  if (!target.startsWith("./")) return undefined;
  return target.slice(2);
}

function mappedTarget(
  specifier: string,
  mappings: BoundaryMappings,
): string | undefined {
  const direct = mappings.imports?.[specifier];
  if (direct) return localTarget(direct);
  if (specifier === SELF_PACKAGE) {
    return localTarget(mappings.exports?.["."] ?? "");
  }
  if (specifier.startsWith(SELF_PACKAGE + "/")) {
    const key = "." + specifier.slice(SELF_PACKAGE.length);
    return localTarget(mappings.exports?.[key] ?? "");
  }
  return undefined;
}

function sourceTarget(
  sources: ReadonlyMap<string, BoundarySource>,
  candidate: string,
): string | undefined {
  const clean = candidate.replace(/[?#].*$/, "");
  for (const path of [clean, `${clean}.ts`, `${clean}/index.ts`]) {
    if (sources.has(path)) return path;
  }
  return undefined;
}

function isConcretePlugin(path: string): boolean {
  return path === "plugins" || path.startsWith("plugins/");
}

export function findPluginBoundaryFailures(
  inputSources: readonly BoundarySource[],
  mappings: BoundaryMappings,
): readonly string[] {
  const sources = new Map(inputSources.map((source) => [source.path, source]));
  const edges = new Map<string, readonly string[]>();
  const failures: string[] = [];

  for (const source of sources.values()) {
    if (/\bcreateCorePlugin\b/.test(source.text)) {
      failures.push(`${source.path}: hidden createCorePlugin factory`);
    }
    if (/export const PLUGIN_RESOURCE_TYPES/.test(source.text)) {
      failures.push(`${source.path}: exported PLUGIN_RESOURCE_TYPES`);
    }
    const resolved: string[] = [];
    for (const specifier of moduleSpecifiers(source.text)) {
      const internalSelf = specifier === SELF_PACKAGE ||
        specifier.startsWith(SELF_PACKAGE + "/");
      const mapped = mappedTarget(specifier, mappings);
      if (internalSelf && !mapped) {
        failures.push(
          `${source.path}: unresolved internal self specifier (${specifier})`,
        );
        continue;
      }
      const candidate = mapped ??
        ((specifier.startsWith("./") || specifier.startsWith("../"))
          ? posixJoin(source.path, specifier)
          : undefined);
      if (!candidate) continue;
      const target = sourceTarget(sources, candidate);
      if (!target) continue;
      resolved.push(target);
      if (
        source.path.startsWith("plugins/") &&
        (specifier.startsWith("./") || specifier.startsWith("../")) &&
        target.startsWith("runtime/")
      ) {
        failures.push(
          `${source.path}: plugin relative-imports runtime (${specifier})`,
        );
      }
    }
    edges.set(source.path, Object.freeze(resolved));
  }

  for (const source of sources.values()) {
    if (
      !source.path.startsWith("runtime/") || source.path.endsWith(".test.ts")
    ) {
      continue;
    }
    const pending: Array<Readonly<{ path: string; chain: readonly string[] }>> =
      [{ path: source.path, chain: [source.path] }];
    const visited = new Set<string>();
    while (pending.length) {
      const current = pending.shift()!;
      if (visited.has(current.path)) continue;
      visited.add(current.path);
      if (current.path !== source.path && isConcretePlugin(current.path)) {
        failures.push(
          `${source.path}: runtime reaches concrete plugin (${
            current.chain.join(" -> ")
          })`,
        );
        break;
      }
      for (const target of edges.get(current.path) ?? []) {
        pending.push({ path: target, chain: [...current.chain, target] });
      }
    }
  }

  return Object.freeze([...new Set(failures)].sort());
}

async function productionSources(
  directory: URL,
  prefix = "",
): Promise<readonly BoundarySource[]> {
  const result: BoundarySource[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if ([".git", ".deno", "dist", "node_modules"].includes(entry.name)) {
      continue;
    }
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) result.push(...await productionSources(url, path));
    else if (
      entry.isFile && path.endsWith(".ts") && !path.endsWith(".test.ts")
    ) {
      result.push({ path, text: await Deno.readTextFile(url) });
    }
  }
  return Object.freeze(result);
}

if (import.meta.main) {
  const repositoryRoot = new URL("../", import.meta.url);
  const denoConfig = JSON.parse(
    await Deno.readTextFile(new URL("../deno.json", import.meta.url)),
  ) as BoundaryMappings;
  const sources = (await productionSources(repositoryRoot)).filter((source) =>
    source.path !== "scripts/check-plugin-boundaries.ts"
  );
  const failures = findPluginBoundaryFailures(sources, denoConfig);
  if (failures.length) {
    throw new Error(`Plugin boundary check failed:\n${failures.join("\n")}`);
  }
}
