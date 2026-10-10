---
title: "Knowledge"
description: "Index documents into searchable chunks with an embedding provider the host chooses, and retrieve them with explicit scope selectors."
section: Agent Harness
order: 70
status: stable
---

# Knowledge

## The pain

Your assistant answers questions about a product handbook. Pasting the whole
handbook into every prompt is too expensive and soon too large. Conversation
memory doesn't help either: it curates what people said, not the documents your
team owns. You want to put a source in once, keep the original, and retrieve
only the few passages that match a question.

## The problem

Retrieval needs a contract for each step, not just a vector function:

- **Ingestion:** what may be a source, who loads it, and where the original
  bytes are kept.
- **Embeddings:** which provider turns text into vectors, with which model and
  dimensions, and what happens when those change.
- **Indexing:** how a document becomes chunks durably, and how a caller learns
  that indexing failed rather than assuming it succeeded.
- **Retrieval:** which stored documents a search considers, and which part of
  that selection the host, not the model, must decide.

Knowledge is a different layer from [Memory](memory.md):

| Layer     | Source of truth                           | Written by                       |
| --------- | ----------------------------------------- | -------------------------------- |
| Memory    | Certified ranges of conversation          | Consolidation turns of the agent |
| Knowledge | Documents you ingest (text, Assets, URLs) | Ingestion Actions and indexing   |

## The solution

The **Knowledge plugin**, `knowledgePlugin` from `@copilotz/copilotz/knowledge`,
contributes:

- Collections `document` and `chunk`. A document keeps its source as one stored
  content reference and a status (`pending`, `processing`, `indexed`,
  `duplicate`, `failed`); a chunk keeps its text, position and embedding array.
- A Processor that reacts to `document.created` and calls the durable indexing
  Action `copilotz.knowledge.indexDocument`.
- Three Tools that also install their Actions under the same aliases:
  `ingest_document`, `search_knowledge` and `delete_document`.

The host supplies what the plugin deliberately leaves open: an **embedding
provider** under `adapters.embedding`, and the **configuration** under
`resources.knowledge.config`. Threadless indexing and search run on the plain
runtime. Composing Core (`corePlugin`) adds threads: a document bound to an
existing thread then gets a status message posted there, and agents can be
granted the Tools.

External I/O happens only where the host puts it: in the embedding provider, in
the default URL loader during indexing, or in a loader you inject.

### Prerequisites

Deno 2.9+ or Node 24+, set up as in the [Quickstart](quickstart.md):

```sh
# Deno
deno add jsr:@copilotz/copilotz@^0.87.2
# Node: ES modules, Copilotz from JSR, and PGlite, the database the runtime opens.
npm init -y
npm pkg set type=module
npx jsr add @copilotz/copilotz@^0.87.2
npm i @electric-sql/pglite
```

The example uses an in-memory database, no credentials and no network.

### A complete, deterministic check

`knowledge-check.ts` ingests one text source, requires that it was indexed, then
searches. Its embedder is a **test fixture**: it maps one keyword to a fixed
vector so the result is predictable. It is not semantic search and says nothing
about retrieval quality.

