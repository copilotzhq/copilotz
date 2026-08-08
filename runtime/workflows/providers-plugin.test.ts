import { assert, assertEquals } from "@std/assert";

import { createPluginRegistry, definePlugin } from "../plugins/index.ts";
import {
  createBuiltInLlmProvidersPlugin,
  defineLlmProviderResource,
  type LlmProviderResource,
} from "./index.ts";

Deno.test("built-in provider plugin exposes every mature adapter as a resource", async () => {
  const plugin = createBuiltInLlmProvidersPlugin();
  assertEquals(plugin.manifest.provides.providers, [
    "openai",
    "anthropic",
    "gemini",
    "groq",
    "deepseek",
    "ollama",
    "minimax",
  ]);
  const registry = await createPluginRegistry({ plugins: [plugin] });
  for (const id of plugin.manifest.provides.providers ?? []) {
    const provider = registry.require<LlmProviderResource>("providers", id);
    assertEquals(provider.id, id);
    assertEquals(provider.type, "llm");
    assertEquals(typeof provider.factory, "function");
  }
});

Deno.test("application provider resources override bundled factories by stable ID", async () => {
  const replacement = defineLlmProviderResource({
    id: "openai",
    type: "llm",
    factory: () => ({ replacement: true } as never),
  });
  const app = definePlugin({
    manifest: {
      id: "test.providers",
      version: "1.0.0",
      provides: { providers: [replacement.id] },
    },
    resources: { providers: [replacement] },
  });
  const registry = await createPluginRegistry({
    plugins: [
      createBuiltInLlmProvidersPlugin({ include: ["openai"] }),
      app,
    ],
  });
  assertEquals(
    registry.require<LlmProviderResource>("providers", "openai"),
    replacement,
  );
  assert(
    registry.origin("providers", "openai")?.pluginId === "test.providers",
  );
});

Deno.test("A55 built-in provider packaging remains factory-first and runtime-neutral", async () => {
  const source = await Deno.readTextFile(
    new URL("providers-plugin.ts", import.meta.url),
  );
  assert(!/\bclass\s+\w+/.test(source));
  assert(!/from\s+["']node:/.test(source));
  assert(!/unsafeGraph|producedEvents|queueId|runGeneration/.test(source));
});
