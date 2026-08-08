import { assert, assertEquals, assertStringIncludes } from "@std/assert";

const repositoryRoot = new URL("../../", import.meta.url);

async function source(path: string): Promise<string> {
  return await Deno.readTextFile(new URL(path, repositoryRoot));
}

Deno.test("every declared package export resolves to a source file", async () => {
  const configuration = JSON.parse(await source("deno.json")) as {
    exports: Record<string, string>;
  };
  for (const [subpath, target] of Object.entries(configuration.exports)) {
    const stat = await Deno.stat(new URL(target, repositoryRoot));
    assert(stat.isFile, `${subpath} -> ${target}`);
  }
});

Deno.test("generic package and adapter entrypoints exclude host-only MCP stdio", async () => {
  const root = await source("index.ts");
  const genericAdapters = await source("runtime/adapters/index.ts");
  const genericCatalog = await source(
    "runtime/adapters/server-tool-catalog.ts",
  );
  const stdioAdapters = await source("runtime/adapters/stdio.ts");

  for (
    const [name, value] of [
      ["root", root],
      ["generic adapters", genericAdapters],
      ["generic catalog", genericCatalog],
    ] as const
  ) {
    assert(!/from\s+["']node:/.test(value), name);
    assert(!/\b(?:Deno|Bun|process)\./.test(value), name);
    assert(!/stdio-mcp/.test(value), name);
  }
  assertStringIncludes(stdioAdapters, "connectMcp");
});

Deno.test("portable smoke contract uses only Web and injected capabilities", async () => {
  const smoke = await source("contracts/runtime/runtime-neutral-smoke.ts");
  assert(!/from\s+["']node:/.test(smoke));
  assert(!/\b(?:Deno|Bun|process)\./.test(smoke));
  for (
    const capability of [
      "ReadableStream",
      "TextEncoder",
      "Response",
      "definePlugin",
      "defineLlmProviderResource",
    ]
  ) assertStringIncludes(smoke, capability);
});

Deno.test("optional skills implementation stays off the root runtime graph", async () => {
  const root = await source("index.ts");
  const skills = await source("runtime/skills/index.ts");
  assert(!/runtime\/skills/.test(root));
  assertStringIncludes(skills, "parseSkillMarkdown");
  assertStringIncludes(skills, "createSkillsPlugin");
});

Deno.test("agent capability resolution remains factory-first and host-neutral", async () => {
  for (
    const module of [
      "runtime/capabilities/grants.ts",
      "runtime/capabilities/resolver.ts",
      "runtime/capabilities/selection.ts",
      "runtime/capabilities/types.ts",
    ]
  ) {
    const value = await source(module);
    assert(!/^\s*(?:export\s+)?class\s/m.test(value), module);
    assert(!/from\s+["']node:|\b(?:Deno|Bun|process)\./.test(value), module);
  }
});

Deno.test("runtime-neutral Ominipg and Oxian release lines are pinned", async () => {
  assertStringIncludes(
    await source("dependencies/ominipg.ts"),
    "@oxian/ominipg@0.9.0-rc.3",
  );
  assertStringIncludes(
    await source("dependencies/oxian-hypervisor.ts"),
    "@oxian/oxian-js@0.20.0-rc.7",
  );
  assertStringIncludes(
    await source("dependencies/oxian-work.ts"),
    "@oxian/oxian-js@0.20.0-rc.7",
  );
  assertStringIncludes(
    await source("dependencies/oxian-worker.ts"),
    "@oxian/oxian-js@0.20.0-rc.7",
  );
  assertEquals(
    /@modelcontextprotocol\/sdk@1\.29\.0/.test(
      await source("dependencies/mcp-client.ts"),
    ),
    true,
  );
});
