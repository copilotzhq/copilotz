/**
 * Chat's web front end, for the browser: home (a new chat), how a chat looks
 * with what agents are writing right now, a message and its files, where you
 * type, and at the top of the sidebar, starting one. With spaces' front end,
 * a space's chats: its Chats tab (`chats`, searchable) and, under it in the
 * sidebar, its latest (`chats.recent`), through spaces' `spaceTabs` and
 * `spaceSidebar` resources (named here; chat imports nothing of spaces').
 * In the command palette (the web shell's `palette`): chats to go to, a new
 * one, and moving the one open to another space, through spaces' picker
 * (`space.pick`, by name), as each chat's menu does.
 *
 * In a chat, agents show as they're named, with their emoji (`thread.agents`),
 * each name a link to its page (`/agent/<id>`, another front end's: team's),
 * and `@` lists those answering in its space. Add it beside the web shell:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb], root });
 * ```
 *
 * Home offers a few ways to start: the `suggestions` resource, which an app
 * adds to, or `null`s out (`{ suggestions: { week: null, dice: "Roll a die" } }`).
 *
 * Other front ends add to a conversation, and to home, through resource kinds
 * (their shapes are in contract.ts):
 *
 * - `conversation`: Views it shows over where you type, with hints
 *   `{ thread, in, working }`: what to answer there, once the agents' turn
 *   is over (`{ asks: { view: "computer.asks" } }`);
 * - `home`: Views home shows over its greeting, with hints `{ in }`
 *   (invitations to join a space);
 * - `toolViews`: by tool, the View that shows a call to it, instead of the
 *   call as data (`{ terminal: "computer.step" }`), while it runs and after;
 * - `refusals`: by the code a send was refused with, the View shown over
 *   where you type instead of the error, with what was typed and a way to
 *   send it again (`{ not_here: { view: "space.not-here" } }`: adding the
 *   agents it named to the space);
 * - `composerNotes`: by key, Views it shows over where you type, in a
 *   conversation and on home, with hints `{ thread?, in?, working }`: what to
 *   know before sending, or nothing (`{ billing: { view: "billing.composer" } }`:
 *   that the org is out of credits).
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { conversationView } from "./views/web/conversation.tsx";
import { fileView } from "./views/web/file.tsx";
import { homeView } from "./views/web/home.tsx";
import { liveView } from "./views/web/live.tsx";
import { messageView } from "./views/web/message.tsx";
import { chatsView } from "./views/web/chats.tsx";
import { newThreadView } from "./views/web/new-thread.tsx";
import { chatPaletteView } from "./views/web/palette.tsx";
import { recentView } from "./views/web/recent.tsx";

export const chatWeb: Plugin = definePlugin({
  name: "chat-web",
  requires: ["chat", "web-shell"],
  views: {
    thread: { web: conversationView },
    home: { web: homeView },
    message: { web: messageView },
    live: { web: liveView },
    file: { web: fileView },
    "new-thread": { web: newThreadView },
    chats: { web: chatsView },
    "chats.recent": { web: recentView },
    "chat.palette": { web: chatPaletteView },
  },
  resources: {
    sidebar: { start: { view: "new-thread", order: 0 } },
    spaceTabs: { chats: { title: "Chats", view: "chats", icon: "chat", order: 10 } },
    spaceSidebar: { chats: { view: "chats.recent", title: "chats" } },
    palette: { chats: { view: "chat.palette", order: 20 } },
    suggestions: {
      week: "Help me plan a calm, focused week",
      explain: "Explain a tricky idea simply, with an example",
      draft: "Draft a friendly reply to a hard email",
      names: "Brainstorm names for a side project",
    },
  },
});
