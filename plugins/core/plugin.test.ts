import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { llmPlugin } from "@copilotz/copilotz/llm";
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
  "copilotz.core.ask",
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
  assertEquals(corePlugin.plugins, [llmPlugin]);
  assertEquals(corePlugin.adapters, {});
  assertStrictEquals(corePlugin.resources.tools.ask.action, "ask");
  assertEquals("manifest" in corePlugin, false);
  assertEquals("features" in corePlugin, false);
  assertEquals(
    Object.values(coreCollectionsPlugin.actions).map((action) => action.id),
    CORE_ACTION_IDS,
  );
});

Deno.test("application owns every Model Resource and LLM Adapter", () => {
  const adapter = {
    call: () => {
      throw new Error("not invoked by composition");
    },
  };
  const registry = createPluginRegistry({
    plugins: [corePlugin],
    resources: {
      models: { default: { adapter: "test", model: "test-model" } },
    },
    adapters: { llm: { test: adapter } },
  });
  assertStrictEquals(registry.adapters.llm.test, adapter);
  assertEquals(registry.resources.models.default, {
    adapter: "test",
    model: "test-model",
  });
});

Deno.test("core production modules consume public Copilotz subpaths", async () => {
  const files = [
    "plugin.ts",
    "context.ts",
    "resources/actions/thread-message.ts",
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
    "internal/agents/prompt.ts",
    "internal/agents/transcript.ts",
    "internal/tool-plan.ts",
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
