/**
 * Chat's terminal front end, for the process that draws the terminal: how a
 * conversation, a message, its author and a reply being written look there,
 * chat's commands, and what agents wait on you for, just above where you
 * type (`approvals`). Add it beside `chat` (which every process has):
 *
 * ```ts
 * plugins: [...app, terminalShell, chatTerminal]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { commands } from "./resources/commands.ts";
import { agentPromptView } from "./views/terminal/agent-prompt.ts";
import { approvalsView } from "./views/terminal/asks.ts";
import { authorView } from "./views/terminal/author.tsx";
import { conversationView } from "./views/terminal/conversation.tsx";
import { liveView } from "./views/terminal/live.tsx";
import { messageLine } from "./views/terminal/message.tsx";
import { threadsView } from "./views/terminal/threads.ts";

export const chatTerminal: Plugin = definePlugin({
  name: "chat-terminal",
  requires: ["chat", "terminal-shell"],
  views: {
    "terminal.thread": conversationView,
    "terminal.message": messageLine,
    author: authorView,
    "terminal.live": liveView,
    threads: threadsView,
    "agent.prompt": agentPromptView,
    approvals: approvalsView,
  },
  // What agents wait on you for shows just above where you type.
  resources: { commands, notices: { approvals: { view: "approvals" } } },
});