```ts
// Runtime factory, Processor/Plugin helpers and the stream guard.
import {
  createCopilotz,
  definePlugin,
  defineProcessor,
  isStreamOutput,
  type ProcessorContext,
} from "@copilotz/copilotz";
// The Knowledge plugin, the provider helper, Action IDs and caller types.
import {
  defineKnowledgeEmbeddingProvider,
  INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID,
  type KnowledgeActionCallers,
  knowledgePlugin,
  SEARCH_KNOWLEDGE_ACTION_ID,
} from "@copilotz/copilotz/knowledge";

// TEST FIXTURE ONLY: keyword-chosen 2-D vectors. It meets the provider contract
// (one finite vector per text, a model name, fixed dimensions) but has no meaning.
const embeddingProvider = defineKnowledgeEmbeddingProvider({
  // Key that `resources.knowledge.config.embedding.provider` refers to.
  id: "fixture",
  type: "embedding",
  embed(input) {
    return Promise.resolve({
      embeddings: input.texts.map((text) =>
        /refund/i.test(text) ? [1, 0] : [0, 1]
      ),
      model: "fixture-keyword-v1",
      dimensions: 2,
    });
  },
});

// The Knowledge Action callers this Processor uses, as the third generic.
type CheckContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  KnowledgeActionCallers
>;

// Host-side driver: one request Event becomes one Knowledge Action call.
const knowledgeCheck = defineProcessor<CheckContext>({
  id: "kb-check.run",
  on: [{ eventType: "kb-check.requested" }],
  async handle(event, context) {
    // Act only on stored requests, so every call traces to a recorded Event.
    if (!event.durable) return;
    const data = event.data as { ingest?: string; query?: string };
    if (data.ingest) {
      // Exactly one of `source` or `assetId`. A `text:` source is stored as a
      // content Asset before this call returns; indexing follows as its own work.
      await context.actions.ingest_document(
        { source: `text:${data.ingest}`, title: "Refund policy" },
        { operationKey: "ingest-request" },
      );
    }
    if (data.query) {
      await context.actions.search_knowledge(
        { query: data.query, limit: 3 },
        { operationKey: "search-request" },
      );
    }
  },
});

const app = await createCopilotz({
  namespace: "kb-check",
  database: { url: ":memory:" },
  plugins: [
    knowledgePlugin,
    definePlugin({
      id: "kb-check",
      version: "1.0.0",
      processors: { knowledgeCheck },
    }),
  ],
  resources: {
    knowledge: {
      config: {
        // Adapter key, model passed to it, and the required vector length.
        embedding: {
          provider: "fixture",
          model: "fixture-keyword-v1",
          dimensions: 2,
        },
        // Chunk size and overlap are estimated tokens, not characters.
        chunking: { strategy: "paragraph", chunkSize: 512, chunkOverlap: 0 },
      },
    },
  },
  // Embedding providers, keyed by the `provider` value above.
  adapters: { embedding: { [embeddingProvider.id]: embeddingProvider } },
});

// Sends one request and reports its Knowledge outcome. Indexing failures are
// recorded as Events and do not reject `done`, so they are checked here.
async function run(
  payload: { ingest?: string; query?: string },
  expectIndexed: boolean,
) {
  const handle = await app.send({ type: "kb-check.requested", payload });
  let indexed = false;
  let failure: string | undefined;
  const read = (async () => {
    for await (const output of handle.outputs) {
      // This check opens no byte streams; release any that appear.
      if (isStreamOutput(output)) {
        await output.payload.cancel();
        continue;
      }
      if (!output.durable) continue;
      if (output.type === "document.indexed") indexed = true;
      if (output.type === "document.duplicate") {
        failure = "source already indexed as another document";
      }
      if (
        output.type === "document.failed" ||
        output.type === `${INDEX_KNOWLEDGE_DOCUMENT_ACTION_ID}.failed`
      ) failure = "indexing failed; inspect the document's error";
      if (output.type === `${SEARCH_KNOWLEDGE_ACTION_ID}.completed`) {
        console.log(
          JSON.stringify((output.data as { output: unknown }).output),
        );
      }
    }
  })();
  const [reader, done] = await Promise.allSettled([read, handle.done]);
  if (done.status === "rejected") throw done.reason;
  if (reader.status === "rejected") throw reader.reason;
  if (failure) throw new Error(failure);
  if (expectIndexed && !indexed) throw new Error("document was not indexed");
  if (expectIndexed) console.log("indexed");
}

try {
  await run({ ingest: "Refunds are issued within 14 days of purchase." }, true);
  await run({ query: "How do refunds work?" }, false);
} finally {
  await app.close();
}
```

Run it with `deno run -A knowledge-check.ts` or `node knowledge-check.ts`.

### Check it works

The program prints `indexed`, then one search result whose `content` is the
refund sentence, with `score` `1`, `source` `Refund policy` and the new
`documentId`. If indexing fails or the source is a duplicate, it exits with an
error instead of searching. A query without "refund" embeds to `[0, 1]`, falls
below the default threshold and returns empty `results` with a `message`. That
only shows the fixture's wiring, not search quality.

