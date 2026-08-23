import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";

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

Deno.test("published documentation matches the final version and subpaths", async () => {
  const configuration = JSON.parse(await source("deno.json")) as {
    version: string;
    exports: Record<string, string>;
  };
  assertEquals(configuration.version, "0.62.0");
  const readme = await source("README.md");
  assertStringIncludes(readme, `@^${configuration.version}`);
  for (const subpath of Object.keys(configuration.exports)) {
    if (subpath === ".") continue;
    assertStringIncludes(readme, subpath.slice(1), subpath);
  }

  const manifest = JSON.parse(await source("docs/manifest.json")) as {
    sections: readonly {
      items: readonly { slug: string }[];
    }[];
  };
  for (const section of manifest.sections) {
    for (const item of section.items) {
      const stat = await Deno.stat(
        new URL(`docs/${item.slug}.md`, repositoryRoot),
      );
      assert(stat.isFile, item.slug);
    }
  }

  const publishedDocs = [
    readme,
    ...await Promise.all(
      Array.from(Deno.readDirSync(new URL("docs/", repositoryRoot)))
        .filter((entry) => entry.isFile && entry.name.endsWith(".md"))
        .map((entry) => source(`docs/${entry.name}`)),
    ),
  ].join("\n");
  assert(
    !/@copilotz\/copilotz\/(?:domain|attachments|adapters\/node|migration\/(?:v1|content-v2|memory-v4))\b/
      .test(
        publishedDocs,
      ),
  );
  for (
    const deleted of [
      "docs/application-resilience-plan.md",
      "docs/content-v2-migration.md",
      "docs/migration-v3.md",
      "docs/realtime-attachments.md",
      "docs/v3/README.md",
    ]
  ) {
    await assertRejects(() => Deno.stat(new URL(deleted, repositoryRoot)));
  }
});

Deno.test("root and generated Tool factories exclude host-only MCP stdio", async () => {
  const root = await source("index.ts");
  const openApiFactory = await source("plugins/tools/openapi/generator.ts");
  const mcpFactory = await source("plugins/tools/mcp/generator.ts");
  const stdioMcp = await source("plugins/tools/mcp/stdio.ts");

  for (
    const [name, value] of [
      ["root", root],
      ["OpenAPI factory", openApiFactory],
      ["MCP factory", mcpFactory],
    ] as const
  ) {
    assert(!/from\s+["']node:/.test(value), name);
    assert(!/\b(?:Deno|Bun|process)\./.test(value), name);
    assert(!/stdio-mcp/.test(value), name);
  }
  assertStringIncludes(stdioMcp, "connectMcp");
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
      "defineModel",
      "LlmAdapter",
    ]
  ) assertStringIncludes(smoke, capability);
});

Deno.test("optional skills implementation stays off the root runtime graph", async () => {
  const root = await source("index.ts");
  const skills = await source("plugins/skills/index.ts");
  assert(!/runtime\/skills/.test(root));
  assertStringIncludes(skills, "parseSkillMarkdown");
  assertStringIncludes(skills, "createSkillsPlugin");
});

Deno.test("agent capability resolution remains factory-first and host-neutral", async () => {
  for (
    const module of [
      "plugins/core/internal/capabilities/grants.ts",
      "plugins/core/internal/capabilities/resolver.ts",
      "plugins/core/internal/capabilities/selection.ts",
      "plugins/core/internal/capabilities/types.ts",
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
    "@oxian/ominipg@0.9.0-rc.10",
  );
  assertStringIncludes(
    await source("dependencies/oxian-hypervisor.ts"),
    "@oxian/oxian-js@0.21.0-rc.4",
  );
  assertStringIncludes(
    await source("dependencies/oxian-work.ts"),
    "@oxian/oxian-js@0.21.0-rc.4",
  );
  assertStringIncludes(
    await source("dependencies/oxian-worker.ts"),
    "@oxian/oxian-js@0.21.0-rc.4",
  );
  assertEquals(
    /@modelcontextprotocol\/sdk@1\.29\.0/.test(
      await source("dependencies/mcp-client.ts"),
    ),
    true,
  );
});
