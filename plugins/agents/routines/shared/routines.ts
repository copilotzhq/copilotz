/**
 * What every routine Action shares: who's asking (a person, or the person
 * an agent works for), whether they may change a routine (its maker, or a
 * manager of its space), its timer (`routine:<id>`, always set as its maker,
 * so time runs it as them whoever changed it), and its fields as Actions
 * take them.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Routine } from "../collections/routine.ts";
import { nextRuns, type Schedule, scheduleSchema, whenOf } from "./schedule.ts";
import { nameOf, namesFor } from "../../../access/spaces/contract.ts";

export const invalid = (message: string) => Object.assign(new Error(message), { code: "invalid" });
export const forbidden = (message: string) =>
  Object.assign(new Error(message), { code: "forbidden" });

/** A routine's fields, as `routine.create` and `routine.update` take them. */
export const fields = {
  name: { type: "string", minLength: 1, maxLength: 80 },
  text: { type: "string", minLength: 1, maxLength: 8000 },
  agent: { type: "string", minLength: 1 },
  schedule: scheduleSchema,
  post: { enum: ["new", "same"] },
} as const;

/** What Actions on one routine take: which. */
export const byId = {
  type: "object",
  properties: { routine: { type: "string", minLength: 1 } },
  required: ["routine"],
  additionalProperties: false,
} as const;

/** The timer that runs a routine. */
export const timerOf = (routine: string) => `routine:${routine}`;

/** The person asking: themselves, or the one an agent works for. */
export function personOf(ctx: Pick<Context, "actor">): string | undefined {
  const actor = ctx.actor;
  if (actor?.kind === "person") return actor.id;
  const principal = actor?.for as { kind?: string; id?: string } | undefined;
  return principal?.kind === "person" ? principal.id : undefined;
}

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
  if (found.by === personOf(ctx)) return found;
  const { can } = await ctx.call<{ can: boolean }>("space.can", {
    space: found.in,
    verb: "manage",
  });
  if (!can) {
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