### Switch to a real provider in the host

Once the fixture check passes, the host can choose a real provider. This example
uses the
[OpenAI embeddings API](https://developers.openai.com/api/reference/resources/embeddings/methods/create).
A provider reads a credential and performs network I/O, so it lives in a host
module that pure definitions and tests never import. Create
`openai-embedding.ts`:

```ts
// Host-owned: the credential is checked when this module is imported.
import { defineKnowledgeEmbeddingProvider } from "@copilotz/copilotz/knowledge";
import { env } from "node:process";

const apiKey = env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY before starting the host.");

// Calls the OpenAI embeddings endpoint for each batch of chunk or query texts.
export const openAiEmbedder = defineKnowledgeEmbeddingProvider({
  id: "openai",
  type: "embedding",
  async embed({ texts, model, dimensions, signal }) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      // Cancellation of the running Action reaches the provider call.
      signal,
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model,
        dimensions,
        encoding_format: "float",
      }),
    });
    if (!response.ok) throw new Error(`Embeddings HTTP ${response.status}`);
    const body = await response.json() as {
      data: { embedding: number[] }[];
      model: string;
      usage?: { prompt_tokens: number; total_tokens: number };
    };
    return {
      embeddings: body.data.map((item) => item.embedding),
      model: body.model,
      dimensions: body.data[0]?.embedding.length ?? 0,
      ...(body.usage
        ? {
          usage: {
            promptTokens: body.usage.prompt_tokens,
            totalTokens: body.usage.total_tokens,
          },
        }
        : {}),
    };
  },
});
```

Then make two edits in `knowledge-check.ts`:

1. **Replace** the entire fixture `const embeddingProvider = ...` declaration
   with
   `import { openAiEmbedder as embeddingProvider } from "./openai-embedding.ts";`.
2. **Replace** the `embedding` value in `resources.knowledge.config` with
   `{ provider: "openai", model: "text-embedding-3-small", dimensions: 1536 }`.
   The adapter map already uses `embeddingProvider.id`, so its key follows the
   provider.

With a real model, the fixture's exact `score` no longer applies, and each run
makes billed provider calls. Every call receives an `idempotencyKey`; forward it
if your provider's API accepts one.

### Grant retrieval to an agent

With Core composed, installing the plugin still grants nothing. Add the alias to
the agent's `capabilities.tools`, for example `tools: ["search_knowledge"]`.
Grant `ingest_document` or `delete_document` only to agents that should change
the knowledge base.

## Reference

**Configuration** (`resources.knowledge.config`):

| Field                   | Default  | Meaning                                     |
| ----------------------- | -------- | ------------------------------------------- |
| `embedding.provider`    | required | Key in `adapters.embedding`                 |
| `embedding.model`       | none     | Passed to the provider                      |
| `embedding.dimensions`  | response | Every vector must have exactly this length  |
| `embedding.batchSize`   | 100      | Chunks per provider call while indexing     |
| `chunking.strategy`     | `fixed`  | `fixed`, `paragraph` or `sentence`          |
| `chunking.chunkSize`    | 512      | Estimated tokens per chunk                  |
| `chunking.chunkOverlap` | 50       | Estimated tokens; must be below `chunkSize` |

**Sources.** `ingest_document` takes exactly one of `source` or `assetId`.
`text:…` and Asset sources are stored as content with the document. `http(s)`
URLs are fetched during indexing by the default loader. It rejects responses
whose declared length exceeds 10 MiB and checks the size again after reading, so
a response without a length is read fully before that check. It applies no URL
allow-list: the host decides which URLs callers may submit, or injects its own
`adapters.knowledge.loader`. Local file paths always need an injected loader.
The default extractor handles text, HTML, Markdown and DOCX; Markdown extraction
drops code blocks and inline code. Other formats need
`adapters.knowledge.extractor`.

**Duplicates and re-ingestion.**

- Indexing hashes the loaded bytes. If an indexed document in the namespace
  already has that hash, the new one becomes `duplicate` with
  `duplicateOfDocumentId` and **no chunks**, whatever its thread or scope. It is
  not merged into the original, and searches limited to the duplicate's ID find
  nothing.
- `forceReindex: true` skips that check and indexes a new document; it does not
  update the earlier one.
- Reusing an `externalId` rejects the ingestion.

**Lifecycle Events.** `document.created`, `document.processing`, then
`document.indexed`, `document.duplicate` or `document.failed` (with the
document's `error`), plus `chunk.created`. The indexing Action also records
`copilotz.knowledge.indexDocument.failed` on failure. The indexing Processor
treats a settled Action failure as handled, so the operation can complete while
the document has failed: check these Events or the document's `status`.

**Search.** `search_knowledge` takes `query`, optional `scope`, `limit` (default
5, at most 20) and `threshold` (cosine similarity, default 0.5). It returns
`content`, `score`, `source`, `documentId` and `chunkIndex`; `totalResults` is
the number returned, not the number of matches.

**Performance.** Embeddings are plain arrays on chunk records. Each search
embeds the query, lists every chunk in the namespace, loads their documents, and
computes cosine similarity in JavaScript before sorting. No pgvector, vector
index or provisioning is involved, and `limit` bounds only the returned chunks,
not the work. Cost grows with the namespace's chunk count, so split large
corpora across namespaces or use a dedicated vector store behind your own
Action.

**Changing the embedding model.** Dimensions are validated, but the model name
is not stored per corpus: vectors of a different length never match, while a new
model with the same dimensions is silently compared with old vectors. There is
no automatic migration. Re-ingest the corpus deliberately with
`forceReindex: true` under the new configuration, and delete the old documents
once the new ones are indexed.

**Scope selectors.** The namespace bounds every read. Within it, `scope` and
document metadata narrow results; they are **filters, not membership
authorization**:

- When an Action runs with trusted thread or agent metadata (as Core supplies
  for agent Tool calls), that metadata overrides any `threadId` or `agentId` in
  the caller's `scope`, and is stamped on newly ingested documents.
- A document bound to a thread matches only that thread. A document restricted
  to agents matches only those agents. A document tagged with knowledge spaces
  matches only when `scope.knowledgeSpaceIds` names one of them.
- Documents without such restrictions remain eligible unless an explicit
  non-empty `documentIds` selection excludes them.
- Empty `documentIds` or `knowledgeSpaceIds` arrays count as absent; they do not
  deny everything.
- `delete_document` applies the same matching; it removes the document and its
  chunks, and keeps a content Asset other documents still use.
- Direct Collection reads of `document` and `chunk` retain namespace isolation
  but do not apply these Knowledge scope filters.

Which spaces or documents a user may reach is the host's decision: authorize the
caller, then inject the allowed selection rather than trusting model input.

**Exports.** `knowledgePlugin`, `defineKnowledgeEmbeddingProvider`,
`createDefaultKnowledgeSourceLoader`, `createDefaultKnowledgeTextExtractor`, the
Tools `ingestKnowledgeDocumentTool`, `searchKnowledgeTool`,
`deleteKnowledgeDocumentTool`, their Actions and `*_ACTION_ID` constants,
`KnowledgeActionCallers`, and the record types `KnowledgeDocument` and
`KnowledgeChunk`. To rename or omit Tools, compose your own plugin from these
Tool definitions under the aliases you want.

## What this unlocks

- Answers grounded in your documents without carrying them in every prompt.
- One stored original per source, with duplicates detected by content hash.
- Indexing outcomes you can observe and act on, including failures.
- A provider choice that stays in the host, with deterministic fixtures for
  checks.

## Next steps

- [Agent capabilities](agent-capabilities.md) for Tool grants.
- [Memory](memory.md) for curated conversation facts.
- [Spaces](spaces.md) for owned content and attachment rules.
- [Testing and inspection](testing-and-inspection.md) for scripted checks.
