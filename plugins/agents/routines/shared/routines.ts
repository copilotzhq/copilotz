/**
 * What every routine Action shares: who's asking (a person, or the person
 * an agent works for), whether they may change a routine (its maker, or a
 * manager of its space), its timer (`routine:<id>`, always set as its maker,
 * so time runs it as them whoever changed it), and its fields as Actions
 * take them.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { forbidden, invalid, personOf } from "../../../../runtime/mod.ts";
import type { Routine } from "../collections/routine.ts";
import { localOf, nextRuns, type Schedule, scheduleSchema, whenOf } from "./schedule.ts";
import { may, nameOf, namesFor } from "../../../access/spaces/contract.ts";

export { invalid };
export { forbidden };

/** A routine's fields, as `routine.create` and `routine.update` take them. */
export const fields = {
  name: { type: "string", minLength: 1, maxLength: 80 },
  text: { type: "string", minLength: 1, maxLength: 8000 },
  agent: { type: "string", minLength: 1 },
  schedule: scheduleSchema,
  post: { enum: ["new", "same"] },
  chatName: { type: "string", maxLength: 120 },
} as const;

/** A routine's page, on the web. */
export const routinePath = (id: string, edit = false) =>
  `/routine/${encodeURIComponent(id)}${edit ? "?edit=1" : ""}`;

/** A new chat's name, unless the routine says: its name and the day, the time too if it runs more often. */
export const defaultChatName = (schedule: Schedule) =>
  schedule.kind === "hours" || schedule.kind === "cron"
    ? "{name} · {date} {time}"
    : "{name} · {date}";

/**
 * What a run's new chat is called: `chatName` (or the default) with `{name}`,
 * `{date}` (2026-11-02), `{time}` (09:00, in the routine's timezone) and
 * `{run}` (its number) filled in.
 */
export function chatTitle(
  routine: Pick<Routine, "name" | "chatName" | "schedule" | "runs">,
  at: string | number = Date.now(),
): string {
  const zone = "timezone" in routine.schedule ? routine.schedule.timezone : "UTC";
  const [date, time] = localOf(at, zone).split("T");
  const filled: Record<string, string> = {
    name: routine.name,
    date,
    time,
    run: String((routine.runs ?? 0) + 1),
  };
  return (routine.chatName?.trim() || defaultChatName(routine.schedule))
    .replace(/\{(name|date|time|run)\}/g, (_, token: string) => filled[token])
    .replace(/\s+/g, " ").trim().slice(0, 120);
}

/** What Actions on one routine take: which. */
export const byId = {
  type: "object",
  properties: { routine: { type: "string", minLength: 1 } },
  required: ["routine"],
  additionalProperties: false,
} as const;

/** The timer that runs a routine. */
export const timerOf = (routine: string) => `routine:${routine}`;

/** This context, acting as the routine's maker (itself, when it already is them). */
export const asMaker = (ctx: Context, by: string): Context =>
  ctx.actor?.kind === "person" && ctx.actor.id === by && !ctx.actor.for
    ? ctx
    : ctx.as({ kind: "person", id: by });

/**
 * A routine the caller may change: theirs, or one in a space they manage.
 * Throws `invalid` when they can't see it, `forbidden` when they may only look.
 */
export async function editable(ctx: Context, id: string): Promise<Routine> {
  const found = await ctx.db.collection<Routine>("routine").findOne({ _id: id });
  if (!found) throw invalid("No such routine here: it may have been deleted.");
  if (found.by !== personOf(ctx.actor) && !await may(ctx, "manage", found.in)) {
    const maker = nameOf(found.by, await namesFor(ctx, [found.by]));
    throw forbidden(
      `Only ${maker}, who made "${found.name}", or those who manage its space change it.`,
    );
  }
  return found;
}

/** Throws unless `agent` answers where the routine posts. */
export async function answersIn(ctx: Context, space: string, agent: string) {
  const team = await ctx.db.collection("thread").query<{ here: string[] }>("agents", { in: space });
  if (!team.here.includes(agent)) {
    throw invalid(
      `${agent} doesn't answer in this space: add it as an editor first, or pick another.`,
    );
  }
}

/** When it runs next, and where an `hours` beat starts, from now. */
export function timing(schedule: Schedule, now = Date.now(), since?: string) {
  const start = schedule.kind === "hours" ? since ?? new Date(now).toISOString() : undefined;
  const [next] = nextRuns(schedule, { from: now, count: 1, since: start });
  return { ...(next ? { next: next.toISOString() } : {}), ...(start ? { since: start } : {}) };
}

/** Sets its timer, as its maker: time calls `routine.fire`. */
export const arm = (ctx: Context, routine: Pick<Routine, "_id" | "by" | "schedule">) =>
  asMaker(ctx, routine.by).schedule("routine.fire", { routine: routine._id }, {
    ...whenOf(routine.schedule),
    id: timerOf(routine._id),
  });

/** Takes its timer away. */
export const disarm = (ctx: Context, routine: string) => ctx.unschedule(timerOf(routine));

/** A name for a routine from what it sends: its first words. */
export function nameFrom(text: string): string {
  const words = text.replace(/@[\w.-]+/g, "").replace(/\s+/g, " ").trim();
  const short = words.length > 40 ? `${words.slice(0, 40).replace(/\s+\S*$/, "")}…` : words;
  return short ? short[0].toUpperCase() + short.slice(1) : "Routine";
}
