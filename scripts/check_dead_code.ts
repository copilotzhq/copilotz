const ROOT = new URL("../", import.meta.url);
const config = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", ROOT)),
) as {
  exports: Record<string, string>;
};

const localOminipg = new URL("../ominipg/src/client/index.ts", ROOT);
const graphConfig = await Deno.stat(localOminipg).then(
  () => "deno.workspace.json",
  () => "deno.json",
);

const reachable = new Set<string>();
for (const root of Object.values(config.exports)) {
  const command = new Deno.Command(Deno.execPath(), {
    cwd: ROOT,
    args: ["info", "--json", "--config", graphConfig, root],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  if (!output.success) {
    console.error(new TextDecoder().decode(output.stderr));
    Deno.exit(output.code);
  }
  const graph = JSON.parse(new TextDecoder().decode(output.stdout)) as {
    modules: Array<{ local?: string }>;
  };
  for (const module of graph.modules) {
    if (module.local) reachable.add(module.local);
  }
}

const ignoredPrefixes = ["tests/", "scripts/"];
const ignoredFiles = new Set(["deno.workspace.json"]);
const dead: string[] = [];
async function visit(directory: URL, prefix = ""): Promise<void> {
  for await (const entry of Deno.readDir(directory)) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const path = `${prefix}${entry.name}`;
    if (entry.isDirectory) {
      await visit(new URL(`${entry.name}/`, directory), `${path}/`);
    } else if (
      entry.name.endsWith(".ts") &&
      !entry.name.endsWith(".test.ts") &&
      !ignoredFiles.has(path) &&
      !ignoredPrefixes.some((value) => path.startsWith(value))
    ) {
      const local = decodeURIComponent(new URL(path, ROOT).pathname);
      if (!reachable.has(local)) dead.push(path);
    }
  }
}
await visit(ROOT);
if (dead.length) {
  console.error(
    `Modules unreachable from package exports:\n${dead.join("\n")}`,
  );
  Deno.exit(1);
}
console.log(`Dead-module guard passed (${reachable.size} graph modules).`);
