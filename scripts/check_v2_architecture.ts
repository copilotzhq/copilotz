const ROOT = new URL("../", import.meta.url);
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".md",
  ".json",
]);
const SKIP_DIRECTORIES = new Set([".git", "node_modules"]);
const ALLOWED_LEGACY_PREFIXES = [
  "migration/v1/",
  "docs/migration-v1.md",
  "tests/migration.test.ts",
];

async function files(directory: URL, prefix = ""): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name === ".DS_Store") continue;
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        result.push(
          ...await files(new URL(`${entry.name}/`, directory), `${relative}/`),
        );
      }
    } else if (
      [...SOURCE_EXTENSIONS].some((extension) => entry.name.endsWith(extension))
    ) {
      result.push(relative);
    }
  }
  return result;
}

function legacyAllowed(path: string): boolean {
  return ALLOWED_LEGACY_PREFIXES.some((prefix) => path.startsWith(prefix));
}

const forbiddenSymbols = [
  "queueId",
  "unsafeGraph",
  "ResourceManifest",
  "producedEvents",
  "runGeneration",
  "workerLease",
] as const;
const uppercaseEvents = [
  "NEW_MESSAGE",
  "LLM_CALL",
  "LLM_RESULT",
  "TOOL_CALL",
  "TOOL_RESULT",
  "TOKEN",
  "TOOL_CALL_DELTA",
] as const;
const forbiddenDirectories = [
  "database/operations",
  "database/migrations",
  "resources/processors",
  "runtime/scheduler",
  "runtime/loaders",
] as const;

const failures: string[] = [];
for (const directory of forbiddenDirectories) {
  try {
    const remaining = await files(new URL(`${directory}/`, ROOT));
    if (remaining.length) {
      failures.push(`${directory}: removed subsystem has files`);
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

for (const path of await files(ROOT)) {
  if (path === "scripts/check_v2_architecture.ts") continue;
  const content = await Deno.readTextFile(new URL(path, ROOT));
  if (!legacyAllowed(path)) {
    for (const symbol of forbiddenSymbols) {
      if (content.includes(symbol)) {
        failures.push(`${path}: forbidden symbol ${symbol}`);
      }
    }
    for (const event of uppercaseEvents) {
      const literal = new RegExp(`[\\"'\\x60]${event}[\\"'\\x60]`);
      if (literal.test(content)) {
        failures.push(`${path}: uppercase event ${event}`);
      }
    }
  }
  if (/\bafter(?:Create|Update|Delete)\b/.test(content)) {
    failures.push(`${path}: post-write collection hook`);
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  Deno.exit(1);
}
console.log("Copilotz v2 architecture guard passed.");
