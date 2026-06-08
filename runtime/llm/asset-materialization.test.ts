import {
  assert,
  assertEquals,
  assertExists,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

import { materializeAssetRefsForProvider } from "@/runtime/llm/asset-materialization.ts";
import { __resetModelCatalogCacheForTests } from "@/runtime/llm/model-catalog.ts";
import {
  buildAssetRefForStore,
  createMemoryAssetStore,
} from "@/runtime/storage/assets.ts";
import type { ChatMessage } from "@/runtime/llm/types.ts";

function mockCatalog(inputModalities: string[]) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{
            id: "openai/gpt-test",
            architecture: {
              input_modalities: inputModalities,
              output_modalities: ["text"],
            },
            pricing: { prompt: "0", completion: "0" },
          }, {
            id: "anthropic/claude-test",
            architecture: {
              input_modalities: inputModalities,
              output_modalities: ["text"],
            },
            pricing: { prompt: "0", completion: "0" },
          }, {
            id: "google/gemini-test",
            canonical_slug: "google/gemini-test",
            architecture: {
              input_modalities: inputModalities,
              output_modalities: ["text"],
            },
            pricing: { prompt: "0", completion: "0" },
          }],
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
  return () => {
    globalThis.fetch = originalFetch;
    __resetModelCatalogCacheForTests();
  };
}

Deno.test("materializeAssetRefsForProvider keeps ZIP attachments marker-only", async () => {
  const restore = mockCatalog(["text", "image", "file"]);
  const store = createMemoryAssetStore();
  const { assetId } = await store.save(
    new TextEncoder().encode("zip bytes"),
    "application/zip",
  );
  const ref = buildAssetRefForStore(store, assetId);
  const messages: ChatMessage[] = [{
    role: "user",
    content: [
      { type: "text", text: `[Attached file: asset_id="${assetId}"]` },
      {
        type: "file",
        file: {
          file_data: ref,
          mime_type: "application/zip",
        },
      },
    ],
  }];

  try {
    const result = await materializeAssetRefsForProvider(
      messages,
      { provider: "openai", model: "gpt-test" },
      store,
    );

    assert(Array.isArray(result[0].content));
    const parts = result[0].content;
    assertEquals(parts.some((part) => part.type === "file"), false);
    assertStringIncludes(
      parts.map((part) => part.type === "text" ? part.text : "").join("\n"),
      'reason="archive_tool_only"',
    );
  } finally {
    restore();
  }
});

Deno.test("materializeAssetRefsForProvider preserves Gemini PDF data URLs when catalog supports files", async () => {
  const restore = mockCatalog(["text", "file"]);
  const pdfDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";
  const messages: ChatMessage[] = [{
    role: "user",
    content: [
      { type: "text", text: "Summarize this PDF." },
      {
        type: "file",
        file: {
          file_data: pdfDataUrl,
          mime_type: "application/pdf",
        },
      },
    ],
  }];

  try {
    const result = await materializeAssetRefsForProvider(
      messages,
      { provider: "gemini", model: "gemini-test" },
    );

    assert(Array.isArray(result[0].content));
    const filePart = result[0].content.find((part) => part.type === "file");
    assertExists(filePart);
    assertEquals(filePart.type, "file");
    assertEquals(filePart.file.file_data, pdfDataUrl);
    assertEquals(filePart.file.mime_type, "application/pdf");
  } finally {
    restore();
  }
});

Deno.test("materializeAssetRefsForProvider resolves Gemini PDF refs when catalog supports files", async () => {
  const restore = mockCatalog(["text", "file"]);
  const store = createMemoryAssetStore();
  const { assetId } = await store.save(
    new TextEncoder().encode("%PDF-1.4\n"),
    "application/pdf",
  );
  const ref = buildAssetRefForStore(store, assetId);
  const messages: ChatMessage[] = [{
    role: "user",
    content: [
      { type: "text", text: `[Attached file: asset_id="${assetId}"]` },
      {
        type: "file",
        file: {
          file_data: ref,
          mime_type: "application/pdf",
        },
      },
    ],
  }];

  try {
    const result = await materializeAssetRefsForProvider(
      messages,
      { provider: "gemini", model: "gemini-test" },
      store,
    );

    assert(Array.isArray(result[0].content));
    const filePart = result[0].content.find((part) => part.type === "file");
    assertExists(filePart);
    assertEquals(filePart.type, "file");
    assertStringIncludes(
      filePart.file.file_data,
      "data:application/pdf;base64,",
    );
    assertEquals(filePart.file.mime_type, "application/pdf");
  } finally {
    restore();
  }
});

Deno.test("materializeAssetRefsForProvider preserves OpenAI PDFs for Responses mode", async () => {
  const restore = mockCatalog(["text", "file"]);
  const pdfDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";
  const messages: ChatMessage[] = [{
    role: "user",
    content: [
      { type: "text", text: "Summarize this PDF." },
      {
        type: "file",
        file: {
          file_data: pdfDataUrl,
          mime_type: "application/pdf",
        },
      },
    ],
  }];

  try {
    const result = await materializeAssetRefsForProvider(
      messages,
      {
        provider: "openai",
        model: "gpt-4o-mini",
        pricingModelId: "openai/gpt-test",
      },
    );

    assert(Array.isArray(result[0].content));
    const filePart = result[0].content.find((part) => part.type === "file");
    assertExists(filePart);
    assertEquals(filePart.type, "file");
    assertEquals(filePart.file.file_data, pdfDataUrl);
    assertEquals(filePart.file.mime_type, "application/pdf");
  } finally {
    restore();
  }
});

