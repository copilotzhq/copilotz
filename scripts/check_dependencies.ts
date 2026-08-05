const ROOT = new URL("../", import.meta.url);
const config = JSON.parse(
  await Deno.readTextFile(new URL("deno.json", ROOT)),
) as {
  imports?: Record<string, string>;
};

async function sourceFiles(directory: URL): Promise<URL[]> {
  const result: URL[] = [];
  for await (const entry of Deno.readDir(directory)) {
    if ([".git", "node_modules"].includes(entry.name)) continue;
    const url = new URL(entry.name + (entry.isDirectory ? "/" : ""), directory);
    if (entry.isDirectory) result.push(...await sourceFiles(url));
    else if (entry.name.endsWith(".ts")) result.push(url);
  }
  return result;
}

const source = (await Promise.all(
  (await sourceFiles(ROOT)).map((url) => Deno.readTextFile(url)),
)).join("\n");
const unused = Object.keys(config.imports ?? {}).filter((specifier) =>
  specifier !== "@/" && !source.includes(`"${specifier}"`) &&
  !source.includes(`'${specifier}'`)
);
if (unused.length) {
  console.error(`Unused deno.json imports:\n${unused.join("\n")}`);
  Deno.exit(1);
}
console.log("Dependency usage guard passed.");
