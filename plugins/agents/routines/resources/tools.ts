/**
 * Routines from a conversation, for agents: `schedule_routine` ("remind me
 * every Monday…": a routine posting back in this conversation, or in a new
 * chat each run, made for the person the agent works for, so it runs as them),
 * `list_routines` (this space's) and `cancel_routine`. Offered where that
 * person may make routines: a space they may write in (the access plugin's
 * rules). And `name_chat`, only in a chat a routine's run started: the agent
 * names it for what it found, so a list of runs reads at a glance.
 */
import type { ViewContext } from "../../../../runtime/mod.ts";
import { type Thread, type Tool, tool, type ToolContext } from "../../chat/contract.ts";
import type { Listed, Routine } from "../collections/routine.ts";
import { chatTitle, personOf } from "../shared/routines.ts";
import {
  describe,
  type Given,
  moment,
  oftenPerDay,
  type Schedule,
  scheduleSchema,
} from "../shared/schedule.ts";
import { nameOf, namesFor } from "../../../access/spaces/contract.ts";

type Space = { _id: string; can?: string[] };

/** Where the person an agent works for may write: its own conversation's space. */
const offer = (_agent: string, thread: Thread, ctx: ViewContext) => {
  if (!thread.in || !personOf(ctx)) return false;
  const spaces = ctx.db.collection("space").query<Space[]>("reached", {}).value;
  return !!spaces?.find((s) => s._id === thread.in)?.can?.includes("write");
};

/** The conversation's space and the person the agent works for, or why there are none. */
async function whereFor(ctx: ToolContext) {
  const person = personOf(ctx);
  const thread = await ctx.db.collection<Thread>("thread").findOne({ _id: ctx.thread });
  if (!person) return { missing: "Routines are a person's, and you aren't working for one here." };
  if (!thread?.in) return { missing: "This conversation isn't in a space: nowhere to keep it." };
  return { person, space: thread.in, as: ctx.as({ kind: "person", id: person }) };
}

/** A routine, as an agent reads it: one line, with its id (who made it by name). */
const line = (r: Routine, names: Record<string, string> = {}) => {
  const zone = "timezone" in r.schedule ? r.schedule.timezone : "UTC";
  const next = r.next
    ? `next ${moment(r.next, zone, "en-US")} ${zone}`
    : r.paused
    ? "paused"
    : "done";
  const last = r.last ? `; last ${r.last.outcome}${r.last.error ? ` (${r.last.error})` : ""}` : "";
  return `- "${r.name}" [${r._id}]: ${describe(r.schedule, { locale: "en-US" })}, asks ` +
    `@${r.agent}: "${r.text}" ` +
    `(${next}${last}; made by ${nameOf(r.by, names)})`;
};

/** Where a routine posts, as an agent tells it on; and how many chats that is, when it's a lot. */
function postsIn(r: Routine) {
  if (r.post !== "new") return "Each run posts in this chat.";
  const often = oftenPerDay(r.schedule as Schedule);
  return `Each run starts a new chat, like "${chatTitle(r)}".` +
    (often ? ` That's about ${often} new chats a day: say so.` : "");
}

