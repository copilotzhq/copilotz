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
 * space of theirs in the org.
 */
import type { Context } from "../../../../runtime/mod.ts";
import type { Computer } from "../collections/computer.ts";
import type { Desk } from "../collections/desk.ts";

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
 * The computer `person`'s calls on `engine` run on: theirs, signed in to it
 * when it last said, and not shared with others' agents; `wanted` (where
 * their session is) first, then one online, then the most recently seen.
 * With none it fails at once, without asking any computer, so a model list
 * moves on to its next without a wait.
 */
export async function engineComputer(
  ctx: Context,
  person: string,
  engine: EngineName,
  wanted?: string,
): Promise<Computer> {
  const computers = await ctx.as().db.collection<Computer>("computer")
    .find({ owner: person }, { sort: { seen: -1 } });
  const signed = computers.filter((c) =>
    (c.engines as Record<string, EngineSeen> | undefined)?.[engine]?.signedIn
  );
  if (!signed.length) {
    throw engineFailure(
      "engine_signed_out",
      "Your plan isn't signed in on a computer of yours: sign in from Connected accounts.",
    );
  }
  const ranked = signed.sort((a, b) =>
    Number(b._id === wanted) - Number(a._id === wanted) || Number(b.online) - Number(a.online)
  );
  for (const computer of ranked) {
    if (!await sharedWithOthers(ctx, computer._id)) return computer;
  }
  throw engineFailure(
    "engine_shared",
    "Your computers are shared into spaces where others' agents work on them as you: " +
      "your plan's sign-in would be theirs to reach. Make one only yours (or have yourself answer for it there).",
  );
}

/** Says `computer` isn't signed in to `engine` anymore (its CLI said so), so calls stop going there. */
export async function signedOut(ctx: Context, computer: string, engine: EngineName) {
  await ctx.as().db.collection<Computer>("computer").updateOne({ _id: computer }, {
    $set: { [`engines.${engine}.signedIn`]: false },
  });
}
