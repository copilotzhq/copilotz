/**
 * Agents: conversations and the agents in them. `chat` (threads, messages,
 * agents that answer with tools and message each other and people), `history`
 * (older history summarized so a thread never outgrows the prompt) and
 * `memory` (what agents know across conversations) and `team` (agents people
 * make, beside the app's), each a plugin of its own, configured by its resource:
 *
 *   plugins: [models, chat, history, memory, definePlugin({
 *     name: "app",
 *     resources: { history: { summarizer: "cheap" }, memory: { embedder: "small" } },
 *   })]
 */
export * from "./chat/mod.ts";
export * from "./history/mod.ts";
export * from "./memory/mod.ts";
export * from "./team/mod.ts";
