/** Tests the Finance Action's provider boundary and durable result contract. @module */

import { assertEquals, assertRejects } from "@std/assert";
import type { ActionContext } from "@copilotz/copilotz/actions";
import { createFinanceAction } from "./index.ts";
import { createFinanceProviderRegistry } from "./internal/provider/registry.ts";
import type { FinanceDataProvider } from "./internal/provider/types.ts";

function provider(): FinanceDataProvider {
  const searchAssets: FinanceDataProvider["searchAssets"] = async (
    input,
    signal,
  ) => ({
    query: input.query,
    total_results: 1,
    returned: 1,
    results: [{ symbol: "TEST" }],
    signalWasActive: !signal?.aborted,
  });
  return {
    searchAssets,
  } as unknown as FinanceDataProvider;
}

Deno.test("Finance Action runs a registered provider and keeps its JSON result", async () => {
  const registry = createFinanceProviderRegistry({ contract: provider() });
  const action = createFinanceAction({ getProvider: registry.get });
  assertEquals(
    await action.execute({
      action: "search_assets",
      query: "contract",
      provider: "contract",
    }, { signal: new AbortController().signal } as ActionContext),
    {
      query: "contract",
      total_results: 1,
      returned: 1,
      results: [{ symbol: "TEST" }],
      signalWasActive: true,
    },
  );
  await assertRejects(async () => registry.get("missing"), Error);
});

Deno.test("Finance Action preserves cancellation and rejects unsafe results", async () => {
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
  const action = createFinanceAction({ getProvider: () => cancelling });
  const execution = action.execute(
    { action: "search_assets", query: "cancel" },
    { signal: controller.signal } as ActionContext,
  );
  controller.abort();
  assertEquals(
    (await assertRejects(() => Promise.resolve(execution)) as Error).name,
    "AbortError",
  );

  const unsafe = {
    searchAssets: () => Promise.resolve(new Uint8Array([1])),
  } as unknown as FinanceDataProvider;
  await assertRejects(
    () =>
      Promise.resolve(
        createFinanceAction({ getProvider: () => unsafe }).execute(
          { action: "search_assets", query: "unsafe" },
          { signal: new AbortController().signal } as ActionContext,
        ),
      ),
    Error,
  );
});
