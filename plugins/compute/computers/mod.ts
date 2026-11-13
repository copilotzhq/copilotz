/**
 * Computers: people connect a machine (the computer program, run once, with
 * a one-time code) to a space, and the agents of that space's conversations
 * work on it. A computer is in its owner's Personal space, or shared into
 * others (its desks: one per space, with a folder of its own there), where
 * every member, and their agents, use it; each with their own shell, jobs
 * and browser, so they never tread on each other. Running commands, starting
 * jobs and writing files wait for a yes (once, for the conversation, for a
 * routine, or always), asked as chat asks for everything (its `ask`): of the
 * person the agent works for, or the computer's owner when they keep that to
 * themselves. The agent's turn waits for it, and goes on once it's answered,
 * the call running then. What a job serves gets an address of its own
 * for the space's members (`computer.preview`, the `preview` tool), once the
 * app names a domain for previews (`computers: { previews }`: see
 * resources/previews.ts). A space's environment (variables and secrets, its
 * managers' `env.set`) is what its jobs and shells run with, and its apps
 * (see collections/env-var.ts); secrets are sealed with `computers: { key }`.
 *
 * ```ts
 * plugins: [models, chat, ...access, computers],
 * resources: { agents: { assistant: { tools: ["terminal", "read_file", "web_search"] } } }
 * ```
 *
 * The computer program is `program/main.ts` (`deno task computer`). It
 * connects to the owner as a `computer` worker, which `computer.admit` lets
 * in; the plugin sends it work through `ctx.workers` (see shared/workloads.ts).
 */
import { definePlugin, failure, personOf, type Plugin } from "../../../runtime/mod.ts";
import { admitAction } from "./actions/admit.ts";
import { allowedAction } from "./actions/allowed.ts";
import { allowOriginAction } from "./actions/allow-origin.ts";
import { codeAction } from "./actions/code.ts";
import { defaultAction } from "./actions/default.ts";
import { enrollmentAction } from "./actions/enrollment.ts";
import { envSetAction, envUnsetAction, envValuesAction } from "./actions/env.ts";
import { forgetAction } from "./actions/forget.ts";
import { goneAction } from "./actions/gone.ts";
import { markAction } from "./actions/mark.ts";
import { moveAction } from "./actions/move.ts";
import { previewAction, previewsAction, unpreviewAction } from "./actions/preview.ts";
import { provisionAction } from "./actions/provision.ts";
import { readyAction } from "./actions/ready.ts";
import { renameAction } from "./actions/rename.ts";
import { runningAction } from "./actions/running.ts";
import { scopeAction } from "./actions/scope.ts";
import { shareAction } from "./actions/share.ts";
import { unshareAction } from "./actions/unshare.ts";
import { viewAction } from "./actions/view.ts";
import { workAction } from "./actions/work.ts";
import { computer } from "./collections/computer.ts";
import { desk } from "./collections/desk.ts";
import { enrollment } from "./collections/enrollment.ts";
import { envVar } from "./collections/env-var.ts";
import { preview } from "./collections/preview.ts";
import { previewRoutes } from "./resources/previews.ts";
import { tools } from "./resources/tools.ts";
import { upgradeAsksAction } from "./actions/upgrade-asks.ts";
import { contextViews } from "./views/context.ts";
import { UPDATE } from "./program/release.ts";
import { leftProcessor } from "./processors/left.ts";
import { WORK } from "./shared/workloads.ts";

export type { Computer } from "./collections/computer.ts";
export type { Desk } from "./collections/desk.ts";
export type { EnvVar } from "./collections/env-var.ts";
export type { Preview } from "./collections/preview.ts";
export type { ComputersSettings } from "./shared/settings.ts";
export type { ComputerWake } from "./shared/wake.ts";
/** Asks and yeses computers kept before chat kept every ask, kept as chat keeps them now. */
export { upgradeAsks, type Upgraded } from "./shared/upgrade.ts";

/** Collections a person reaches only their own of. */
const OWNED = new Set(["computer", "enrollment"]);
/** Its records that live in spaces. */
const PLACED = new Set(["desk", "preview", "envVar"]);

export const computers: Plugin = definePlugin({
  name: "computers",
  requires: ["chat", "spaces"],
  collections: { computer, desk, enrollment, preview, envVar },
  workers: {
    computer: {
      admit: "computer.admit",
      ready: "computer.ready",
      gone: "computer.gone",
      // The work it serves, and a newer release when the app has one (the program updates itself).
      workloads: [...Object.values(WORK), UPDATE],
    },
  },
  actions: {
    "computer.code": codeAction,
    "computer.admit": admitAction,
    "computer.ready": readyAction,
    "computer.gone": goneAction,
    "computer.rename": renameAction,
    "computer.forget": forgetAction,
    "computer.share": shareAction,
    "computer.unshare": unshareAction,
    "computer.default": defaultAction,
    "computer.move": moveAction,
    "computer.allowOrigin": allowOriginAction,
    "computer.work": workAction,
    // A space's environment: its managers' (env.values: the system's, an app's deploy).
    "env.set": envSetAction,
    "env.unset": envUnsetAction,
    "env.values": envValuesAction,
    "computer.view": viewAction,
    "computer.preview": previewAction,
    "computer.previews": previewsAction,
    "computer.unpreview": unpreviewAction,
    // For other plugins' code (apps): where a space's work goes, and whether an agent may.
    "computer.scope": scopeAction,
    "computer.allowed": allowedAction,
    // Computers the app makes (cloud computers): the system's.
    "computer.provision": provisionAction,
    "computer.enrollment": enrollmentAction,
    "computer.running": runningAction,
    "computer.mark": markAction,
    // Asks and yeses kept the old way, kept as chat keeps them (code's, on a deploy).
    "computer.upgradeAsks": upgradeAsksAction,
  },
  processors: { "computers.left": leftProcessor },
  // Asks and yeses kept the old way are kept as chat keeps them, once, as a deploy first starts.
  schedules: {
    "computer.upgradeAsks": { once: true, call: "computer.upgradeAsks", input: {}, retries: 5 },
  },
  // Agents with computer tools know, each turn, whose computer they work on and what waits for a yes.
  views: contextViews,
  // What jobs serve, at addresses of their own, once the app says where (`previews`).
  routes: previewRoutes,
  resources: {
    tools,
    computers: {},
    context: { computer: { place: "turn" } },
    // A space's members see its computers (their desks there), as they see its conversations.
    shared: { desk: {}, preview: { field: "space" }, envVar: { field: "space" } },
    // A computer's uses (a cloud computer's time, its disk) by its name, as its desks say it.
    usageNames: {
      computer: { tag: "tags.computer", collection: "desk", key: "computer", field: "name" },
    },
  },
  // Each person reaches their own computers and codes. None of the plugin's records is written
  // directly from outside: which computer a desk or a preview is on is its Actions' to check.
  guard: (actor, { collection, access, direct }) => {
    if (direct && access === "write" && (OWNED.has(collection) || PLACED.has(collection))) {
      throw failure("forbidden", "Computers, and what's on them, change through their Actions.", {
        public: true,
      });
    }
    if (!OWNED.has(collection)) return undefined;
    const person = personOf(actor);
    return person ? { owner: person } : { owner: { $in: [] } };
  },
});

export default computers;
