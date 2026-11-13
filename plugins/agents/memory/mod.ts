/**
 * Memory: what agents know across conversations.
 *
 * - A memory is one self-contained statement about someone or something: a
 *   person ("Ana prefers venues with a garden"), the agent itself, one
 *   thread, or everyone. Memories are documents with a vector field, so
 *   recall is semantic when there is an embedder, and always matches words.
 * - Agents have how to use memory in their stable system text, as Copilotz's
 *   own instructions: look (recall, and back through the conversation)
 *   before saying they don't know or don't have something. As a conversation
 *   begins, they're told the core memories about whoever is in it (the person
 *   they work for too, there or not: a chat one agent handed another); after
 *   that, each turn, the other memories most relevant to what it's about (the
 *   latest message, the two before it, its title), each saying when and where
 *   it was learned.
 * - Agents remember, recall and forget with tools offered to all of them.
 *   Remembering what they already know updates it instead of repeating it.
 *   With spaces (the access plugin), a memory lives where it was learned:
 *   recall searches where the conversation is (in its person's own Personal
 *   space, which only they see, everywhere they can read), or another space
 *   it names (`in`), within what the conversation may draw on. Recall
 *   also opens where a memory was learned (`source`).
 * - With an extractor model (`memoryExtraction`, beside it), memories also
 *   arrive on their own: every few messages, and once a conversation has been
 *   quiet a while, it reads what was said since and writes down what's worth
 *   keeping.
 * - Memories move in from another app as they were (`memory.import`, the
 *   system's): in a space, with whom each is about, who wrote it and when.
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
import {
  defineAction,
  definePlugin,
  failure,
  inPerson,
  type Plugin,
} from "../../../runtime/mod.ts";
import { importAction } from "./actions/import.ts";
import { memoryCollection } from "./collections/memory.ts";
import { memoryProgress } from "./collections/progress.ts";
import { extractAction, extractor } from "./processors/extract.ts";
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
  // Its records change through its Actions, never written directly from outside.
  guard: (_actor, { collection, access, direct }) => {
    if (direct && access === "write" && ["memory", "memoryProgress"].includes(collection)) {
      throw failure("forbidden", `"${collection}" changes through the memory plugin's Actions.`, {
        public: true,
      });
    }
    return undefined;
  },
  collections: { memory: memoryCollection, memoryProgress },
  views: { "llm.memory": memoryView, ...contextViews },
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
      allow: inPerson,
      run: async (ctx, input) => {
        const { matchedCount } = await ctx.db.collection("memory").updateOne(
          { _id: input.memory },
          { $set: { in: input.to } },
        );
        return { moved: matchedCount > 0 };
      },
    }),
    // Memories moving in from another app, as they were (the system's: a migration).
    "memory.import": importAction,
  },
  // With the access plugin, a memory lives in a space (where it was learned): its members reach it.
  resources: { memory: { every: 8 }, context: contexts, tools, shared: { memory: {} } },
  async check(merged) {
    const { embedder } = settingsOf(merged);
    if (embedder) await merged.call("models.check", { model: embedder, port: "embeddings" });
  },
});

/**
 * Memories that arrive on their own: the extractor model reads every few
 * messages, and what a conversation said before going quiet.
 */
export const memoryExtraction: Plugin = definePlugin({
  name: "memory-extraction",
  requires: ["memory", "models"],
  processors: { "memory.extract": extractor },
  actions: { "memory.extract": extractAction },
  async check(merged) {
    const { extractor } = settingsOf(merged);
    if (!extractor) throw new Error("memory-extraction: set the memory resource's extractor model");
    await merged.call("models.check", { model: extractor, port: "llm" });
  },
});

export default memory;
