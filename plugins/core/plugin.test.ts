import { assert, assertEquals, assertStrictEquals } from "@std/assert";
import { createPluginRegistry } from "@copilotz/copilotz/plugins";
import { llmPlugin } from "@copilotz/copilotz/llm";
import { CORE_COLLECTION_NAMES, corePlugin } from "./index.ts";

const CORE_ACTION_IDS = [
  "copilotz.core.spaces",
  "copilotz.core.goal.run",
  "copilotz.core.thread.create",
  "copilotz.core.thread.addParticipant",
  "copilotz.core.thread.deleteMessages",
  "copilotz.core.message.revise",
  "copilotz.core.thread-message.create",
  "copilotz.core.ask",
];

Deno.test("core plugin is direct static plugin composition", () => {
  assertEquals(corePlugin.id, "@copilotz/core");
  const registry = createPluginRegistry({ plugins: [corePlugin] });
  assertEquals(
    Object.values(registry.collections).map((definition) => definition.name)
      .sort(),
    [...CORE_COLLECTION_NAMES].sort(),
  );
  assertEquals(
    Object.values(registry.actions).filter((a) => a.id !== "llm.call").map((
      definition,
    ) => definition.id).sort(),
    [...CORE_ACTION_IDS, "copilotz.core.context.compact"].sort(),
  );
  assertEquals(
    Object.keys(registry.processors).sort(),
    [
      "messageRouter",
      "messageInput",
      "projectTextResult",
      "projectAgentFailure",
      "projectToolResult",
      "completeAsk",
      "failAsk",
      "toolPlanCoordinator",
    ].sort(),
  );
  assertEquals(corePlugin.plugins.map((p) => p.id), [
    llmPlugin.id,
  ]);
  assertEquals(corePlugin.adapters, {});
  assertStrictEquals(corePlugin.resources.tools.ask.action, "ask");
  assertEquals("manifest" in corePlugin, false);
  assertEquals("features" in corePlugin, false);
  assertEquals(
    Object.values(corePlugin.actions).map((action) => action.id)
      .sort(),
    [...CORE_ACTION_IDS, "copilotz.core.context.compact"].sort(),
  );
});

Deno.test("application owns every LLM connection and custom LLM Adapter", () => {
  const adapter = {
    call: () => {
      throw new Error("not invoked by composition");
    },
  };
  const registry = createPluginRegistry({
    plugins: [corePlugin],
    resources: {
      llmConnections: { default: { adapter: "test" } },
    },
    adapters: { llm: { test: adapter } },
  });
  assertStrictEquals(registry.adapters.llm.test, adapter);
  assertEquals(registry.resources.llmConnections.default, {
    adapter: "test",
  });
});

Deno.test("core production modules consume public Copilotz subpaths", async () => {
  const files = [
    "plugin.ts",
    "shared/runtime-context.ts",
    "./actions/ask/index.ts",
    "shared/helpers.ts",
    "processors/message-router/index.ts",
    "processors/project-text-result/index.ts",
    "processors/project-agent-failure/index.ts",
    "processors/project-tool-result/index.ts",
    "processors/complete-ask/index.ts",
    "processors/fail-ask/index.ts",
    "processors/tool-plan-coordinator/index.ts",
    "resources/tools/ask/index.ts",
    "./actions/create-thread-message/index.ts",
    "./actions/create-thread/index.ts",
    "./actions/revise-message/index.ts",
    "./processors/message-input/index.ts",
    "./collections/participant/index.ts",
    "./collections/thread/index.ts",
    "./collections/message/index.ts",
    "processors/message-router/agents/prompt.ts",
    "shared/agents/transcript.ts",
    "shared/tool-plan.ts",
  ];
  for (const file of files) {
    const source = await Deno.readTextFile(new URL(file, import.meta.url));
    assert(!/from\s+["']\.\.\/.*runtime\//.test(source), file);
    assert(!/from\s+["']\.\.\/runtime\//.test(source), file);
  }
  const action = await Deno.readTextFile(
    new URL(
      "./actions/create-thread-message/index.ts",
      import.meta.url,
    ),
  );
  assert(action.includes("@copilotz/copilotz/actions"));
});
