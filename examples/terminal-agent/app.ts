/**
 * The terminal agent app: just resources. Agents, tools and providers are
 * plain objects; the agents theme knows what to do with them. The
 * assistant asks the researcher in subthreads, and you before anything it
 * can't undo. Agents remember across conversations (memory), and long
 * conversations are summarized as they grow (chat history). On your computer,
 * once you connect it (`/computer connect`, then `deno task computer connect`
 * there), they run commands and jobs, edit files, browse and search the web,
 * each in a folder of the conversation's space, asking you before commands
 * and writes.
 */
import { definePlugin } from "../../runtime/mod.ts";
import { models } from "../../plugins/models/mod.ts";
import { chat, history, memory, memoryExtraction, team, tool } from "../../plugins/agents/mod.ts";
import { usage } from "../../plugins/billing/mod.ts";
import { terminalPlugin } from "../../plugins/interfaces/terminal/mod.ts";
import { access } from "../../plugins/access/mod.ts";
import { computers } from "../../plugins/compute/mod.ts";
import { notes } from "./notes.ts";

const apiKey = Deno.env.get("OPENAI_API_KEY");

/** Where remote executors connect, and the file holding the owner's executor key. */
export const EXECUTORS = "/core/executors";
export const KEY_FILE = ".data/executor.key";

// Models are "provider/model". Without a key, everything runs offline: the
// fake model echoes, and hash embeddings match words.
// Offline, the fake model says which images and PDFs it was shown.
const main = apiKey
  ? Deno.env.get("MODEL") ?? "openai/gpt-6.1-sol"
  : { model: "fake/echo", input: ["image", "pdf"] };
const cheap = apiKey ? Deno.env.get("CHEAP_MODEL") ?? "openai/gpt-5.4-mini" : "fake/echo";

/** What agents do on the person's computer (the computers plugin's tools). */
const COMPUTER = [
  "terminal",
  "start_job",
  "list_jobs",
  "job_logs",
  "stop_job",
  "list_files",
  "read_file",
  "write_file",
  "edit_file",
  "browser",
  "web_search",
];

const app = definePlugin({
  name: "terminal-agent",
  resources: {
    // Conversations live in spaces: each person reaches their own, and the
    // shared spaces they join (see the access plugin).
    shared: { thread: {}, message: { labels: true }, memory: {}, file: {}, live: {} },
    // A provider the catalog knows needs only its key: the catalog has its
    // protocol and URL, its models' prices, reasoning levels and limits.
    // Others name an `adapter` (the protocol) and a `baseURL`.
    provider: { ...(apiKey ? { openai: { apiKey } } : {}) },
    // Summaries and memory extraction: small, fast, cheap, thinking little.
    model: {
      cheap: apiKey ? { model: cheap, effort: "low" } : cheap,
      // Voice messages and audio sent with a message are transcribed as they're sent.
      transcribe: apiKey ? "openai/gpt-4o-mini-transcribe" : "fake/echo",
    },
    // Long conversations are summarized as they grow.
    history: { summarizer: "cheap" },
    // Without a model key, the fake model can't extract anything: memory then lives on its tools.
    memory: {
      embedder: apiKey ? { model: "openai/text-embedding-3-small", dimensions: 512 } : "hash/words",
      ...(apiKey ? { extractor: "cheap" } : {}),
    },
    agents: {
      assistant: {
        default: true,
        instructions: [
          "You are a concise, friendly assistant in a terminal. Use tools when useful.",
          "For anything that needs digging (facts, comparisons, background), ask the researcher " +
          "with send_message in a subthread, then answer with what it found.",
          "Before anything that can't be undone, or when only the user can decide, ask the user " +
          "with send_message and wait for their answer.",
        ].join("\n"),
        model: main,
        ...(apiKey ? { effort: "low" } : {}),
        tools: [
          "clock",
          "roll_dice",
          "send_message",
          "write_note",
          "read_notes",
          ...COMPUTER,
        ],
      },
      // It joins new spaces too: the assistant asks it.
      researcher: {
        default: true,
        description: "Digs into a question and reports concise findings, with caveats.",
        instructions: "You research questions other agents send you. Reply with 3 to 5 short " +
          "bullet points of findings and say what you're unsure about. Search the web and " +
          "read pages with web_search and browser when the user's computer is connected; " +
          "otherwise say you couldn't look.",
        model: main,
        ...(apiKey ? { effort: "medium" } : {}),
        tools: ["clock", "web_search", "browser"],
      },
    },
    tools: {
      clock: tool({
        description: "The current local date and time.",
        run: () => new Date().toString(),
      }),
      roll_dice: tool({
        description: "Roll a die with the given number of sides.",
        input: {
          type: "object",
          properties: { sides: { type: "integer", minimum: 2 } },
        },
        run: ({ sides }) => 1 + Math.floor(Math.random() * (sides ?? 6)),
      }),
    },
  },
});

export default app;

/**
 * Everything the terminal agent runs: the owner and every executor use the
 * same list. The terminal's front ends (how things look there) join only the
 * process that draws: see chat.ts.
 */
export const plugins = [
  models,
  // Every model call is recorded with what it cost (models.dev's prices): /usage shows them.
  usage,
  // Conversations, their history summarized, and what agents remember (settings: the app's resources).
  chat,
  history,
  memory,
  ...(apiKey ? [memoryExtraction] : []),
  // Who reaches what: spaces, members (people and agents), and the rules conversations keep to.
  ...access,
  // Agents people make, beside the app's (below).
  team,
  // Notes in spaces, and the tools agents use them with.
  notes,
  // People's computers, where agents run commands, browse and search (deno task computer).
  computers,
  // The terminal's data: where each person is, what their commands printed.
  terminalPlugin,
  app,
];
