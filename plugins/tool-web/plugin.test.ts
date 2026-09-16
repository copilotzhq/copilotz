import { definePlugin } from "@copilotz/copilotz/plugins";
import { fetchTextTool } from "./resources/index.ts";
/**
 * Verifies Web Tool composition and runtime-neutral boundaries.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "@copilotz/copilotz/actions";

import type { ToolResource } from "../core/authoring/define-tool/index.ts";
import { WEB_TOOL_IDS, webToolsPlugin } from "./plugin.ts";

Deno.test("Web tools compose as stable plugin resources", () => {
  const plugin = webToolsPlugin;
  const tools = plugin.resources.tools as
    | Readonly<Record<string, ToolResource>>
    | undefined;
  assertEquals(Object.keys(tools ?? {}), [...WEB_TOOL_IDS]);
  assertEquals(
    Object.values(tools ?? {}).map((value) => value.action),
    [...WEB_TOOL_IDS],
  );
  assert(
    Object.values(tools ?? {}).every((value) => !("execute" in value)),
  );
  assertEquals(Object.keys(plugin.actions), [...WEB_TOOL_IDS]);
});

Deno.test("Web tool selection registers only explicit declarations", () => {
  const plugin = definePlugin({
    id: "test.web",
    version: "1",
    resources: { tools: { fetch: fetchTextTool } },
  });
  assertEquals(Object.keys(plugin.actions), ["fetch"]);
  assertEquals(plugin.resources.tools.fetch.action, "fetch");
});

Deno.test("Web tool plugin excludes filesystem, process, and class APIs", async () => {
  for (
    const module of [
      "plugin.ts",
      "actions/http-request/index.ts",
      "actions/fetch-text/index.ts",
      "actions/web-search/index.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/\bDeno\./.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
    assert(!/\bprocess\./.test(source), module);
    assert(!/^\s*(?:export\s+)?class\s/m.test(source), module);
  }
});

Deno.test("Web Actions preserve caller cancellation as AbortError", async () => {
  const plugin = webToolsPlugin;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(new DOMException("cancelled", "AbortError"));
        return;
      }
      init?.signal?.addEventListener("abort", () =>
        reject(new DOMException("cancelled", "AbortError")), { once: true });
    });
  try {
    for (
      const [alias, input] of [
        ["http_request", { url: "https://example.test" }],
        ["fetch_text", { url: "https://example.test" }],
        ["web_search", { query: "cancel me" }],
      ] as const
    ) {
      const controller = new AbortController();
      const action = plugin.actions[alias] as unknown as {
        execute(
          input: unknown,
          context: ActionContext,
        ): unknown | Promise<unknown>;
      };
      const execution = action.execute(input, {
        signal: controller.signal,
      } as ActionContext);
      controller.abort(new Error("caller stopped"));
      const error = await assertRejects(async () => await execution);
      assertEquals((error as Error).name, "AbortError", alias);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});
