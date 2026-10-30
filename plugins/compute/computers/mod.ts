/**
 * Computers: people connect a machine (the computer program, run once, with
 * a one-time code) to a space, and the agents of that space's conversations
 * work on it. A computer is in its owner's Personal space, or shared into
 * others (its desks: one per space, with a folder of its own there), where
 * every member, and their agents, use it; each with their own shell, jobs
 * and browser, so they never tread on each other. Running commands, starting
 * jobs and writing files wait for a yes (once, for the conversation, or
 * always): from the person the agent works for, or the computer's owner when
 * they keep that to themselves. What a job serves gets an address of its own
 * for the space's members (`computer.preview`, the `preview` tool), once the
 * app names a domain for previews (`computers: { previews }`: see
 * resources/previews.ts).
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
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { admitAction } from "./actions/admit.ts";
import { approveAction } from "./actions/approve.ts";
import { codeAction } from "./actions/code.ts";
import { defaultAction } from "./actions/default.ts";
import { forgetAction } from "./actions/forget.ts";
import { moveAction } from "./actions/move.ts";
import { goneAction } from "./actions/gone.ts";
import { readyAction } from "./actions/ready.ts";
import { renameAction } from "./actions/rename.ts";
import { shareAction } from "./actions/share.ts";
import { unshareAction } from "./actions/unshare.ts";
import { workAction } from "./actions/work.ts";
import { previewAction, previewsAction, unpreviewAction } from "./actions/preview.ts";
import { approval } from "./collections/approval.ts";
import { computer } from "./collections/computer.ts";
import { desk } from "./collections/desk.ts";
import { enrollment } from "./collections/enrollment.ts";
import { grant } from "./collections/grant.ts";
import { preview } from "./collections/preview.ts";
import { previewRoutes } from "./resources/previews.ts";
import { tools } from "./resources/tools.ts";
import { contextViews } from "./views/context.ts";
import { UPDATE } from "./program/release.ts";
import { personOf } from "./shared/person.ts";
import { WORK } from "./shared/workloads.ts";

export type { Approval } from "./collections/approval.ts";
export type { Computer } from "./collections/computer.ts";
export type { Desk } from "./collections/desk.ts";
export type { Preview } from "./collections/preview.ts";
export type { ComputersSettings } from "./shared/settings.ts";

/** Collections a person reaches only their own of. */
const OWNED = new Set(["computer", "enrollment", "approval", "grant"]);

export const computers: Plugin = definePlugin({
  name: "computers",
  requires: ["chat", "spaces"],
  collections: { computer, desk, enrollment, approval, grant, preview },
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
    "computer.approve": approveAction,
    "computer.work": workAction,
    "computer.preview": previewAction,
    "computer.previews": previewsAction,
    "computer.unpreview": unpreviewAction,
  },
  // Agents with computer tools know, each turn, whose computer they work on and what waits for a yes.
  views: contextViews,
  resources: {
    tools,
    computers: {},
    context: { computer: { place: "turn" } },
    // A space's members see its computers (their desks there), as they see its conversations.
    shared: { desk: {}, preview: { field: "space" } },
    // What jobs serve, at addresses of their own, once the app says where (`previews`).
    routes: previewRoutes,
  },
  // Each person reaches their own computers, codes, approvals (those they answer) and grants.
  guard: (actor, { collection }) => {
    if (!OWNED.has(collection)) return undefined;
    const person = personOf(actor);
    return person ? { owner: person } : { owner: { $in: [] } };
  },
});

export default computers;
