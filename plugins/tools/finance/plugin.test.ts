import { assert, assertEquals, assertRejects } from "@std/assert";

import { createFinanceProviderRegistry } from "./provider/registry.ts";
import type { FinanceDataProvider } from "./provider/types.ts";
import type { WorkflowTool } from "@copilotz/copilotz/tools";
import { createFinanceToolsPlugin } from "./plugin.ts";

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
  const tools = plugin.resources.tools as
    | Readonly<Record<string, WorkflowTool>>
    | undefined;
  assertEquals(Object.keys(tools ?? {}), ["finance"]);
  const tool = tools?.finance as WorkflowTool;
  assert(Object.isFrozen(tool));
  assertEquals(
    await tool.execute({
      action: "search_assets",
      query: "contract",
      provider: "contract",
    }),
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
