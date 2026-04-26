import { fromFileUrl, join, relative } from "jsr:@std/path@1";

function toDataUrlMarkdown(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return `data:text/markdown;base64,${base64}`;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch {
    return false;
  }
}

function buildModuleSource(dataUrl: string): string {
  return [
    "// This file is generated. Do not edit manually.",
    `export default ${JSON.stringify(dataUrl)};`,
    "",
  ].join("\n");
}

async function main() {
  const repoRoot = fromFileUrl(new URL("..", import.meta.url));
  const skillsRoot = join(repoRoot, "resources", "skills");

  const generated: string[] = [];
  for await (const entry of Deno.readDir(skillsRoot)) {
    if (!entry.isDirectory) continue;
    const dir = entry.name;
    const mdPath = join(skillsRoot, dir, "SKILL.md");
    if (!(await fileExists(mdPath))) continue;

    const jsPath = join(skillsRoot, dir, "SKILL.js");
    const bytes = await Deno.readFile(mdPath);
    const dataUrl = toDataUrlMarkdown(bytes);
    const src = buildModuleSource(dataUrl);

    await Deno.writeTextFile(jsPath, src);
    generated.push(relative(repoRoot, jsPath));
  }

  console.log(`Generated ${generated.length} SKILL.js files:`);
  for (const p of generated) console.log(`- ${p}`);
}

if (import.meta.main) {
  await main();
}

