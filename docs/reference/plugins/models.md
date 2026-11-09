---
title: "models"
description: "Models: talking to models, one way for every kind."
---

<!-- Made by scripts/describe.ts from the plugin itself: run it again rather than edit this page. -->

# models

Models: talking to models, one way for every kind.

```ts
import { models } from "copilotz/plugins/models";
```

## What it keeps

It keeps 1 collection.

| Collection | Kept as   | Fields                                        |
| ---------- | --------- | --------------------------------------------- |
| `image`    | documents | `type`, `size`, `data`, `model`, `tags`, `at` |

## What it lets callers do

Of its 10 Actions, people may call 1; agents, contacts and someone signed out may call none.

| Action           | Person | Agent | Contact | Anyone | Key | What it does                                    |
| ---------------- | ------ | ----- | ------- | ------ | --- | ----------------------------------------------- |
| `models.offered` | yes    | no    | no      | no     | yes | The providers and models an agent can be given. |

A key calls what its person may, when its scope names the Action.

Only the app's own code calls `embeddings.embed`, `image.generate`, `llm.generate`, `llm.stream`,
`models.check`, `models.efforts`, `models.keyable`, `models.price` and `transcription.transcribe`:
its plugins, its schedules and the system.

Other plugins call it through its adapters: `embeddings` (`hash`, `openai`, `openai-compatible`),
`image` (`fake`, `gemini`, `openai`), `llm` (`anthropic`, `fake`, `gemini`, `openai`,
`openai-compatible`), `transcription` (`fake`, `openai`, `openai-compatible`).

## Where it shows

It has no Views: it shows nowhere on its own.

- **What it adds to resources:** `provider` (`fake`, `hash`).

## What it needs

Nothing to set. It reads `model`, `modelKeys`, `modelUse`, `provider`, `spending` and `usage`,
resource kinds the app and other plugins fill.

## What it requires

It builds on no other plugin.

It ships with `copilotz@1.0.0-rc.31`.

## Listing

It keeps every listing rule.
