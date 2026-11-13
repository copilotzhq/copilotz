/**
 * What agents wait on a person for, in words, wherever it shows (the
 * terminal's notice and commands, the web's cards and sidebar): who asks
 * (`asker`), what (`asking`: "post this to Launch", "run ls on laptop"), what
 * a yes beyond this once lets (`covering`), and how each answer it takes is
 * said and typed. Chat's own kinds (a share, an answer handed back) are said
 * from what they are, in the reader's words (chat's, `chat.<key>`); another
 * plugin's ask, in the words it asked with.
 */
import { nameOf } from "../../../access/spaces/contract.ts";
import type { Answer, Approval } from "../collections/approval.ts";
import { BACK } from "../shared/delivery.ts";
import { SHARE } from "../shared/share.ts";
import { say } from "./web/words.ts";

/** Who asks, as the one answering reads it: "assistant", or "assistant (for Bob)". */
export const asker = (
  a: Pick<Approval, "agent" | "for">,
  me: string | undefined,
  names: Record<string, string> = {},
  agent = a.agent,
): string => a.for && a.for !== me ? say("askerFor", { agent, name: nameOf(a.for, names) }) : agent;

/** Whether what's asked goes to people outside the org: a conversation shared with contacts. */
export const toContacts = (a: Pick<Approval, "on">): boolean => a.on.startsWith("thread:");

/** Where chat's own kinds would go, as people say it: "Launch", "Maria". */
const placeOf = (a: Pick<Approval, "name" | "detail">) => a.name || a.detail;

type Said = Pick<Approval, "work" | "on" | "name" | "detail" | "text">;

/** What it asks to do, as its person reads it: "post this to Launch", "run ls on laptop". */
export function asking(a: Said): string {
  const place = { place: placeOf(a) };
  if (a.work === SHARE) return say(toContacts(a) ? "doingSend" : "doingPost", place);
  if (a.work === BACK) return say(toContacts(a) ? "doingSendAnswer" : "doingPostAnswer", place);
  return a.text || a.detail;
}

/** What a yes beyond this once lets: "post to Launch", "run commands on laptop". */
export function covering(a: Said & Pick<Approval, "covers">): string {
  if (a.work === SHARE) {
    return say(toContacts(a) ? "coversSend" : "coversPost", { place: placeOf(a) });
  }
  return a.covers || asking(a);
}

/**
 * Who'd see what chat's own kinds would write, where it isn't said already:
 * how many members the place has ("Its 12 members will see it."); an answer
 * handed back into a conversation shared with contacts, them by name (a
 * share there names them as it asks). Nothing for another plugin's ask, or
 * when nobody would.
 */
export function seenOf(a: Pick<Approval, "work" | "on" | "name" | "detail" | "people">): string {
  if (a.work !== SHARE && a.work !== BACK) return "";
  if (toContacts(a)) return a.work === BACK ? say("seenByName", { name: placeOf(a) }) : "";
  return a.people ? say("seenByMembers", { count: a.people }) : "";
}

/** The ask as one sentence, its agent shown as named: "assistant wants to run ls on laptop". */
export const sentence = (a: Said, agent: string): string =>
  say("wantsTo", { agent, doing: asking(a) });

/** How each answer is said, on a button and wherever it's offered. */
const SAYS = {
  once: "answerOnce",
  thread: "answerThread",
  origin: "answerRoutine",
  always: "answerAlways",
  deny: "answerNo",
  here: "answerHere",
  me: "answerMe",
} as const;

/** An answer, as it's said for this ask: "Yes, for this routine", by what set the work going. */
export const answerSaid = (answer: Answer, a: Pick<Approval, "origin">): string =>
  answer === "origin" && a.origin && a.origin.kind !== "routine"
    ? say("answerOrigin", { kind: a.origin.kind })
    : say(SAYS[answer]);

/** An answer as it's typed after `/approve`, and how the terminal explains it. */
export const TYPED: Record<Answer, { word: string; note?: string }> = {
  once: { word: "once" },
  thread: { word: "thread", note: "this conversation" },
  origin: { word: "routine" },
  always: { word: "always" },
  deny: { word: "no" },
  here: { word: "here" },
  me: { word: "me", note: "to you only" },
};

/** The words `/approve` takes for each answer (and the other ways it's said). */
export const ANSWERED: Record<string, Answer> = {
  once: "once",
  thread: "thread",
  conversation: "thread",
  routine: "origin",
  always: "always",
  no: "deny",
  deny: "deny",
  here: "here",
  me: "me",
};

/** The answers an ask takes, as a button or a card says each. */
export const choices = (a: Pick<Approval, "answers" | "origin">) =>
  a.answers.map((answer) => ({ answer, label: answerSaid(answer, a) }));
