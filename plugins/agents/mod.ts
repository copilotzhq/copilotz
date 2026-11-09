/**
 * Agents: conversations and the agents in them. `chat` (threads, messages,
 * agents that answer with tools and message each other and people), `history`
 * (older history summarized so a thread never outgrows the prompt) and
 * `memory` (what agents know across conversations), `skills` (know-how agents
 * read when a task needs it), `routines` (messages sent to agents on a
 * schedule), `openapi` (an HTTP API's operations as Actions and tools, from
 * its OpenAPI spec) and `webTools` (`web_search` and `read_page`, for agents
 * without a computer), each a plugin of its own, configured by its resource
 * (agents people make, and the model tiers an org chooses, are
 * `@copilotz/team`):
 *
 *   plugins: [models, chat, history, memory, definePlugin({
 *     name: "app",
 *     resources: { history: { summarizer: "cheap" }, memory: { embedder: "small" } },
 *   })]
 */
export * from "./chat/mod.ts";
export * from "./history/mod.ts";
export * from "./memory/mod.ts";
export * from "./skills/mod.ts";
export * from "./routines/mod.ts";
export * from "./openapi/mod.ts";
export * from "./webtools/mod.ts";
