import { assert, assertEquals } from "@std/assert";

import { createCollectionRuntime } from "@copilotz/copilotz/collections";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { createCopilotz } from "../../create-copilotz.ts";
import {
  CORE_COLLECTION_NAMES,
  coreCollectionsPlugin,
  corePlugin,
} from "./index.ts";

const CORE_FEATURE_IDS = [
  "copilotz.core.thread-message",
  "copilotz.core.llm-attempt",
  "copilotz.core.tool-execution",
  "copilotz.core.thread",
  "copilotz.core.message",
];

Deno.test("core plugin is static data and provides its domain resources", () => {
  assertEquals(corePlugin.manifest.id, "@copilotz/core");
  assertEquals(corePlugin.manifest.provides.collections, [
    ...CORE_COLLECTION_NAMES,
  ]);
  assertEquals(
    corePlugin.resources.collections?.map((item) =>
      (item as { name: string }).name
    ),
    [...CORE_COLLECTION_NAMES],
  );
  assertEquals(
    corePlugin.resources.processors?.map((item) => (item as { id: string }).id),
    [
      "copilotz.core.message-to-text-attempt",
      "copilotz.core.execute-text-attempt",
      "copilotz.core.execute-tool",
      "copilotz.core.project-text-result",
      "copilotz.core.project-tool-result",
      "copilotz.core.complete-agent-ask",
      "copilotz.core.fail-agent-ask",
    ],
  );
  assertEquals(
    corePlugin.resources.llm?.map((item) => (item as { id: string }).id),
    [
      "openai",
      "anthropic",
      "gemini",
      "groq",
      "deepseek",
      "ollama",
      "minimax",
    ],
  );
  assert(
    corePlugin.resources.llm?.every((item) =>
      typeof (item as { generate?: unknown }).generate === "function"
    ),
  );
  assertEquals(
    corePlugin.manifest.provides.features,
    CORE_FEATURE_IDS,
  );
  assertEquals(
    corePlugin.resources.features?.map((item) => (item as { id: string }).id),
    CORE_FEATURE_IDS,
  );
  assertEquals(
    coreCollectionsPlugin.resources.features?.map((item) =>
      (item as { id: string }).id
    ),
    CORE_FEATURE_IDS,
  );
});

Deno.test("application llm resources override core adapters by stable ID", async () => {
  const replacement = {
    id: "openai",
    type: "llm",
    generate: () => {
      throw new Error("replacement generate");
    },
  };
  const registry = await createPluginRegistry({
    core: corePlugin,
    plugins: [{
      manifest: {
        id: "test.providers",
        version: "1.0.0",
        provides: { llm: ["openai"] },
      },
      resources: { llm: [replacement] },
    }],
  });
  assertEquals(registry.require("llm", "openai"), replacement);
  assertEquals(registry.origin("llm", "openai")?.pluginId, "test.providers");
});

Deno.test("core plugin collections win until a later plugin replaces a stable ID", async () => {
  const replacement = {
    name: "stream",
    schema: { type: "object", properties: {} },
  };
  const registry = await createPluginRegistry({
    core: corePlugin,
    plugins: [{
      manifest: {
        id: "acme.streams",
        version: "1.0.0",
        provides: { collections: ["stream"] },
      },
      resources: { collections: [replacement] },
    }],
  });
  assertEquals(
    registry.require("collections", "participant"),
    corePlugin.resources.collections?.find((item) =>
      (item as { name: string }).name === "participant"
    ),
  );
  assertEquals(registry.require("collections", "stream"), replacement);
  assertEquals(
    registry.origin("collections", "stream")?.pluginId,
    "acme.streams",
  );
});

Deno.test("package-root createCopilotz injects corePlugin before optional built-ins", async () => {
  const application = await createCopilotz({
    namespace: "phase-4-core",
    core: false,
  });
  try {
    assertEquals(application.config.corePluginIds[0], "@copilotz/core");
    assert(application.plugins.get("collections", "participant"));
    assertEquals(application.plugins.list("embedding").length, 0);
  } finally {
    await application.shutdown();
  }
});

Deno.test("core plugin production files import Copilotz through public subpaths", async () => {
  const files = [
    "plugin.ts",
    "manifest.ts",
    "resources/llm/index.ts",
    "resources/features/thread-message.ts",
    "resources/processors/helpers.ts",
    "resources/processors/text.ts",
    "resources/processors/ask.ts",
    "resources/collections/participant.ts",
    "resources/collections/thread.ts",
    "resources/collections/message.ts",
    "resources/collections/llm-attempt.ts",
    "resources/collections/tool-execution.ts",
    "resources/collections/stream.ts",
  ];
  for (const file of files) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assert(!/from\s+["']\.\.\/.*runtime\//.test(source), file);
    assert(!/from\s+["']\.\.\/runtime\//.test(source), file);
  }
  const plugin = await Deno.readTextFile(new URL("plugin.ts", import.meta.url));
  assert(plugin.includes("@copilotz/copilotz/plugins"));
  const participant = await Deno.readTextFile(
    new URL("resources/collections/participant.ts", import.meta.url),
  );
  assert(participant.includes("@copilotz/copilotz/collections"));
  const feature = await Deno.readTextFile(
    new URL("resources/features/thread-message.ts", import.meta.url),
  );
  assert(feature.includes("@copilotz/copilotz/features"));
  assertEquals(typeof createCollectionRuntime, "function");
});
