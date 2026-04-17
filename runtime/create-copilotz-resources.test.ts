import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { createCopilotz } from "@/index.ts";

Deno.test("createCopilotz loads the bundled core preset by default", async () => {
  const copilotz = await createCopilotz({
    dbConfig: { url: ":memory:" },
  });

  try {
    const toolKeys = (copilotz.config.tools ?? []).map((tool) => tool.key);
    const channelNames = (copilotz.config.channels ?? []).map((channel) =>
      channel.name
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
    assertEquals(bundledAgent?.allowedTools, undefined);
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("createCopilotz always includes bundled core when custom presets are provided", async () => {
  const copilotz = await createCopilotz({
    dbConfig: { url: ":memory:" },
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

Deno.test("createCopilotz applies resources.filterResources after loading", async () => {
  const copilotz = await createCopilotz({
    dbConfig: { url: ":memory:" },
    resources: {
      filterResources: (resource, type) =>
        !(type === "tool" && resource.id === "persistent_terminal"),
    },
  });

  try {
    const toolKeys = (copilotz.config.tools ?? []).map((tool) => tool.key);
    assert(!toolKeys.includes("persistent_terminal"));
    assert(toolKeys.includes("update_my_memory"));
  } finally {
    await copilotz.shutdown();
  }
});

Deno.test("createCopilotz rejects asset backends that were filtered out", async () => {
  const tempDir = await Deno.makeTempDir();

  try {
    await assertRejects(
      () =>
        createCopilotz({
          dbConfig: { url: ":memory:" },
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
