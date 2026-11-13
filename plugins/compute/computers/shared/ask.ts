/**
 * Whether an agent may do something at a desk (a computer, in one space):
 * what neither its computer nor the settings ask about, or what the one who
 * answers there (`owner`: the person it works for, or the computer's owner)
 * let it do: always, in this conversation, whenever the routine that set it
 * going runs, or this once, used up now. Otherwise they're asked, as chat
 * asks for every plugin (its `ask`: an approval, waiting), and the agent
 * waits for them. Publishing reaches outside the computer, and destroying
 * one can't be undone: they're asked every time, and only a yes to that one
 * covers it.
 */
import type { Context } from "../../../../runtime/mod.ts";
import { type Answer, ask, originOf, type ToolContext } from "../../../agents/chat/contract.ts";
import { nameOf, namesFor } from "../../../access/spaces/contract.ts";
import { type Asked, onlyOnce, settingsOf } from "./settings.ts";

export type Ask = {
  /** Who answers. */
  owner: string;
  /** Whom the agent works for. */
  for: string;
  desk: string;
  computer: string;
  /** The computer's name, as it's shown. */
  name?: string;
  agent: string;
  thread: string;
  in?: string;
  work: Asked;
  detail: string;
  /** What a write or an edit would do, shortly. */
  preview?: string;
  /** What its computer asks about, when it says (the desk's `approve`); else the settings'. */
  approve?: Asked[];
};

/** What an agent asks to do, as its person reads it: "run ls", "start npm run dev", "write a.md". */
export const asks = (a: { work: string; detail: string }): string =>
  a.work === "terminal" ? `run ${a.detail}` : a.work === "jobs" ? `start ${a.detail}` : a.detail;

/**
 * A computer's ask in words: what it would do, as its person reads it ("run
 * ls on laptop"), and what a yes beyond this once lets ("run commands on
 * laptop").
 */
export const wordsOf = (a: { work: string; detail: string; name?: string }) => {
  const computer = a.name ?? "this computer";
  return {
    text: `${asks(a)}${a.name ? ` on ${a.name}` : ""}`,
    covers: ({
      terminal: `run commands on ${computer}`,
      jobs: `start jobs on ${computer}`,
      writes: `change files on ${computer}`,
      publish: `publish apps from ${computer}`,
      destroy: `destroy ${computer}`,
    } as Record<string, string>)[a.work] ?? `use ${a.work} on ${computer}`,
  };
};

/**
 * The answers a computer's ask takes: what's asked every time (publishing,
 * destroying), once or no; else this once, this conversation, for the
 * routine that set it going (when one did), always, or no.
 */
export const answersFor = (work: string, routine: boolean): Answer[] =>
  onlyOnce(work)
    ? ["once", "deny"]
    : ["once", "thread", ...(routine ? ["origin" as const] : []), "always", "deny"];

/**
 * True: go ahead. A string: what the agent is told instead (see chat's
 * `ask`: in a turn, its person is asked and the turn waits; elsewhere, it
 * says what it waits for).
 */
export async function allowed(
  ctx: Context & Partial<Pick<ToolContext, "callId" | "ask" | "answer">>,
  a: Ask,
): Promise<true | string> {
  const approve = a.approve ?? settingsOf(ctx).approve;
  if (!onlyOnce(a.work) && !approve.includes(a.work)) return true;
  const what = {
    terminal: "run this",
    jobs: "start this job",
    writes: "change this file",
    publish: "publish this as an app",
    destroy: "destroy",
  }[a.work];
  const names = await namesFor(ctx, [a.owner]);
  const owner = nameOf(a.owner, names);
  const doingOn = (whose: string) =>
    a.work === "destroy"
      ? `destroy ${whose} computer for good, with its files`
      : `${what} on ${whose} computer`;
  const mine = a.owner === a.for;
  return await ask(ctx, {
    owner: a.owner,
    for: a.for,
    agent: a.agent,
    thread: a.thread,
    ...(a.in ? { in: a.in } : {}),
    work: a.work,
    on: a.desk,
    computer: a.computer,
    detail: a.detail,
    ...wordsOf(a),
    ...(a.name ? { name: a.name } : {}),
    ...(a.preview ? { preview: a.preview } : {}),
    answers: answersFor(a.work, !!originOf(ctx.actor)),
    doing: doingOn(mine ? "their" : `${owner}'s`),
    question: `May I ${doingOn(mine ? "your" : `${owner}'s`)}?${
      mine ? "" : ` ${owner} answers.`
    }\n${a.detail}`,
  });
}
