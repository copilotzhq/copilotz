/**
 * Verifies Web Tool composition and runtime-neutral boundaries.
 *
 * @module
 */

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { ActionContext } from "@copilotz/copilotz/actions";

import type { ToolResource } from "../tools/authoring/define-tool/index.ts";
import { createWebToolsPlugin, WEB_TOOL_IDS } from "./plugin.ts";

Deno.test("Web tools compose as stable plugin resources", () => {
  const plugin = createWebToolsPlugin();
  const tools = plugin.resources.tools as
    | Readonly<Record<string, ToolResource>>
    | undefined;
  assertEquals(Object.keys(tools ?? {}), [...WEB_TOOL_IDS]);
  assertEquals(
    Object.values(tools ?? {}).map((value) => value.action),
    [...WEB_TOOL_IDS],
  );
  assert(
    Object.values(tools ?? {}).every((value) =>
      !("execute" in value) && Object.isFrozen(value)
    ),
  );
  assertEquals(Object.keys(plugin.actions), [...WEB_TOOL_IDS]);
});

Deno.test("Web tool selection is explicit and validated", () => {
  assertEquals(
    Object.keys(
      createWebToolsPlugin({ include: ["fetch_text"] }).resources.tools ?? {},
    ),
    ["fetch_text"],
  );
  assertThrows(
    () => createWebToolsPlugin({ include: ["fetch_text", "fetch_text"] }),
    TypeError,
    "duplicate IDs",
  );
  assertThrows(
    () => createWebToolsPlugin({ include: ["missing" as "fetch_text"] }),
    TypeError,
    "Unknown Web tool",
  );
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
  const plugin = createWebToolsPlugin();
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
