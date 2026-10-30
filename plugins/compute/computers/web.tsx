/**
 * Computers' web front end, for the browser: a space's Computer tab (its
 * computers: connecting one, adding one of yours, which one agents use, who
 * answers what they ask; then the terminal, jobs and files in the space's
 * folder), on its page and in the panel beside a chat; a computer's own page
 * at `/computer/<id>`, for its owner; at the top of the sidebar, what agents
 * wait on you for in other chats; and in chats, what agents ask you there
 * (Allow once · in this conversation · always · Deny, with what a write will
 * write) and their calls to computer tools, shown as commands and output,
 * files and changes, links. Add it beside the web shell and chat's and
 * spaces' front ends:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, computersWeb], root });
 * ```
 *
 * It fills chat's `conversation` and `toolViews` resources, spaces'
 * `spaceTabs` and the web shell's `palette` (moving one of yours to another
 * space, through spaces' picker, as each computer's menu does), and reads
 * the spaces the person reaches (`space.reached`). What agents ask shows
 * once their turn is over (`conversation`'s `working` hint).
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { asksView } from "./views/web/asks.tsx";
import { computerView } from "./views/web/computer.tsx";
import { computerPaletteView } from "./views/web/palette.tsx";
import { spaceComputersView } from "./views/web/space-tab.tsx";
import { stepView } from "./views/web/step.tsx";
import { waitingView } from "./views/web/waiting.tsx";

/** The computer tools (resources/tools.ts), by name: the browser loads front-end code only. */
const TOOLS = [
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

export const computersWeb: Plugin = definePlugin({
  name: "computers-web",
  requires: ["computers", "web-shell"],
  views: {
    computer: { web: computerView },
    "computer.space": { web: spaceComputersView },
    "computer.waiting": { web: waitingView },
    "computer.asks": { web: asksView },
    "computer.step": { web: stepView },
    "computer.palette": { web: computerPaletteView },
  },
  resources: {
    sidebar: { waiting: { view: "computer.waiting", order: 5 } },
    spaceTabs: {
      computer: { title: "Computer", view: "computer.space", icon: "computer", order: 30 },
    },
    conversation: { "computer.asks": { view: "computer.asks", order: 10 } },
    palette: { computers: { view: "computer.palette", order: 30 } },
    // Every computer tool's calls show as one View: commands, jobs, files, search, the browser.
    toolViews: Object.fromEntries(TOOLS.map((name) => [name, "computer.step"])),
  },
});