Deno.test("materializeAssetRefsForProvider omits OpenAI PDFs for Chat Completions mode", async () => {
  const restore = mockCatalog(["text", "file"]);
  const messages: ChatMessage[] = [{
    role: "user",
    content: [{
      type: "file",
      file: {
        file_data: "data:application/pdf;base64,JVBERi0xLjQK",
        mime_type: "application/pdf",
      },
    }],
  }];

  try {
    const result = await materializeAssetRefsForProvider(
      messages,
      {
        provider: "openai",
        model: "gpt-4o-mini",
        openaiApi: "chat_completions",
        pricingModelId: "openai/gpt-test",
      },
    );

    assert(Array.isArray(result[0].content));
    assertEquals(result[0].content.some((part) => part.type === "file"), false);
    assertStringIncludes(
      result[0].content.map((part) => part.type === "text" ? part.text : "")
        .join("\n"),
      'reason="unsupported_file_type"',
    );
  } finally {
    restore();
  }
});

Deno.test("materializeAssetRefsForProvider preserves Anthropic PDFs when catalog supports files", async () => {
  const restore = mockCatalog(["text", "file"]);
  const pdfDataUrl = "data:application/pdf;base64,JVBERi0xLjQK";
  const messages: ChatMessage[] = [{
    role: "user",
    content: [{
      type: "file",
      file: {
        file_data: pdfDataUrl,
        mime_type: "application/pdf",
      },
    }],
  }];

  try {
    const result = await materializeAssetRefsForProvider(
      messages,
      { provider: "anthropic", model: "claude-test" },
    );

    assert(Array.isArray(result[0].content));
    const filePart = result[0].content.find((part) => part.type === "file");
    assertExists(filePart);
    assertEquals(filePart.type, "file");
    assertEquals(filePart.file.file_data, pdfDataUrl);
    assertEquals(filePart.file.mime_type, "application/pdf");
  } finally {
    restore();
  }
});

Deno.test("materializeAssetRefsForProvider omits Gemini PDFs when catalog says text-only", async () => {
  const restore = mockCatalog(["text"]);
  const messages: ChatMessage[] = [{
    role: "user",
    content: [{
      type: "file",
      file: {
        file_data: "data:application/pdf;base64,JVBERi0xLjQK",
        mime_type: "application/pdf",
      },
    }],
  }];

  try {
    const result = await materializeAssetRefsForProvider(
      messages,
      { provider: "gemini", model: "gemini-test" },
    );

    assert(Array.isArray(result[0].content));
    assertEquals(result[0].content.some((part) => part.type === "file"), false);
    assertStringIncludes(
      result[0].content.map((part) => part.type === "text" ? part.text : "")
        .join("\n"),
      'reason="unsupported_file_type"',
    );
  } finally {
    restore();
  }
});

Deno.test("materializeAssetRefsForProvider resolves supported image refs to data URLs", async () => {
  const restore = mockCatalog(["text", "image"]);
  const store = createMemoryAssetStore();
  const { assetId } = await store.save(
    new Uint8Array([137, 80, 78, 71]),
    "image/png",
  );
  const ref = buildAssetRefForStore(store, assetId);
  const messages: ChatMessage[] = [{
    role: "user",
    content: [
      { type: "text", text: `[Attached image: asset_id="${assetId}"]` },
      { type: "image_url", image_url: { url: ref } },
    ],
  }];

  try {
    const result = await materializeAssetRefsForProvider(
      messages,
      { provider: "anthropic", model: "claude-test" },
      store,
    );

    assert(Array.isArray(result[0].content));
    const imagePart = result[0].content.find((part) =>
      part.type === "image_url"
    );
    assertExists(imagePart);
    assertEquals(imagePart?.type, "image_url");
    assertStringIncludes(imagePart.image_url.url, "data:image/png;base64,");
  } finally {
    restore();
  }
});

Deno.test("materializeAssetRefsForProvider omits images when catalog says text-only", async () => {
  const restore = mockCatalog(["text"]);
  const store = createMemoryAssetStore();
  const { assetId } = await store.save(
    new Uint8Array([137, 80, 78, 71]),
    "image/png",
  );
  const ref = buildAssetRefForStore(store, assetId);
  const messages: ChatMessage[] = [{
    role: "user",
    content: [
      { type: "text", text: `[Attached image: asset_id="${assetId}"]` },
      { type: "image_url", image_url: { url: ref } },
    ],
  }];

  try {
    const result = await materializeAssetRefsForProvider(
      messages,
      { provider: "openai", model: "gpt-test" },
      store,
    );

    assert(Array.isArray(result[0].content));
    assertEquals(
      result[0].content.some((part) => part.type === "image_url"),
      false,
    );
    assertStringIncludes(
      result[0].content.map((part) => part.type === "text" ? part.text : "")
        .join("\n"),
      'reason="unsupported_file_type"',
    );
  } finally {
    restore();
  }
});
