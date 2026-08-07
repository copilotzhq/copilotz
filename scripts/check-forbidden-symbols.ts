const repositoryRoot = new URL("../", import.meta.url);

const forbidden = [
  "queueId",
  "unsafeGraph",
  "ResourceManifest",
  "producedEvents",
  "runGeneration",
  "workerLease",
  "NEW_MESSAGE",
  "LLM_CALL",
  "LLM_RESULT",
  "TOOL_CALL",
  "TOOL_RESULT",
  "ASSET_CREATED",
] as const;

const ignoredDirectories = new Set([
  ".git",
  ".deno",
  "dist",
  "node_modules",
]);

function allowed(path: string): boolean {
  return path.startsWith("migration/v1/") ||
    path.startsWith("contracts/") ||
    path.endsWith(".test.ts") ||
    path === "server/v1-sse.ts" ||
    path === "docs/migration-v3.md" ||
    path === "docs/v3/downstream-migration.md" ||
    path === "docs/v3/feature-test-parity.md" ||
    path === "scripts/check-forbidden-symbols.ts";
}

function scannable(path: string): boolean {
  return /\.(?:ts|tsx|js|jsx|md|json|jsonc)$/.test(path);
}

async function* files(
  directory: URL,
  prefix = "",
): AsyncGenerator<Readonly<{ path: string; url: URL }>> {
  for await (const entry of Deno.readDir(directory)) {
    if (ignoredDirectories.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) yield* files(url, path);
    else if (entry.isFile && scannable(path)) yield { path, url };
  }
}

const violations: string[] = [];
for await (const file of files(repositoryRoot)) {
  if (allowed(file.path)) continue;
  const lines = (await Deno.readTextFile(file.url)).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const symbol of forbidden) {
      const pattern = new RegExp(`\\b${symbol}\\b`);
      if (pattern.test(lines[index])) {
        violations.push(`${file.path}:${index + 1}: ${symbol}`);
      }
    }
  }
}

if (violations.length) {
  console.error(
    "Removed architecture symbols reappeared:\n" + violations.join("\n"),
  );
  Deno.exit(1);
}

console.log(`Forbidden-symbol audit passed (${forbidden.length} symbols).`);
