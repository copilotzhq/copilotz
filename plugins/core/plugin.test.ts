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
    "projectAgentFailure",
    "projectToolResult",
    "completeAsk",
    "failAsk",
    "toolPlanCoordinator",
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

Deno.test("application owns every Model Resource and custom LLM Adapter", () => {
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
    "internal/runtime-context.ts",
    "actions/ask/index.ts",
    "processors/internal/helpers.ts",
    "processors/index.ts",
    "processors/message-router/index.ts",
    "processors/project-text-result/index.ts",
    "processors/project-agent-failure/index.ts",
    "processors/project-tool-result/index.ts",
    "processors/complete-ask/index.ts",
    "processors/fail-ask/index.ts",
    "processors/tool-plan-coordinator/index.ts",
    "resources/ask-tool/index.ts",
    "../core-collections/actions/create-thread-message/index.ts",
    "../core-collections/actions/create-thread/index.ts",
    "../core-collections/actions/revise-message/index.ts",
    "../core-collections/processors/message-input/index.ts",
    "../core-collections/collections/participant/index.ts",
    "../core-collections/collections/thread/index.ts",
    "../core-collections/collections/message/index.ts",
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
    new URL(
      "../core-collections/actions/create-thread-message/index.ts",
      import.meta.url,
    ),
  );
  assert(action.includes("@copilotz/copilotz/actions"));
});
