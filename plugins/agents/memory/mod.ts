/**
 * Memory: what agents know across conversations.
 *
 * - A memory is one self-contained statement about someone or something: a
 *   person ("Ana prefers venues with a garden"), the agent itself, one
 *   thread, or everyone. Memories are documents with a vector field, so
 *   recall is semantic when there is an embedder, and always matches words.
 * - Agents have, in their stable system text, the core memories about
 *   whoever is in the conversation; after the conversation, each turn, the
 *   other memories most relevant to the latest message.
 * - Agents remember, recall and forget with tools offered to all of them.
 *   Remembering what they already know updates it instead of repeating it.
 *   With spaces (the access plugin), a memory lives where it was learned:
 *   recall searches where the conversation is, or another space it names
 *   (`in`), and what it brings from there marks the answer.
 * - With an extractor model (`memoryExtraction`, beside it), memories also
 *   arrive on their own: every few messages, it reads them and writes down
 *   what's worth keeping.
 *
 * Settings are the `memory` resource, which an app patches:
 *
 * ```ts
 * resources: { memory: { embedder: "openai/text-embedding-3-small", extractor: "openai/gpt-5.4-mini" } }
 * ```
 *
 * Works with the chat plugin: it reads `message` and adds `context` entries
 * and tools that chat gives its agents.
 */
import { defineAction, definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { memoryCollection } from "./collections/memory.ts";
import { memoryProgress } from "./collections/progress.ts";
import { extractor } from "./processors/extract.ts";
import { contexts } from "./resources/context.ts";
import { tools } from "./resources/tools.ts";
import { settingsOf } from "./shared/settings.ts";
import { contextViews } from "./views/context.ts";
import { memoryView } from "./views/memory.ts";

export type { Memory } from "./collections/memory.ts";
export type { MemorySettings } from "./shared/settings.ts";

export const memory: Plugin = definePlugin({
  name: "memory",
  requires: ["chat"],
  collections: { memory: memoryCollection, memoryProgress },
  views: { memory: { llm: memoryView }, ...contextViews },
  actions: {
    // Moved as the person: they must reach it, and may write where it goes (the spaces' rules).
    "memory.move": defineAction({
      description: "Moves a memory to another space",
      input: {
        type: "object",
        properties: { memory: { type: "string" }, to: { type: "string" } },
        required: ["memory", "to"],
        additionalProperties: false,
      },
      allow: (actor) => actor.kind === "person",
      run: async (ctx, input) => {
        const { matchedCount } = await ctx.db.collection("memory").updateOne(
          { _id: input.memory },
          { $set: { in: input.to } },
        );
        return { moved: matchedCount > 0 };
      },
    }),
  },
  resources: { memory: { every: 8 }, context: contexts, tools },
  async check(merged) {
    const { embedder } = settingsOf(merged);
    if (embedder) await merged.call("models.check", { model: embedder, port: "embeddings" });
  },
});

/** Memories that arrive on their own: the extractor model reads every few messages. */
export const memoryExtraction: Plugin = definePlugin({
  name: "memory-extraction",
  requires: ["memory", "models"],
  processors: { "memory.extract": extractor },
  async check(merged) {
    const { extractor } = settingsOf(merged);
    if (!extractor) throw new Error("memory-extraction: set the memory resource's extractor model");
    await merged.call("models.check", { model: extractor, port: "llm" });
  },
});

export default memory;
