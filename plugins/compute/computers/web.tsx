/**
 * Computers' web front end, for the browser: a space's Computer tab (its
 * computers: connecting one, adding one of yours, which one agents use, who
 * answers what they ask; then the terminal, jobs and files in the space's
 * folder), on its page and in the panel beside a chat; a computer's own page
 * at `/computer/<id>`, for its owner; Your AI's plans and computers (the
 * accounts plugin's `accountSections`: a card per plan the app uses, the
 * person's order of them, and the connect flow, which readies a computer,
 * installs and signs in each plan's CLI, and tests it; then their computers,
 * a Terminal a click away), with the palette's commands to connect each, and
 * a step for the app's welcome (`computer.plans.welcome`); a slot for what a
 * computer costs (`computer.cost`, filled by the app's cost display); in chats, what an agent asks to do on
 * one (the command, what a write will write, an app it would publish: chat's
 * card for it, with its answers, through chat's `askViews`) and their calls
 * to computer tools, shown as commands and output, files and changes, links.
 * Add it beside the web shell and chat's and spaces' front ends:
 *
 * ```ts
 * await web({ plugins: [webShell, chatWeb, spacesWeb, computersWeb], root });
 * ```
 *
 * It fills chat's `askViews` and `toolViews` resources, spaces'
 * `spaceTabs`, routines' `routinePanels` (what a routine may do on its own),
 * accounts' `accountSections` (the plans) and the web shell's `palette`
 * (moving one of yours to another space, through spaces' picker, as each
 * computer's menu does; signing a plan in), and reads
 * the spaces the person reaches (`space.reached`). A job that
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
import { askView } from "./views/web/asks.tsx";
import { computerView } from "./views/web/computer.tsx";
import { envSpaceView } from "./views/web/env.tsx";
import { computerPaletteView } from "./views/web/palette.tsx";
import { spaceComputersView } from "./views/web/space-tab.tsx";
import { stepView } from "./views/web/step.tsx";
import { routinePanelView } from "./views/web/routine-panel.tsx";
import { plansView } from "./views/web/plans.tsx";
import { plansPaletteView } from "./views/web/plans-palette.ts";
import { yoursView } from "./views/web/yours.tsx";
import { plansWelcomeView } from "./views/web/welcome.tsx";
import { costView } from "./views/web/cost.tsx";

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
  "save_file",
  "send_file",
  "browser",
  "web_search",
];

export const computersWeb: Plugin = definePlugin({
  name: "computers-web",
  requires: ["computers", "web-shell"],
  views: {
    computer: computerView,
    "computer.space": spaceComputersView,
    "computer.ask": askView,
    "computer.step": stepView,
    "computer.palette": computerPaletteView,
    "computer.routine": routinePanelView,
    "computer.plans": plansView,
    "computer.plans.palette": plansPaletteView,
    "computer.plans.welcome": plansWelcomeView,
    "computer.yours": yoursView,
    "computer.cost": costView,
    "env.space": envSpaceView,
  },
  resources: {
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
    // What an agent asks to do on a computer, on chat's card for it, by its kind of work.
    askViews: {
      terminal: { view: "computer.ask", icon: "terminal" },
      jobs: { view: "computer.ask", icon: "play" },
      writes: { view: "computer.ask", icon: "pencil" },
      publish: { view: "computer.ask", icon: "globe" },
      destroy: { view: "computer.ask", icon: "trash" },
    },
    palette: {
      computers: { view: "computer.palette", order: 30 },
      plans: { view: "computer.plans.palette", order: 91 },
    },
    // Your AI: the person's plans (the accounts that pay for models among them), then their computers.
    accountSections: {
      plans: { view: "computer.plans", order: 10, plans: true },
      computers: { view: "computer.yours", order: 20 },
    },
    // What a routine's agent may do on its own (routines' page).
    routinePanels: { computers: { view: "computer.routine", order: 10 } },
    // Every computer tool's calls show as one View: commands, jobs, files, search, the browser.
    toolViews: Object.fromEntries(TOOLS.map((name) => [name, "computer.step"])),
  },
});
