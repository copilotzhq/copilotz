/**
 * Chat's terminal front end, for the process that draws the terminal: how a
 * conversation, a message, its author and a reply being written look there,
 * and chat's commands. Add it beside `chat` (which every process has):
 *
 * ```ts
 * plugins: [...app, terminalShell, chatTerminal]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { commands } from "./resources/commands.ts";
import { agentPromptView } from "./views/terminal/agent-prompt.ts";
import { authorView } from "./views/terminal/author.tsx";
import { conversationView } from "./views/terminal/conversation.tsx";
import { liveView } from "./views/terminal/live.tsx";
import { messageLine } from "./views/terminal/message.tsx";
import { threadsView } from "./views/terminal/threads.ts";

export const chatTerminal: Plugin = definePlugin({
  name: "chat-terminal",
  requires: ["chat", "terminal-shell"],
  views: {
    thread: { terminal: conversationView },
    message: { terminal: messageLine },
    author: { terminal: authorView },
    live: { terminal: liveView },
    threads: { terminal: threadsView },
    "agent.prompt": { terminal: agentPromptView },
  },
  resources: { commands },
});
