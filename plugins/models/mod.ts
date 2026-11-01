/**
 * Models: talking to models, one way for every kind. `llm` (text and tools),
 * `embeddings` (text to vectors) and `transcription` (speech to text) all
 * name a model as `"provider/model"` with the settings to call it with,
 * declare each provider once as a `provider` resource, and let the
 * models.dev catalog fill in what it leaves out (see `shared/choice.ts`).
 *
 * - **llm:** settings `effort`, `maxTokens`, `temperature`, `options`. Other
 *   plugins call it by name: `llm.stream` (chunks as they come, from a job)
 *   or `llm.generate` (the whole answer). Adapters by protocol: `openai`
 *   (Responses), `openai-compatible` (Chat Completions: DeepSeek, Groq,
 *   OpenRouter, Ollama…), `anthropic`, `gemini`, and `fake` for offline runs
 *   (`"fake/echo"`).
 * - **embeddings:** settings `dimensions`, `options`. `embeddings.embed`, from
 *   jobs, queries and Views. Adapters: `openai`, `openai-compatible`, and
 *   `hash` (offline, word overlap only: `"hash/words"`).
 * - **transcription:** settings `options` (extra form fields).
 *   `transcription.transcribe` (audio as base64). Adapters: `openai`,
 *   `openai-compatible`.
 *
 * Other plugins' startup checks ask `models.check` about the models they're
 * configured with; the usage ledger asks `models.price` what the catalog says
 * a model costs. `models.offered` lists what an agent can be given.
 *
 * Where another plugin keeps orgs' own keys (the `modelKeys` resource), any
 * provider in the catalog with an address of its own and a protocol we speak
 * can be chosen, and an org's key for a provider goes on its calls, over the
 * app's (`shared/choice.ts`). Those uses are tagged `paid: "own-key"`.
 *
 * A list of models is tried in order. Any plugin adds adapters of its own
 * under `adapters.llm`, `adapters.embeddings` or `adapters.transcription`.
 *
 * After every call, whoever plugs into the `modelUse` resource hears what it
 * used, in the job that made it (the usage ledger records it, rated).
 */
import { definePlugin, type Plugin } from "../../runtime/mod.ts";
import { check } from "./actions/check.ts";
import { embed } from "./actions/embed.ts";
import { generate } from "./actions/generate.ts";
import { keyableAction, offered } from "./actions/offered.ts";
import { price } from "./actions/price.ts";
import { stream } from "./actions/stream.ts";
import { transcribe } from "./actions/transcribe.ts";
import { hashEmbeddings } from "./adapters/embeddings/hash.ts";
import { openai as openaiEmbeddings } from "./adapters/embeddings/openai.ts";
import { anthropic } from "./adapters/llm/anthropic.ts";
import { fake } from "./adapters/llm/fake.ts";
import { gemini } from "./adapters/llm/gemini.ts";
import { openaiCompletions } from "./adapters/llm/openai-compatible.ts";
import { openaiResponses } from "./adapters/llm/openai.ts";
import { fake as fakeTranscription } from "./adapters/transcription/fake.ts";
import { openai as openaiTranscription } from "./adapters/transcription/openai.ts";
import { providers } from "./resources/providers.ts";

export * from "./contract.ts";
export type { EmbeddingsAdapter } from "./shared/embed.ts";
export type { Endpoint, Usage } from "./shared/provider.ts";
export { EFFORTS } from "./shared/types.ts";
/** The offline model (`"fake/echo"`), with a delay of its own for demos. */
export { fake };

export const models: Plugin = definePlugin({
  name: "models",
  actions: {
    "llm.generate": generate,
    "llm.stream": stream,
    "embeddings.embed": embed,
    "transcription.transcribe": transcribe,
    "models.check": check,
    "models.price": price,
    "models.offered": offered,
    "models.keyable": keyableAction,
  },
  resources: { provider: providers },
  adapters: {
    llm: {
      openai: openaiResponses,
      "openai-compatible": openaiCompletions,
      anthropic,
      gemini,
      fake: fake(),
    },
    embeddings: {
      openai: openaiEmbeddings,
      "openai-compatible": openaiEmbeddings,
      hash: hashEmbeddings,
    },
    transcription: {
      openai: openaiTranscription,
      "openai-compatible": openaiTranscription,
      fake: fakeTranscription,
    },
  },
});

export default models;
