/**
 * How boards' tools answer, and how those answers read back. An answer's
 * first line says what happened ("Moved “Ship pricing page” [c1] from To do
 * to Doing") and names the board with its link (“Launch plan”
 * (/board/<id>)), so an agent links it when it tells people; a card's id is
 * in brackets, for the next call. A conversation shows each call by its
 * tool's View (views/web/step.tsx), which reads the same answer back:
 * what happened, the boards it names, the card. Pure.
 */
import { boardPath } from "../contract.ts";

/** A board as answers name it: in quotes, with its link. */
export const named = (board: { _id: string; name: string }) =>
  `“${board.name}” (${boardPath(board._id)})`;

/** What happened to a card, then where: `<head> — on “Board” (/board/<id>).` */
export const onBoard = (head: string, board: { _id: string; name: string }) =>
  `${head} — on ${named(board)}.`;

/** A card as answers name it: in quotes, with its id. */
export const cardNamed = (card: { _id: string; title: string }) => `“${card.title}” [${card._id}]`;

/** An answer, read back: whether it did something, what, and the boards and card it names. */
export type Heard = {
  /** Whether it names a board: answers that failed don't. */
  ok: boolean;
  /** Its first line, without the board's link and the card's id: what happened. */
  head: string;
  boards: { name: string; id: string }[];
  card?: string;
};

const BOARD = /“([^”\n]*)” \(\/board\/([A-Za-z0-9_-]+)\)/g;

export function heard(output: string | undefined): Heard {
  const text = (output ?? "").trim();
  const first = text.split("\n")[0] ?? "";
  const boards = [...text.matchAll(BOARD)].map((m) => ({ name: m[1], id: m[2] }))
    .filter((b, i, all) => all.findIndex((o) => o.id === b.id) === i);
  const card = /\[([A-Za-z0-9_-]+)\]/.exec(first)?.[1];
  const head = first
    .replace(/ — on “[^”\n]*” \(\/board\/[A-Za-z0-9_-]+\)\.?$/, "")
    .replace(/ \[[A-Za-z0-9_-]+\]/g, "")
    .replace(/\.$/, "")
    .trim();
  return { ok: boards.length > 0, head, boards, ...(card ? { card } : {}) };
}
