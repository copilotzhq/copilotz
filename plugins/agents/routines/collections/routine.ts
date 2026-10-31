/**
 * Routines: a message sent to an agent on a schedule, in a space ("every
 * weekday at 9:00, ask @researcher for the news on X"). Each is what to
 * send (`text`), to whom (`agent`), when (`schedule`), and where it posts:
 * always the same chat (`post`: the chat in `thread`, the one it was made
 * from, or its first run's), or a new one each run, named by `chatName`.
 * It runs as whoever made it (`by`), reaching only
 * what they reach; it's paused, or not; and it keeps when it runs next and
 * how its last run went. `rev` counts changes to what it does (what it asks,
 * whom, as whom): a yes given for it covers the version it was given for. Its queries, for front ends:
 *
 * - `list`: a space's routines (`{ in }`), each with whether the asker may
 *   change it (`editable`: its maker, or a manager there) and whether its
 *   maker has left the space (`left`: it can't run as them);
 * - `runs`: a routine's runs (`{ routine, limit? }`), newest first.
 */
import { defineCollection } from "../../../../runtime/mod.ts";
import type { Schedule } from "../shared/schedule.ts";
import type { RoutineRun } from "./run.ts";

const routineSchema = {
  type: "object",
  properties: {
    /** The space it's in: where its chats are. */
    in: { type: "string" },
    /** What it's called: "Morning news". */
    name: { type: "string" },
    /** What it sends each time, as its maker would say it. */
    text: { type: "string" },
    /** The agent it sends it to. */
    agent: { type: "string" },
    /** When (see shared/schedule.ts). */
    schedule: { type: "object" },
    /** Where it posts: always the same chat, or a new one each run. */
    post: { enum: ["new", "same"] },
    /** The same chat: the one it was made from, or else its first run's. */
    thread: { type: "string" },
    /** A new chat's name: `{name}`, `{date}`, `{time}` and `{run}` are filled in each run. */
    chatName: { type: "string" },
    /** When it was paused: it doesn't run until it's resumed. */
    paused: { type: "string" },
    /** Who made it, a person's id: it runs as them. */
    by: { type: "string" },
    /** Which version of what it does; none yet is 0. */
    rev: { type: "integer" },
    at: { type: "string" },
    updated: { type: "string" },
    /** When it runs next, while it's set to. */
    next: { type: "string" },
    /** When an `hours` schedule's beat started. */
    since: { type: "string" },
    /** How its last run went. */
    last: {
      type: "object",
      properties: {
        at: { type: "string" },
        outcome: { enum: ["sent", "failed", "forbidden"] },
        thread: { type: "string" },
        error: { type: "string" },
      },
      required: ["at", "outcome"],
    },
    /** How many times it has run. */
    runs: { type: "integer" },
  },
  required: ["in", "name", "text", "agent", "schedule", "post", "by", "at"],
} as const;

export type Routine = {
  _id: string;
  in: string;
  name: string;
  text: string;
  agent: string;
  schedule: Schedule;
  post: "new" | "same";
  chatName?: string;
  thread?: string;
  paused?: string;
  by: string;
  rev?: number;
  at: string;
  updated?: string;
  next?: string;
  since?: string;
  last?: { at: string; outcome: "sent" | "failed" | "forbidden"; thread?: string; error?: string };
  runs?: number;
};

/** A routine as `routine.list` answers: with what the asker may do, and whether it can run. */
export type Listed = Routine & { editable: boolean; left: boolean };

type Space = { _id: string; can?: string[] };
type Member = { member: string; space: string };

export const routine = defineCollection({
  schema: routineSchema,
  indexes: [["in"]],
  queries: {
    list: {
      allow: (actor) => actor.kind === "person",
      run: async (routines, params: { in: string }, ctx) => {
        const [found, spaces, members] = await Promise.all([
          routines.find({ in: params.in }, { sort: { at: 1 } }),
          ctx.db.collection("space").query<Space[]>("reached", {}),
          ctx.db.collection<Member>("member").find({ space: params.in }),
        ]);
        const manages = !!spaces.find((s) => s._id === params.in)?.can?.includes("manage");
        const me = ctx.actor?.kind === "person" ? ctx.actor.id : undefined;
        const people = new Set(members.map((m) => m.member));
        return (found as unknown as Routine[]).map((r): Listed => ({
          ...r,
          editable: manages || r.by === me,
          left: !people.has(`person:${r.by}`),
        }));
      },
    },
    runs: {
      allow: (actor) => actor.kind === "person",
      run: (_, params: { routine: string; limit?: number }, ctx) =>
        ctx.db.collection<RoutineRun>("routineRun").find({ routine: params.routine }, {
          sort: { at: -1 },
          limit: Math.min(params.limit ?? 20, 100),
        }),
    },
  },
});
