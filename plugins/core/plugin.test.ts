import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import {
  CORE_COLLECTION_NAMES,
  coreCollectionsPlugin,
  corePlugin,
} from "./index.ts";

const CORE_ACTION_IDS = [
  "copilotz.core.thread.create",
  "copilotz.core.thread.addParticipant",
  "copilotz.core.thread.deleteMessages",
  "copilotz.core.message.revise",
  "copilotz.core.thread-message.create",
  "copilotz.core.llm.generate",
  "copilotz.core.llm.session",
  "copilotz.core.tool.call",
  "copilotz.core.tool-batch.execute",
];

Deno.test("core plugin is direct static plugin composition", () => {
  assertEquals(corePlugin.id, "@copilotz/core");
  assertEquals(
    Object.values(corePlugin.collections).map((definition) => definition.name),
    [...CORE_COLLECTION_NAMES],
  );
  assertEquals(
    Object.values(corePlugin.actions).map((definition) => definition.id),
    CORE_ACTION_IDS,
  );
  assertEquals(Object.keys(corePlugin.processors), [
    "messageRouter",
    "messageInput",
    "projectTextResult",
    "projectToolResult",
    "completeAsk",
    "failAsk",
  ]);
  assertEquals(Object.keys(corePlugin.adapters.llm), [
    "openai",
    "anthropic",
    "gemini",
    "groq",
    "deepseek",
    "ollama",
    "minimax",
  ]);
  assert(
    Object.values(corePlugin.adapters.llm).every((adapter) =>
      typeof adapter.generate === "function"
    ),
  );
  assertStrictEquals(corePlugin.resources.tools.ask.id, "ask");
  assertEquals("manifest" in corePlugin, false);
  assertEquals("features" in corePlugin, false);
  assertEquals(
    Object.values(coreCollectionsPlugin.actions).map((action) => action.id),
    CORE_ACTION_IDS,
  );
});

Deno.test("application LLM Adapters overlay Core by alias", () => {
  const replacement = {
    id: "openai",
    type: "llm",
    generate: () => {
      throw new Error("replacement generate");
    },
  };
  const registry = createPluginRegistry({
    plugins: [corePlugin],
    adapters: { llm: { openai: replacement } },
  });
  assertStrictEquals(registry.adapters.llm.openai, replacement);
});

Deno.test("core production modules consume public Copilotz subpaths", async () => {
  const files = [
    "plugin.ts",
    "context.ts",
    "resources/llm/index.ts",
    "resources/actions/thread-message.ts",
    "resources/actions/llm.ts",
    "resources/actions/tool.ts",
    "resources/actions/thread.ts",
    "resources/actions/message.ts",
    "resources/processors/helpers.ts",
    "resources/processors/index.ts",
    "resources/processors/message-router.ts",
    "resources/processors/message-input.ts",
    "resources/processors/project-text-result.ts",
    "resources/processors/project-tool-result.ts",
    "resources/processors/complete-ask.ts",
    "resources/processors/fail-ask.ts",
    "resources/tools/ask.ts",
    "resources/collections/participant.ts",
    "resources/collections/thread.ts",
    "resources/collections/message.ts",
  ];
  for (const file of files) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assert(!/from\s+["']\.\.\/.*runtime\//.test(source), file);
    assert(!/from\s+["']\.\.\/runtime\//.test(source), file);
  }
  const action = await Deno.readTextFile(
    new URL("resources/actions/thread-message.ts", import.meta.url),
  );
  assert(action.includes("@copilotz/copilotz/actions"));
});
