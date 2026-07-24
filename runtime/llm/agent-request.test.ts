import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "@std/assert";

import { prepareAgentChatRequest } from "@/runtime/llm/agent-request.ts";
import { __resetModelCatalogCacheForTests } from "@/runtime/llm/model-catalog.ts";
import type { ChatMessage, ToolDefinition } from "@/runtime/llm/types.ts";
import {
  buildAssetRefForStore,
  createMemoryAssetStore,
} from "@/runtime/storage/assets.ts";

Deno.test("prepareAgentChatRequest shares tools and materializes assets per provider", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{
            id: "openai/gpt-test",
            architecture: {
              input_modalities: ["text", "file"],
              output_modalities: ["text"],
            },
            pricing: { prompt: "0", completion: "0" },
          }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  const store = createMemoryAssetStore();
  const pdf = await store.save(
    new TextEncoder().encode("%PDF-1.4\n"),
    "application/pdf",
  );
  const zip = await store.save(
    new Uint8Array([80, 75, 3, 4]),
    "application/zip",
  );
  const tools: ToolDefinition[] = [{
    type: "function",
    function: {
      name: "inspect_file",
      description: "Inspect a file.",
      inputTypes: "type Input = { assetId: string }",
    },
  }];
  const messages: ChatMessage[] = [{
    role: "user",
    content: [{
      type: "file",
      file: {
        file_data: buildAssetRefForStore(store, pdf.assetId),
        mime_type: "application/pdf",
        filename: "report.pdf",
      },
    }, {
      type: "file",
      file: {
        file_data: buildAssetRefForStore(store, zip.assetId),
        mime_type: "application/zip",
        filename: "archive.zip",
      },
    }],
  }];

  try {
    const prepared = prepareAgentChatRequest({
      messages,
      tools,
      assetStore: store,
    });
    assertEquals(prepared.request.messages, messages);
    assertEquals(prepared.request.tools, tools);
    assertExists(prepared.request.materializeMessages);

    const materialized = await prepared.request.materializeMessages(
      messages,
      {
        provider: "openai",
        model: "gpt-4o-mini",
        pricingModelId: "openai/gpt-test",
      },
    );
    const content = materialized[0]?.content;
    assert(Array.isArray(content));
    const file = content.find((part) => part.type === "file");
    assertEquals(
      file?.type === "file" ? file.file.filename : undefined,
      "report.pdf",
    );
    assertEquals(
      content.filter((part) => part.type === "file").length,
      1,
    );
    assertStringIncludes(
      content.map((part) => part.type === "text" ? part.text : "").join("\n"),
      'reason="archive_tool_only"',
    );
  } finally {
    globalThis.fetch = originalFetch;
    __resetModelCatalogCacheForTests();
  }
});

Deno.test("prepareAgentChatRequest uses text-only messages when asset resolution is disabled", () => {
  const prepared = prepareAgentChatRequest({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "Keep this marker." },
        {
          type: "file",
          file: {
            file_data: "asset://tenant/file",
            filename: "file.zip",
          },
        },
      ],
    }],
    tools: [],
    assetConfig: { resolveInLLM: false },
  });

  assertEquals(prepared.resolvesAssets, false);
  assertEquals(prepared.request.messages[0]?.content, "Keep this marker.");
  assertEquals(prepared.request.materializeMessages, undefined);
});
