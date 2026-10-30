/**
 * The app: its plugins and their resources, plain objects. An assistant in
 * every new space, conversations in spaces (each person's Personal space, and
 * the shared ones they join), agents people make (team), and what agents
 * remember (memory). Without `OPENAI_API_KEY`, it runs offline: the fake model
 * echoes, and hash embeddings match words.
 */
import process from "node:process";
import { definePlugin, type Plugins } from "../../runtime/mod.ts";
import { models } from "../../plugins/models/mod.ts";
import { chat, history, memory, team, tool } from "../../plugins/agents/mod.ts";
import { access } from "../../plugins/access/mod.ts";

const apiKey = process.env.OPENAI_API_KEY;

const app = definePlugin({
  name: "web-node",
  resources: {
    // What each person reaches: their spaces' conversations, memories and files.
    shared: { thread: {}, message: { labels: true }, memory: {}, file: {}, live: {} },
    provider: apiKey ? { openai: { apiKey } } : {},
    model: {
      main: apiKey ? { model: "openai/gpt-5.4-mini", effort: "low" } : "fake/echo",
      cheap: apiKey ? { model: "openai/gpt-5.4-mini", effort: "low" } : "fake/echo",
      transcribe: apiKey ? "openai/gpt-4o-mini-transcribe" : "fake/echo",
    },
    history: { summarizer: "cheap" },
    memory: {
      embedder: apiKey ? { model: "openai/text-embedding-3-small", dimensions: 512 } : "hash/words",
    },
    agents: {
      assistant: {
        default: true,
        instructions: "You are a concise, friendly assistant. Use tools when useful.",
        model: "main",
        tools: ["clock"],
      },
    },
    tools: {
      clock: tool({ description: "The current date and time.", run: () => new Date().toString() }),
    },
  },
});

/** Everything the server runs; the browser loads only the front ends (browser.tsx). */
export const plugins: Plugins = [models, chat, history, memory, ...access, team, app];
