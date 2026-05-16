---
title: "Ch 15: Assets"
description: "Move files, images, and binary data through the runtime without breaking the prompt."
section: Getting Started
order: 150
status: stable
---

# Chapter 15: Assets — Media Without Breaking the Prompt

> **Part 7 — Production Patterns**

## The pain

Your agent has a tool that generates charts. The tool returns an image — base64 encoded, naturally, because that's how you pass binary data in JSON. The base64 string for a modest 200KB PNG is about 270,000 characters. That goes straight into the tool result message, which goes into the conversation history, which gets passed to the LLM on every subsequent call.

Three problems immediately:
1. **Token explosion** — 270,000 characters is roughly 67,000 tokens. At $15/million tokens, that's $1 per image per call in history.
2. **API rejection** — Many LLM APIs have payload size limits. A large base64 string will trigger a 400 error.
3. **Context pollution** — Valuable context window space eaten by raw binary data.

The naive fix — strip base64 from history — means the agent can't refer back to images it generated. You need smart handling: store the image once, reference it cheaply, and rehydrate it when actually needed for a vision LLM call.

## The solution

Copilotz's asset system automatically intercepts base64 data in tool outputs, saves it to a configurable storage backend, and replaces it in history with a lightweight `asset://` reference URI. When an LLM call needs to send the image to a vision model, Copilotz rehydrates it as a data URL just for that call.

The rest of the history stays clean.

## Enabling the asset system

```typescript
import { createCopilotz } from "@copilotz/copilotz";

const copilotz = await createCopilotz({
  agents: [
    {
      id: "analyst",
      name: "Data Analyst",
      role: "Generates charts and analyzes images.",
      llmOptions: {
        provider: "openai",
        model: "gpt-4o",  // Vision-capable model
      },
      assetOptions: {
        resolveInLLM: true,  // Rehydrate asset:// refs before LLM calls
      },
    },
  ],
  assets: {
    config: {
      resolveInLLM: true,        // Global default: resolve for LLM calls
      deleteAfterProcessing: false,  // Keep assets after use
    },
    store: createFsAssetStore("./assets"),  // Store on local filesystem
  },
  security: {
    resolveLLMRuntimeConfig: async () => ({
      apiKey: Deno.env.get("OPENAI_API_KEY"),
    }),
  },
  dbConfig: { url: ":memory:" },
});
```

## Storage backends

### Local filesystem (development)

```typescript
import { createFsAssetStore } from "@copilotz/copilotz/server";

assets: {
  store: createFsAssetStore("./assets"),  // Stores in ./assets/ directory
}
```

### S3-compatible (production)

```typescript
import { createS3AssetStore } from "@copilotz/copilotz/server";

assets: {
  store: createS3AssetStore({
    bucket: "my-assets-bucket",
    region: "us-east-1",
    accessKeyId: Deno.env.get("AWS_ACCESS_KEY_ID"),
    secretAccessKey: Deno.env.get("AWS_SECRET_ACCESS_KEY"),
    // Works with any S3-compatible API: Cloudflare R2, Backblaze B2, MinIO
    endpoint: Deno.env.get("S3_ENDPOINT"),  // Optional: custom endpoint
  }),
}
```

### In-memory (testing only)

```typescript
assets: {
  store: createMemoryAssetStore(),  // Data lost on shutdown
}
```

## How interception works

When a tool returns data containing a base64 URL (e.g., `data:image/png;base64,iVBOR...`):

1. Copilotz detects it in the tool output
2. Decodes and saves the binary to the configured store
3. Generates an asset ID (ULID)
4. Replaces the base64 string in history with `asset://01ARZ3NDEKTSV4RRFFQ69G5FA`

The conversation history stays compact:

```json
// Before asset system:
{ "role": "tool", "content": "data:image/png;base64,iVBORw0KGgoAAAAN..." }  // 270,000 chars

// After asset system:
{ "role": "tool", "content": "asset://01ARZ3NDEKTSV4RRFFQ69G5FA" }  // 44 chars
```

## Rehydration for vision models

When `resolveInLLM: true` is set, Copilotz rewrites `asset://` references to proper data URLs before each LLM call:

```
[before LLM call]
"content": "asset://01ARZ3NDEKTSV4RRFFQ69G5FA"

[rehydrated for LLM]
"content": [{ "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }]
```

The LLM sees the real image. History stays clean.

## Sending assets from the user side

Users can also send asset references in messages:

```typescript
const result = await copilotz.run({
  content: [
    { type: "text", text: "What's wrong with this chart?" },
    { type: "image_url", image_url: { url: "asset://01ARZ3NDEKTSV4RRFFQ69G5FA" } },
  ],
  sender: { type: "user", name: "User" },
});
```

The asset reference is resolved before the LLM sees it. The user doesn't need to re-upload the image on every message.

## Accessing assets programmatically

```typescript
// Get as base64
const { base64, mime } = await copilotz.assets.getBase64("asset://01ARZ3N...");

// Get as data URL
const dataUrl = await copilotz.assets.getDataUrl("asset://01ARZ3N...");
// Returns: "data:image/png;base64,iVBORw0KGgo..."

// Get raw bytes
const bytes = await copilotz.assets.getBytes("asset://01ARZ3N...");
```

## What this unlocks

- Tool outputs containing images/files work without bloating the prompt
- Token costs stay predictable regardless of media in conversations
- Vision LLM calls receive properly formatted images
- Storage is configurable — local for dev, S3 for production, same API
- Asset references persist across sessions and can be shared

## What's next

The agent is now capable, smart, cost-efficient, and handles media correctly. But it still only runs in your terminal. Real users need to reach it — via a web chat, WhatsApp, Discord, or wherever they are. Time to ship it.

→ **[Chapter 16: Channels & The Server Facade](./16-channels-and-server.md))**
