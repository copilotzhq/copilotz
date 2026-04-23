import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";

import { createCopilotz } from "@/index.ts";

const TEST_AGENT = {
  id: "assistant",
  name: "Assistant",
  role: "assistant",
  instructions: "Handle the test message.",
  llmOptions: { provider: "openai", model: "gpt-4o-mini" },
} as const;

Deno.test("createCopilotz core preset no longer auto-loads the bundled native agent", async () => {
  await assertRejects(
    () =>
      createCopilotz({
        dbConfig: { url: ":memory:" },
      }),
    Error,
    "resources.imports: ['agents.copilotz']",
  );
});

Deno.test("createCopilotz always includes bundled core when custom presets are provided", async () => {
  const copilotz = await createCopilotz({
    dbConfig: { url: ":memory:" },
    agents: [TEST_AGENT],
    resources: {
      preset: ["code"],
    },
  });

  try {
    const toolKeys = (copilotz.config.tools ?? []).map((tool) => tool.key);
    const channelNames = (copilotz.config.channels ?? []).map((channel) =>
      channel.name
    );

    assert(toolKeys.includes("read_file"));
    assert(toolKeys.includes("persistent_terminal"));
    assert(toolKeys.includes("list_skills"));
    assertEquals(channelNames, ["web"]);
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("createCopilotz loads the bundled native agent only when explicitly imported", async () => {
  const copilotz = await createCopilotz({
    dbConfig: { url: ":memory:" },
    resources: {
      imports: ["agents.copilotz"],
    },
  });

  try {
    const toolKeys = (copilotz.config.tools ?? []).map((tool) => tool.key);
    const channelNames = (copilotz.config.channels ?? []).map((channel) =>
      channel.name
    );
    const memoryNames = (copilotz.config.memory ?? []).map((memory) =>
      memory.name
    );
    const bundledAgent = (copilotz.config.agents ?? []).find((agent) =>
      agent.name === "copilotz"
    );

    assert(toolKeys.includes("persistent_terminal"));
    assert(toolKeys.includes("update_my_memory"));
    assert(toolKeys.includes("list_skills"));
    assert(toolKeys.includes("load_skill"));
    assert(toolKeys.includes("read_skill_resource"));
    assert(!toolKeys.includes("read_file"));
    assertEquals(channelNames, ["web"]);
    assertEquals(memoryNames.sort(), ["history", "participant"]);
    assertEquals(bundledAgent?.allowedTools, undefined);
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("createCopilotz applies resources.filterResources after loading", async () => {
  const copilotz = await createCopilotz({
    dbConfig: { url: ":memory:" },
    agents: [TEST_AGENT],
    resources: {
      filterResources: (resource, type) =>
        !(type === "tool" && resource.id === "persistent_terminal"),
    },
  });

  try {
    const toolKeys = (copilotz.config.tools ?? []).map((tool) => tool.key);
    const memoryNames = (copilotz.config.memory ?? []).map((memory) =>
      memory.name
    );
    assert(!toolKeys.includes("persistent_terminal"));
    assert(toolKeys.includes("update_my_memory"));
    assert(memoryNames.includes("participant"));
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("createCopilotz keeps loading user features from resources.path when imports select bundled resources", async () => {
  const tempDir = await Deno.makeTempDir();
  const resourcesDir = join(tempDir, "resources");
  const featuresDir = join(resourcesDir, "features", "auth");

  try {
    await Deno.mkdir(featuresDir, { recursive: true });
    await Deno.writeTextFile(
      join(featuresDir, "google.ts"),
      `export default async function googleFeature(request) {
  return {
    data: {
      method: request.method ?? "GET",
      ok: true,
    },
  };
}
`,
    );

    const copilotz = await createCopilotz({
      dbConfig: { url: ":memory:" },
      agents: [{
        id: "test-agent",
        name: "Test Agent",
        role: "Test Agent",
        instructions: "Handle the test message.",
        llmOptions: { provider: "openai", model: "gpt-4o-mini" },
      }],
      resources: {
        path: [resourcesDir],
        imports: ["channels"],
      },
    });

    try {
      const featureNames = (copilotz.config.features ?? []).map((feature) =>
        feature.name
      );
      const channelNames = (copilotz.config.channels ?? []).map((channel) =>
        channel.name
      );

      assert(featureNames.includes("auth"));
      assert(channelNames.includes("web"));
    } finally {
      await copilotz.shutdown();
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("createCopilotz initializes collections loaded from resources.path", async () => {
  const tempDir = await Deno.makeTempDir();
  const resourcesDir = join(tempDir, "resources");
  const collectionsDir = join(resourcesDir, "collections");
  const copilotzEntryUrl = new URL("../index.ts", import.meta.url).href;

  try {
    await Deno.mkdir(collectionsDir, { recursive: true });
    await Deno.writeTextFile(
      join(collectionsDir, "userProfile.ts"),
      `import { defineCollection } from "${copilotzEntryUrl}";

export default defineCollection({
  name: "userProfile",
  schema: {
    type: "object",
    properties: {
      id: { type: "string" },
      fullName: { type: "string" }
    }
  },
  keys: [{ property: "id" }],
  indexes: ["id"],
});
`,
    );

    const copilotz = await createCopilotz({
      dbConfig: { url: ":memory:" },
      agents: [TEST_AGENT],
      resources: { path: [resourcesDir] },
      collectionsConfig: { autoIndex: false },
    });

    try {
      assert(copilotz.collections);
      assert(
        copilotz.collections?.getCollectionNames().includes("userProfile"),
      );
    } finally {
      await copilotz.shutdown();
    }
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("createCopilotz rejects asset backends that were filtered out", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await assertRejects(
      () =>
        createCopilotz({
          dbConfig: { url: ":memory:" },
          agents: [TEST_AGENT],
          resources: {
            filterResources: (resource, type) =>
              !(type === "storage" && resource.name === "fs"),
          },
          assets: {
            config: {
              backend: "fs",
              fs: { rootDir: tempDir },
            },
          },
        }),
      Error,
      `Asset storage backend "fs" is not loaded.`,
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
