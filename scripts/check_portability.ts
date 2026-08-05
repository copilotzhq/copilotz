const ROOT = new URL("../", import.meta.url);
const ROOT_FILES = ["index.ts", "engine.ts"];
const CORE_DIRECTORIES = [
  "assets",
  "attachments",
  "core",
  "database",
  "events",
  "execution",
  "plugins",
  "processors",
  "resources",
  "runtime/llm",
  "runtime/tokens",
  "runtime/tools",
  "types",
];

async function typescriptFiles(
  directory: URL,
  prefix: string,
): Promise<string[]> {
  const result: string[] = [];
  for await (const entry of Deno.readDir(directory)) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory) {
      result.push(
        ...await typescriptFiles(
          new URL(`${entry.name}/`, directory),
          relative,
        ),
      );
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      result.push(relative);
    }
  }
  return result;
}

const paths = [...ROOT_FILES];
for (const directory of CORE_DIRECTORIES) {
  paths.push(
    ...await typescriptFiles(new URL(`${directory}/`, ROOT), directory),
  );
}

const checks = [
  { name: "Deno global", pattern: /\bDeno\s*\./ },
  { name: "Bun global", pattern: /\bBun\s*\./ },
  { name: "Node process global", pattern: /\bprocess\s*\./ },
  { name: "Node static import", pattern: /(?:from|import)\s*[\("']+node:/ },
  { name: "CommonJS require", pattern: /\brequire\s*\(/ },
] as const;
const failures: string[] = [];
for (const path of paths) {
  const source = await Deno.readTextFile(new URL(path, ROOT));
  for (const check of checks) {
    if (check.pattern.test(source)) failures.push(`${path}: ${check.name}`);
  }
}
if (failures.length) {
  console.error(failures.join("\n"));
  Deno.exit(1);
}
console.log(`Portability guard passed for ${paths.length} core modules.`);
