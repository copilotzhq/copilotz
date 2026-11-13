/**
 * Chat's web front end, for the browser: home (a new chat), how a chat looks
 * with what agents are writing right now, a message and its files, where you
 * type, and at the top of the sidebar, starting one. With spaces' front end,
 * a space's chats: its Chats tab (`chats`, searchable) and, under it in the
 * sidebar, its latest (`chats.recent`), through spaces' `spaceTabs` and
 * `spaceSidebar` resources (named here; chat imports nothing of spaces').
 * In the command palette (the web shell's `palette`): chats to go to, a new
 * one, and moving the one open to another space, through spaces' picker
 * (`space.pick`, by name), as each chat's menu does; before it moves, who'll
 * see it there and what it drew on (`chat.moving`, from `thread.moving`).
 *
 * A chat shared with someone outside its space (a contact) has staff notes
 * beside it (`chat.notes`: its team's alone, in a lane opened from its
 * header, or a switch on a phone), where agents look things up and draft
 * replies that go on to the chat, reviewed, as the person's own.
 *
 * In a chat, what agents wait on you for shows over where you type, once
 * their turn is over (`chat.asks`): a card each, with only the answers it
 * takes (`chat.approve`), and keys for them (the arrows move between its
 * answers; 1, 2, 3… answer); in other chats, at the top of the sidebar
 * (`chat.waiting`).
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
 *   `{ thread, in, side, working, busy }`: what to answer there, once the
 *   agents' turn is over (chat's own asks: `{ asks: { view: "chat.asks" } }`);
 * - `home`: Views home shows over its greeting, with hints `{ in }`
 *   (invitations to join a space);
 * - `toolViews`: by tool, the View that shows a call to it, instead of the
 *   call as data (`{ terminal: "computer.step" }`), while it runs and after;
 * - `askViews`: by a kind of ask (an approval's `work`), the View that says
 *   what's asked on its card, and its icon, instead of chat's own words
 *   (`{ terminal: { view: "computer.ask", icon: "terminal" } }`); it gets the
 *   approval and hints `{ agent, aside }`, and chat draws the card and the
 *   answers around it (a share, an answer handed back: chat's own words);
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
import { asksView } from "./views/web/asks.tsx";
import { waitingView } from "./views/web/asking.tsx";
import { conversationView } from "./views/web/conversation.tsx";
import { fileView } from "./views/web/file.tsx";
import { homeView } from "./views/web/home.tsx";
import { liveView } from "./views/web/live.tsx";
import { messageView } from "./views/web/message.tsx";
import { movingView } from "./views/web/moving.tsx";
import { notesView } from "./views/web/notes.tsx";
import { chatsView } from "./views/web/chats.tsx";
import { newThreadView } from "./views/web/new-thread.tsx";
import { chatPaletteView } from "./views/web/palette.tsx";
import { recentView } from "./views/web/recent.tsx";

export const chatWeb: Plugin = definePlugin({
  name: "chat-web",
  requires: ["chat", "web-shell"],
  views: {
    "web.thread": conversationView,
    "chat.asks": asksView,
    "chat.waiting": waitingView,
    home: homeView,
    "web.message": messageView,
    "web.live": liveView,
    file: fileView,
    "new-thread": newThreadView,
    chats: chatsView,
    "chats.recent": recentView,
    "chat.palette": chatPaletteView,
    "chat.notes": notesView,
    "chat.moving": movingView,
  },
  resources: {
    // Starting one; then what agents wait on you for in other chats.
    sidebar: { start: { view: "new-thread", order: 0 }, asks: { view: "chat.waiting", order: 5 } },
    // What agents wait on you for here, over where you type.
    conversation: { asks: { view: "chat.asks", order: 10 } },
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
