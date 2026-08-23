import { assert, assertEquals, assertRejects } from "@std/assert";

import { createFinanceProviderRegistry } from "./provider/registry.ts";
import type { FinanceDataProvider } from "./provider/types.ts";
import { createFinanceToolsPlugin } from "./plugin.ts";
import type { ActionContext } from "@copilotz/copilotz/actions";
import type { ToolResource } from "../contracts.ts";

function provider(): FinanceDataProvider {
  const searchAssets: FinanceDataProvider["searchAssets"] = async (
    input,
    signal,
  ) => {
    return {
      query: input.query,
      total_results: 1,
      returned: 1,
      results: [{ symbol: "TEST" }],
      signalWasActive: !signal?.aborted,
    } as never;
  };
  return { searchAssets } as unknown as FinanceDataProvider;
}

Deno.test("finance provider registry and tool are factory-created resources", async () => {
  const registry = createFinanceProviderRegistry({ contract: provider() });
  const plugin = createFinanceToolsPlugin({ getProvider: registry.get });
  const tools = plugin.resources.tools;
  assertEquals(Object.keys(tools ?? {}), ["finance"]);
  const tool = tools?.finance as ToolResource;
  assert(Object.isFrozen(tool));
  assertEquals(tool?.action, "finance");
  assert(!("execute" in (tool ?? {})));
  assertEquals(
    await plugin.actions.finance.execute({
      action: "search_assets",
      query: "contract",
      provider: "contract",
    }, {
      signal: new AbortController().signal,
    } as ActionContext),
    {
      query: "contract",
      total_results: 1,
      returned: 1,
      results: [{ symbol: "TEST" }],
      signalWasActive: true,
    },
  );
  await assertRejects(
    async () => registry.get("missing"),
    Error,
    "Provider 'missing' is not supported",
  );
});

Deno.test("finance preserves provider cancellation as AbortError", async () => {
  const controller = new AbortController();
  const cancelling = provider();
  cancelling.searchAssets = (_input, signal) =>
    new Promise((_resolve, reject) => {
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("cancelled", "AbortError")),
        { once: true },
      );
    });
  const plugin = createFinanceToolsPlugin({
    getProvider: () => cancelling,
  });
  const execution = plugin.actions.finance.execute({
    action: "search_assets",
    query: "cancel",
  }, { signal: controller.signal } as ActionContext);
  controller.abort();
  const error = await assertRejects(async () => await execution);
  assertEquals((error as Error).name, "AbortError");
});

Deno.test("finance rejects non-JSON provider results", async () => {
  let result: unknown = null;
  const unsafe = {
    searchAssets: () => Promise.resolve(result),
  } as unknown as FinanceDataProvider;
  const plugin = createFinanceToolsPlugin({ getProvider: () => unsafe });
  const input = { action: "search_assets", query: "unsafe" };
  const context = { signal: new AbortController().signal } as ActionContext;
  const inherited = Object.assign(Object.create({ inherited: true }), {
    own: true,
  });
  for (
    const candidate of [
      new Uint8Array([1, 2, 3]),
      inherited,
      { value: Number.NaN },
    ]
  ) {
    result = candidate;
    await assertRejects(
      async () => await plugin.actions.finance.execute(input, context),
      Error,
    );
  }
});

Deno.test("finance implementation keeps providers behind factories", async () => {
  for (
    const module of [
      "index.ts",
      "provider/registry.ts",
      "provider/yahoo.ts",
      "plugin.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/^\s*(?:export\s+)?class\s/m.test(source), module);
    assert(!/new\s+YahooProvider\b/.test(source), module);
    assert(!/\bDeno\./.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
  }
});
