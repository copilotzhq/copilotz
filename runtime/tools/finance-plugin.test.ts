import { assert, assertEquals, assertRejects } from "@std/assert";

import { createFinanceProviderRegistry } from "./finance/provider/registry.ts";
import type { FinanceDataProvider } from "./finance/provider/types.ts";
import type { WorkflowTool } from "../workflows/index.ts";
import { createFinanceToolsPlugin } from "./finance-plugin.ts";

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
  assertEquals(plugin.manifest.provides.tools, ["finance"]);
  const tool = plugin.resources.tools?.[0] as WorkflowTool;
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
      "finance/index.ts",
      "finance/provider/registry.ts",
      "finance/provider/yahoo.ts",
      "finance-plugin.ts",
    ]
  ) {
    const source = await Deno.readTextFile(new URL(module, import.meta.url));
    assert(!/^\s*(?:export\s+)?class\s/m.test(source), module);
    assert(!/new\s+YahooProvider\b/.test(source), module);
    assert(!/\bDeno\./.test(source), module);
    assert(!/from\s+["']node:/.test(source), module);
  }
});
