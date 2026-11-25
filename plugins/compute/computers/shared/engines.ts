/**
 * Engines: a plan's CLI on a person's own computer (Claude Code, Codex,
 * Antigravity), which an agent's model call can run on instead of an API
 * key. The CLI is only the engine: the agent's instructions replace its
 * own, its built-in tools are off, and the agent's tools reach it from the
 * computer program (see program/agents/), where each engine keeps a home of
 * its own: its sign-in, apart from the person's own use of the CLI.
 *
 * Whose plan: the person the call is for (in an agent's turn, the person
 * it works for), on a computer of theirs, never anyone else's, and only one
 * that others' agents don't work on as them (shared into a space where its
 * agents answer to whoever they work for, the engine's sign-in would be
 * theirs to reach). One sign-in on a computer serves every conversation and
 * space of theirs in the org. So a cloud computer signed in to a plan isn't
 * shared that way until its person signs out of it there (`shareable`); a
 * person's own machine may be, as theirs to decide, and then runs no plan.
 */
import { type Context, failure } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import type { Desk } from "../collections/desk.ts";
import { servingOrder } from "./serving.ts";
import { type EngineStatus, type Failed, WORK } from "./workloads.ts";

/** The engines a computer program runs, by its own name for each. */
export const ENGINES = ["claude", "codex", "antigravity"] as const;
export type EngineName = (typeof ENGINES)[number];

/** What a computer last said of an engine (`computer.engines` keeps it on the computer). */
export type EngineSeen = {
  installed: boolean;
  signedIn: boolean;
  version?: string;
  account?: string;
  /** When it said so. */
  at: string;
  /**
   * When the plan last reached its limit there (a call failed `limit`),
   * until a call there next succeeds: calls move on meanwhile, and Your AI
   * says since when.
   */
  limited?: string;
};

/** A failure an engine's call answers with: its `code` tells the model list to move on. */
export const engineFailure = (code: string, message: string) =>
  Object.assign(new Error(message), { code, public: true });

/**
 * Whether others' agents work on `computer` as its owner: a desk in a space
 * other than its owner's Personal one, where agents answer to whoever they
 * work for. (Where the owner answers everything, nothing runs there without them.)
 */
export async function sharedWithOthers(ctx: Context, computer: string): Promise<boolean> {
  const desks = await ctx.as().db.collection<Desk>("desk").find({ computer, answers: "asker" });
  if (!desks.length) return false;
  const spaces = await ctx.as().db.collection<{ kind?: string }>("space")
    .find({ _id: { $in: desks.map((desk) => desk.in) } }, { projection: { kind: 1 } });
  const personal = new Set(spaces.filter((s) => s.kind === "personal").map((s) => s._id));
  return desks.some((desk) => !personal.has(desk.in));
}

/**
 * The computer `person`'s calls on `engine` run on: the first in
 * `servingOrder` (online, then one the app keeps, which wakes, then the
 * rest) that others' agents don't work on as them. With none it fails at
 * once, without asking any computer, so a model list moves on to its next
 * without a wait.
 */
export async function engineComputer(
  ctx: Context,
  person: string,
  engine: EngineName,
  wanted?: string,
): Promise<Computer> {
  const computers = await ctx.as().db.collection<Computer>("computer").find({ owner: person });
  const ranked = servingOrder(computers, engine, wanted);
  if (!ranked.length) {
    throw engineFailure(
      "engine_signed_out",
      "Your plan isn't signed in on a computer of yours: connect it from Your AI.",
    );
  }
  for (const computer of ranked) {
    if (!await sharedWithOthers(ctx, computer._id)) return computer;
  }
  throw engineFailure(
    "engine_shared",
    "Your computers are shared into spaces where others' agents work on them as you: " +
      "your plan's sign-in would be theirs to reach. Make one only yours (or have yourself answer for it there).",
  );
}

/** Each plan's name, as its provider says it. */
const PLAN: Record<EngineName, string> = {
  claude: "Claude plan",
  codex: "ChatGPT plan",
  antigravity: "Google AI plan",
};

