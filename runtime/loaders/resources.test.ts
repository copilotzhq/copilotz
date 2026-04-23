import {
  assertEquals,
  assertExists,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import loadResources from "./resources.ts";

async function writeFixtureFile(path: string, content: string): Promise<void> {
  const dir = path.replace(/\/[^/]+$/, "");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(path, content);
}

Deno.test("loadResources resolves presets plus imports from manifest selection", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await writeFixtureFile(
      `${tempDir}/manifest.ts`,
      `export default {
        provides: {
          agents: ["assistant"],
          tools: ["core_tool", "extra_tool"],
          memory: ["participant"],
          channels: ["web", "whatsapp"],
          llm: ["openai"],
          embeddings: ["openai"],
          storage: ["fs"],
        },
        presets: {
          core: ["agents.assistant", "tools.core_tool", "memory.participant", "llm"],
        },
      };`,
    );

    await writeFixtureFile(
      `${tempDir}/agents/assistant/instructions.md`,
      "You are a helpful assistant.",
    );
    await writeFixtureFile(
      `${tempDir}/agents/assistant/config.ts`,
      `export default { role: "assistant" };`,
    );

    await writeFixtureFile(
      `${tempDir}/tools/core_tool/config.ts`,
      `export default {
        key: "core_tool",
        name: "Core Tool",
        description: "Core tool",
        inputSchema: { type: "object", properties: {} },
      };`,
    );
    await writeFixtureFile(
      `${tempDir}/tools/core_tool/execute.ts`,
      `export default async () => "ok";`,
    );
    await writeFixtureFile(
      `${tempDir}/tools/extra_tool/config.ts`,
      `export default {
        key: "extra_tool",
        name: "Extra Tool",
        description: "Extra tool",
        inputSchema: { type: "object", properties: {} },
      };`,
    );
    await writeFixtureFile(
      `${tempDir}/tools/extra_tool/execute.ts`,
      `export default async () => "extra";`,
    );

    await writeFixtureFile(
      `${tempDir}/memory/mod.ts`,
      `export const participant = {
        name: "participant",
        kind: "participant",
        description: "participant memory",
      };`,
    );

    await writeFixtureFile(
      `${tempDir}/channels/web/ingress.ts`,
      `export default { async handle() { return { messages: [] }; } };`,
    );
    await writeFixtureFile(
      `${tempDir}/channels/whatsapp/egress.ts`,
      `export default { async deliver() {} };`,
    );

    await writeFixtureFile(
      `${tempDir}/llm/mod.ts`,
      `export const openai = () => ({
        endpoint: "https://example.com",
        headers: () => ({}),
        body: () => ({}),
        extractContent: () => null,
      });`,
    );
    await writeFixtureFile(
      `${tempDir}/embeddings/mod.ts`,
      `export const openai = () => ({
        endpoint: "https://example.com",
        headers: () => ({}),
        body: () => ({}),
        extractEmbeddings: () => [],
      });`,
    );
    await writeFixtureFile(
      `${tempDir}/storage/mod.ts`,
      `export const fs = { createFsConnector() { return {}; } };`,
    );

    const resources = await loadResources({
      path: tempDir,
      preset: ["core"],
      imports: ["channels.whatsapp"],
    });

    assertEquals(resources.agents.map((agent) => agent.name), ["assistant"]);
    assertEquals(resources.tools?.map((tool) => tool.key), ["core_tool"]);
    assertEquals(resources.memory?.length ?? 0, 1);
    assertEquals(resources.memory?.[0]?.name, "participant");
    assertEquals(resources.channels?.map((channel) => channel.name), [
      "whatsapp",
    ]);
    assertEquals(resources.llm?.map((provider) => provider.name), ["openai"]);
    assertEquals(resources.embeddings?.length ?? 0, 0);
    assertEquals(resources.storage?.length ?? 0, 0);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadResources applies dot-notation imports to local directory discovery", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await writeFixtureFile(
      `${tempDir}/agents/alpha/instructions.md`,
      "Alpha instructions",
    );
    await writeFixtureFile(
      `${tempDir}/agents/beta/instructions.md`,
      "Beta instructions",
    );
    await writeFixtureFile(
      `${tempDir}/tools/alpha/config.ts`,
      `export default {
        key: "alpha",
        name: "alpha",
        description: "alpha",
        inputSchema: { type: "object", properties: {} },
      };`,
    );
    await writeFixtureFile(
      `${tempDir}/tools/alpha/execute.ts`,
      `export default async () => "alpha";`,
    );
    await writeFixtureFile(
      `${tempDir}/tools/beta/config.ts`,
      `export default {
        key: "beta",
        name: "beta",
        description: "beta",
        inputSchema: { type: "object", properties: {} },
      };`,
    );
    await writeFixtureFile(
      `${tempDir}/tools/beta/execute.ts`,
      `export default async () => "beta";`,
    );

    const resources = await loadResources({
      path: tempDir,
      imports: ["agents", "tools.alpha"],
    });

    assertEquals(resources.agents.map((agent) => agent.name).sort(), [
      "alpha",
      "beta",
    ]);
    assertEquals(resources.tools?.map((tool) => tool.name), ["alpha"]);
    assertExists(resources.tools?.[0]?.execute);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadResources accepts index.ts tool modules as a fallback format", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await writeFixtureFile(
      `${tempDir}/manifest.ts`,
      `export default {
        provides: {
          agents: ["assistant"],
          tools: ["index_only_tool"],
        },
      };`,
    );
    await writeFixtureFile(
      `${tempDir}/agents/assistant/instructions.md`,
      "Assistant instructions",
    );
    await writeFixtureFile(
      `${tempDir}/tools/index_only_tool/index.ts`,
      `export default {
        key: "index_only_tool",
        name: "Index Only Tool",
        description: "Loaded from index.ts",
        inputSchema: { type: "object", properties: {} },
        async execute() {
          return "ok";
        },
      };`,
    );

    const manifestResources = await loadResources({
      path: tempDir,
      imports: ["tools.index_only_tool"],
    });

    assertEquals(manifestResources.tools?.map((tool) => tool.key), [
      "index_only_tool",
    ]);
    assertExists(manifestResources.tools?.[0]?.execute);

    await Deno.remove(`${tempDir}/manifest.ts`);

    const directoryResources = await loadResources({
      path: tempDir,
      imports: ["tools.index_only_tool"],
    });

    assertEquals(directoryResources.tools?.map((tool) => tool.key), [
      "index_only_tool",
    ]);
    assertExists(directoryResources.tools?.[0]?.execute);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("loadResources merges collections across multiple resource paths", async () => {
  const firstDir = await Deno.makeTempDir();
  const secondDir = await Deno.makeTempDir();

  try {
    await writeFixtureFile(
      `${firstDir}/collections/userProfile.ts`,
      `export default {
        name: "userProfile",
        schema: { type: "object", properties: { id: { type: "string" } } },
        keys: [{ property: "id" }],
      };`,
    );
    await writeFixtureFile(
      `${secondDir}/tools/extra/config.ts`,
      `export default {
        key: "extra",
        name: "extra",
        description: "extra",
        inputSchema: { type: "object", properties: {} },
      };`,
    );
    await writeFixtureFile(
      `${secondDir}/tools/extra/execute.ts`,
      `export default async () => "ok";`,
    );

    const resources = await loadResources({
      path: [firstDir, secondDir],
    });

    assertEquals(resources.collections?.map((collection) => collection.name), [
      "userProfile",
    ]);
    assertEquals(resources.tools?.map((tool) => tool.key), ["extra"]);
  } finally {
    await Deno.remove(firstDir, { recursive: true });
    await Deno.remove(secondDir, { recursive: true });
  }
});