const scheduleRoutine = tool({
  offer,
  description: "Make a routine: a message sent to an agent on a schedule, here, as the person " +
    'you work for ("every weekday at 9:00, ask @researcher for the news on X", "remind me ' +
    "every Monday to send the report\"). text is what's sent each time, written as the person " +
    "would ask it; agent defaults to you. Give the person's timezone when you know it (ask " +
    "when the time matters and you don't); without one, it's UTC. Where it posts: by default " +
    "back in this chat (reminders, monitoring, anything that reads as one thread). Use post " +
    '"new" when each run is its own piece of work to open later (a daily analysis), and give ' +
    "chat_name. Tell them what you set up, and where it posts.",
  input: {
    type: "object",
    properties: {
      name: { type: "string", description: "A short name: 'Monday report reminder'." },
      text: { type: "string", minLength: 1 },
      agent: { type: "string", description: "Who it asks; you, by default." },
      schedule: {
        ...scheduleSchema,
        description: "kind daily, weekdays or weekly (days, 0 = Sunday) take time (24h, " +
          '"09:00"); hours takes every (how many); once takes at ("2026-11-03T09:00", in ' +
          "timezone); cron takes cron (five fields). All but hours take timezone (IANA).",
      },
      post: {
        enum: ["new", "same"],
        description: "same (default): always this chat; new: a new chat each run.",
      },
      chat_name: {
        type: "string",
        maxLength: 120,
        description: 'With post new, what each chat is called: "Pricing response · {date}". ' +
          "{date}, {time} (its timezone), {run} and {name} are filled in each run.",
      },
    },
    required: ["text", "schedule"],
  },
  run: async (input, ctx) => {
    const where = await whereFor(ctx);
    if ("missing" in where) return where.missing;
    try {
      const made = await where.as.call<{ routine: string; next?: string }>("routine.create", {
        in: where.space,
        ...(input.name ? { name: input.name } : {}),
        text: input.text,
        agent: input.agent ?? ctx.agent,
        schedule: input.schedule as Given,
        ...(input.post === "new"
          ? {
            post: "new",
            ...(typeof input.chat_name === "string" ? { chatName: input.chat_name } : {}),
          }
          : { post: "same", thread: ctx.thread }),
      });
      const routine = await where.as.db.collection<Routine>("routine").findOne({
        _id: made.routine,
      });
      const names = await namesFor(ctx, [where.person, ...(routine ? [routine.by] : [])]);
      return routine
        ? `Made it: ${line(routine, names).slice(2)}. ${postsIn(routine)} It runs as ${
          nameOf(where.person, names)
        }; they can pause, ` +
          "change or delete it in this space's Routines."
        : "Made it.";
    } catch (error) {
      return `Couldn't make it: ${(error as Error).message}`;
    }
  },
});

const listRoutines = tool({
  offer,
  description: "The routines in this space: what each sends, to whom, when it runs next.",
  input: { type: "object", properties: {} },
  run: async (_input, ctx) => {
    const where = await whereFor(ctx);
    if ("missing" in where) return where.missing;
    const found = await where.as.db.collection("routine").query<Listed[]>("list", {
      in: where.space,
    });
    const names = await namesFor(ctx, found.map((r) => r.by));
    return found.length
      ? found.map((r) => line(r, names)).join("\n")
      : "No routines here yet. You can make one with schedule_routine.";
  },
});

const cancelRoutine = tool({
  offer,
  description: "Delete one of this space's routines, by its [id] (from list_routines) or its " +
    "name. Only its maker or a manager here may; the chats it posted in stay.",
  input: {
    type: "object",
    properties: { routine: { type: "string", minLength: 1 } },
    required: ["routine"],
  },
  run: async ({ routine }, ctx) => {
    const where = await whereFor(ctx);
    if ("missing" in where) return where.missing;
    const here = await where.as.db.collection<Routine>("routine").find({ in: where.space });
    const found = here.find((r) => r._id === routine) ??
      here.find((r) => r.name.toLowerCase() === routine.trim().toLowerCase());
    if (!found) return `No routine "${routine}" here.`;
    try {
      await where.as.call("routine.delete", { routine: found._id });
      return `Deleted "${found.name}". The chats it posted in stay.`;
    } catch (error) {
      return `Couldn't delete it: ${(error as Error).message}`;
    }
  },
});

const nameChat = tool({
  // Only in a chat a routine's run started, for its agent to name.
  offer: (_agent, thread, ctx) => !!thread.renamable && !!personOf(ctx),
  description: "Name this chat for what you found, once you have: people pick a run from a list " +
    'by its name ("Nov 2 · Competitor cut 8%, we hold"). One short line, with the conclusion.',
  input: {
    type: "object",
    properties: { name: { type: "string", minLength: 1, maxLength: 120 } },
    required: ["name"],
  },
  run: async ({ name }, ctx) => {
    const where = await whereFor(ctx);
    if ("missing" in where) return where.missing;
    const title = String(name).replace(/\s+/g, " ").trim().slice(0, 120);
    if (!title) return "A name says something.";
    await where.as.db.collection("thread").updateOne({ _id: ctx.thread }, { $set: { title } });
    return `Named it "${title}".`;
  },
});

export const tools: Record<string, Tool> = {
  schedule_routine: scheduleRoutine,
  list_routines: listRoutines,
  cancel_routine: cancelRoutine,
  name_chat: nameChat,
};
