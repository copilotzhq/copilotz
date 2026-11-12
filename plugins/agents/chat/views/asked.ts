/**
 * What agents wait on a person for, in words, wherever it shows (the
 * terminal's notice and commands, the web's cards and sidebar): who asks
 * (`asker`), what (`asking`: the ask's own words, "run ls on laptop", "post
 * this to Launch"), and how each answer it takes is said and typed.
 */
import { nameOf } from "../../../access/spaces/contract.ts";
import type { Answer, Approval } from "../collections/approval.ts";
import { said } from "../shared/asks.ts";

/** Who asks, as the one answering reads it: "assistant", or "assistant (for Bob)". */
export const asker = (
  a: Pick<Approval, "agent" | "for">,
  me: string | undefined,
  names: Record<string, string> = {},
  agent = a.agent,
): string => a.for && a.for !== me ? `${agent} (for ${nameOf(a.for, names)})` : agent;

/** What it asks to do, as its person reads it: "run ls on laptop", "post this to Launch". */
export const asking = (a: Pick<Approval, "text" | "detail">): string => a.text || a.detail;

/** The ask as one sentence, its agent shown as named: "assistant wants to run ls on laptop". */
export const sentence = (a: Pick<Approval, "text" | "detail">, agent: string): string =>
  `${agent} wants to ${asking(a)}`;

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
  a.answers.map((answer) => ({ answer, label: said(answer, a) }));
