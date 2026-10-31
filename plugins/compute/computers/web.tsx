/**
 * Computers' web front end, for the browser: a space's Computer tab (its
 * computers: connecting one, adding one of yours, which one agents use, who
 * answers what they ask; then the terminal, jobs and files in the space's
 * folder), on its page and in the panel beside a chat; a computer's own page
 * at `/computer/<id>`, for its owner; at the top of the sidebar, what agents
 * wait on you for in other chats; and in chats, what agents ask you there
 * (Allow once · for this routine, on a routine's run · in this conversation ·
 * always · Deny, with what a write will write) and their calls to computer tools, shown as commands and output,
 * files and changes, links. Add it beside the web shell and chat's and
 * spaces' front ends:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, computersWeb], root });
 * ```
 *
 * It fills chat's `conversation` and `toolViews` resources, spaces'
 * `spaceTabs`, routines' `routinePanels` (what a routine may do on its own)
 * and the web shell's `palette` (moving one of yours to another
 * space, through spaces' picker, as each computer's menu does), and reads
 * the spaces the person reaches (`space.reached`). What agents ask shows
 * once their turn is over (`conversation`'s `working` hint). A job that
 * serves a port gets a preview (`computer.preview`), opened in a tab, its
 * link copied, for the space's members or anyone with the link; the
 * computer's previews list over its jobs. A space's Environment tab: its
 * variables and secrets, which its managers add, change and remove.
 *
 * Other front ends add to it through three resources (see
 * views/web/kinds.ts): `computerKinds`, kinds of computer beyond people's
 * own machines (cloud computers: making one is a choice where people add a
 * computer; their state shows wherever they do; asleep, they wake),
 * `jobActions`, what else a job that serves a port can become (published
 * as an app), and `envActions`, what else a space's environment reaches
 * (its apps, given it again).
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { asksView } from "./views/web/asks.tsx";
import { computerView } from "./views/web/computer.tsx";
import { envSpaceView } from "./views/web/env.tsx";
import { computerPaletteView } from "./views/web/palette.tsx";
import { spaceComputersView } from "./views/web/space-tab.tsx";
import { stepView } from "./views/web/step.tsx";
import { routinePanelView } from "./views/web/routine-panel.tsx";
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
    "computer.routine": { web: routinePanelView },
    "env.space": { web: envSpaceView },
  },
  resources: {
    sidebar: { waiting: { view: "computer.waiting", order: 5 } },
    spaceTabs: {
      // The computer, then what goes with it: its environment (and the apps', apps/web.tsx).
      computer: {
        title: "Computer",
        view: "computer.space",
        icon: "computer",
        order: 40,
        own: "Computers",
      },
      env: { title: "Environment", view: "env.space", icon: "lock", under: "computer", order: 10 },
    },
    conversation: { "computer.asks": { view: "computer.asks", order: 10 } },
    palette: { computers: { view: "computer.palette", order: 30 } },
    // What a routine's agent may do on its own (routines' page).
    routinePanels: { computers: { view: "computer.routine", order: 10 } },
    // Every computer tool's calls show as one View: commands, jobs, files, search, the browser.
    toolViews: Object.fromEntries(TOOLS.map((name) => [name, "computer.step"])),
  },
});
