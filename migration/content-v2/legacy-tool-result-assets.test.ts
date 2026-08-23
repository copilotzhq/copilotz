import { assertEquals, assertRejects } from "@std/assert";
import { createContentPreparer } from "@copilotz/copilotz/content";
import {
  extractToolResultAssets,
  type ToolResultAssetError,
} from "./legacy-tool-result-assets.ts";

function fixture() {
  let id = 0;
  const preparer = createContentPreparer({ createId: () => `asset-${++id}` });
  return (value: unknown, limits = {}) =>
    extractToolResultAssets(value, {
      namespace: "tenant-a",
      threadId: "thread-a",
      toolExecutionId: "tool-a",
      prepare: (input, options) =>
        preparer.prepare(input, {
          namespace: "tenant-a",
          idempotencyKey: options.operationKey,
        }),
      ...limits,
    });
}

Deno.test("tool result extraction replaces nested data URLs, preserves metadata, and deduplicates bodies", async () => {
  const extract = fixture();
  const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
  const result = await extract({
    imageUrl: dataUrl,
    nested: [{ dataUrl, name: "screen.png", page: 3 }],
    encoded: {
      mimeType: "text/plain",
      dataBase64: "aGVsbG8=",
      label: "stdout",
    },
  });
  assertEquals(result.attachments?.assets.length, 2);
  assertEquals(result.output, {
    imageUrl: {
      assetRef: "asset://tenant-a/asset-1",
      kind: "image",
      mediaType: "image/png",
      byteLength: 8,
    },
    nested: [{
      page: 3,
      assetRef: "asset://tenant-a/asset-1",
      kind: "image",
      mediaType: "image/png",
      byteLength: 8,
      name: "screen.png",
    }],
    encoded: {
      label: "stdout",
      assetRef: "asset://tenant-a/asset-2",
      kind: "text",
      mediaType: "text/plain",
      byteLength: 5,
    },
  });
  assertEquals(result.attachments?.assets[0].origin, {
    scope: { type: "thread", id: "thread-a" },
    producer: { type: "tool_action", id: "tool-a" },
    path: "/imageUrl",
  });
  assertEquals(JSON.stringify(result.output).includes("base64"), false);
});

Deno.test("tool result extraction rejects malformed data, cycles, and configured limits", async () => {
  const extract = fixture();
  for (
    const value of ["data:image/png;base64,***", { dataUrl: "data:broken" }]
  ) {
    const failure = await assertRejects(() => extract(value));
    assertEquals(
      (failure as ToolResultAssetError).code,
      "tool_result_asset_invalid",
    );
  }
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const cycle = await assertRejects(() => extract(cyclic));
  assertEquals((cycle as ToolResultAssetError).code, "tool_result_asset_cycle");
  const limited = await assertRejects(() =>
    extract([
      "data:text/plain;base64,YQ==",
      "data:text/plain;base64,Yg==",
    ], { maxAssets: 1 })
  );
  assertEquals(
    (limited as ToolResultAssetError).code,
    "tool_result_asset_limit",
  );
});