/**
 * Refuses a cloud computer (one the app keeps: `status`) a desk in `space`
 * that shares it with others' agents (`answers: "asker"`, in a space other
 * than a Personal one) while it's signed in to a plan, as it last said (it
 * isn't woken to ask): their agents would read the sign-in kept there. Its
 * person signs out of it first. A person's own machine is theirs to share:
 * the page says what it means, and their plans don't run on it then.
 */
export async function shareable(
  ctx: Context,
  computer: Pick<Computer, "name" | "engines" | "status">,
  space: string,
  answers: Desk["answers"],
): Promise<void> {
  if (answers !== "asker" || !computer.status) return;
  const seen = computer.engines as Partial<Record<EngineName, EngineSeen>> | undefined;
  const signed = ENGINES.find((engine) => seen?.[engine]?.signedIn);
  if (!signed) return;
  const found = await ctx.as().db.collection<{ kind?: string }>("space").findOne({ _id: space });
  if (found?.kind === "personal") return;
  throw failure(
    "plan_signed_in",
    `${computer.name ?? "This computer"} is signed in to your ${PLAN[signed]}. Sign out of it ` +
      "first: a computer shared with others can't keep plan sign-ins.",
    { public: true, status: 409 },
  );
}

/** Keeps that `engine`'s plan reached its limit on `computer` now (`at`), or no longer (none). */
export async function limitOf(ctx: Context, computer: string, engine: EngineName, at?: string) {
  const field = `engines.${engine}.limited`;
  await ctx.as().db.collection<Computer>("computer").updateOne(
    { _id: computer },
    at ? { $set: { [field]: at } } : { $unset: { [field]: "" } },
  );
}

/** Says `computer` isn't signed in to `engine` anymore (its CLI said so), so calls stop going there. */
export async function signedOut(ctx: Context, computer: string, engine: EngineName) {
  await ctx.as().db.collection<Computer>("computer").updateOne({ _id: computer }, {
    $set: { [`engines.${engine}.signedIn`]: false },
  });
}

/**
 * Asks `computer` what its plans' CLIs are now (`computer.agents.status`:
 * `engines`, or every one), and keeps what it said on it, field by field (a
 * plan's `limited` stays): what it said, by engine, or undefined when it
 * didn't answer (it's offline, or its program is older than the work).
 * Asked after a wake, it's what's true there now, not what was before it
 * slept.
 */
export async function engineStatus(
  ctx: Context,
  computer: string,
  engines?: EngineName[],
): Promise<Partial<Record<EngineName, EngineSeen>> | undefined> {
  const said = await ctx.workers.call<EngineStatus[] | Failed>(
    "computer",
    computer,
    WORK.agentsStatus,
    engines ? { engines } : {},
  ).catch(() => undefined);
  if (!Array.isArray(said)) return undefined;
  const at = new Date().toISOString();
  const seen: Partial<Record<EngineName, EngineSeen>> = {};
  const set: Record<string, unknown> = {};
  const unset: Record<string, ""> = {};
  for (const status of said) {
    if (!(ENGINES as readonly string[]).includes(status.engine)) continue;
    const name = status.engine as EngineName;
    seen[name] = {
      installed: status.installed,
      signedIn: status.signedIn,
      ...(status.version ? { version: status.version } : {}),
      ...(status.account ? { account: status.account } : {}),
      at,
    };
    const field = `engines.${name}`;
    Object.assign(set, {
      [`${field}.installed`]: status.installed,
      [`${field}.signedIn`]: status.signedIn,
      [`${field}.at`]: at,
    });
    for (const key of ["version", "account"] as const) {
      if (status[key]) set[`${field}.${key}`] = status[key];
      else unset[`${field}.${key}`] = "";
    }
  }
  await ctx.as().db.collection<Computer>("computer").updateOne({ _id: computer }, {
    $set: set,
    ...(Object.keys(unset).length ? { $unset: unset } : {}),
  });
  return seen;
}
