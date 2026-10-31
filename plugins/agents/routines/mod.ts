/**
 * Routines: a message sent to an agent on a schedule, in a space ("every
 * weekday at 9:00, ask @researcher for the news on X").
 *
 * - **A routine** (`routine`) says what to send, to which agent answering
 *   there, when (every day, weekdays or some days at a time, every few
 *   hours, once, or a cron expression, each in a timezone), and where it
 *   posts: always the same chat (the one it was made from, or its first
 *   run's), or a new chat each run, to open later, named by `chatName`
 *   (`{date}`, `{time}`, `{run}`, `{name}`). Its messages say they're its.
 * - **It runs as whoever made it,** reaching only what they reach: its timer
 *   (the runtime's, `routine:<id>`) is always set as its maker, whoever
 *   changes it, and time runs it as whoever set it. Each run calls
 *   `chat.send` and records the chat it posted in, when, and how it went
 *   (`routineRun`). A maker who has left the space can't send there: the
 *   run fails as forbidden, and says so; a manager may take it over.
 * - **Actions:** `routine.create` (those who may write in the space),
 *   `routine.update`, `routine.pause`, `routine.resume`, `routine.delete`
 *   and `routine.run` (now), by its maker or a manager there; queries for a
 *   space's routines and a routine's runs.
 * - **From a conversation:** agents have `schedule_routine`, `list_routines`
 *   and `cancel_routine` where the person they work for may make routines,
 *   so "remind me every Monday…" works from chat, and posts back there unless
 *   each run should be its own chat. In such a chat, `name_chat` lets the
 *   agent name it for what it found.
 *
 * ```ts
 * plugins: [models, chat, ...access, routines, app]
 * ```
 */
import { definePlugin, type Plugin } from "../../../runtime/mod.ts";
import { createAction } from "./actions/create.ts";
import { deleteAction } from "./actions/delete.ts";
import { fireAction } from "./actions/fire.ts";
import { pauseAction } from "./actions/pause.ts";
import { resumeAction } from "./actions/resume.ts";
import { runAction } from "./actions/run.ts";
import { updateAction } from "./actions/update.ts";
import { routine } from "./collections/routine.ts";
import { routineRun } from "./collections/run.ts";
import { tools } from "./resources/tools.ts";

export * from "./contract.ts";

export const routines: Plugin = definePlugin({
  name: "routines",
  // Runs post in chats, in spaces, as their makers.
  requires: ["chat", "spaces"],
  collections: { routine, routineRun },
  actions: {
    "routine.create": createAction,
    "routine.update": updateAction,
    "routine.pause": pauseAction,
    "routine.resume": resumeAction,
    "routine.delete": deleteAction,
    "routine.run": runAction,
    "routine.fire": fireAction,
  },
  resources: {
    tools,
    // A space's routines, and their runs, are its members' to see; who changes one, the Actions say.
    shared: { routine: {}, routineRun: {} },
  },
});

export default routines;
