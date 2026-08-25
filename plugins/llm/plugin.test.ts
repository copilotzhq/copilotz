import { assertEquals, assertStrictEquals } from "@std/assert";
import { callLlmAction } from "./actions/call-llm/index.ts";
import { LLM_PLUGIN_ID, LLM_PLUGIN_VERSION, llmPlugin } from "./plugin.ts";

Deno.test("llmPlugin composes only the provider-neutral call Action", () => {
  assertEquals(llmPlugin.id, LLM_PLUGIN_ID);
  assertEquals(llmPlugin.version, LLM_PLUGIN_VERSION);
  assertStrictEquals(llmPlugin.actions.callLlm, callLlmAction);
});
