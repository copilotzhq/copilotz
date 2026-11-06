/**
 * An agent's call to a board's tool, in a conversation (kind `board.step`,
 * chat's `toolViews` for the six tools): one compact line, what happened
 * ("Created “Ship pricing page” in To do", "Moved “Ship pricing page” from
 * To do to Doing"), and the board as a link (to the card, when there's
 * one); "Moving a card…" while it runs; what went wrong, plainly, when it
 * did. It reads the tool's answer back (shared/said.ts), so it says what
 * changed then, whatever the board says now.
 */
import type { ReactNode } from "react";
import type { ViewContext } from "../../../../../runtime/mod.ts";
import type { ShownCall } from "../../../../agents/chat/contract.ts";
import { Icon, Spinner } from "../../../../../hosts/web/mod.ts";
import { boardPath } from "../../contract.ts";
import { heard } from "../../shared/said.ts";
import { Glyph } from "./glyphs.tsx";
import { STYLE } from "./style.ts";

/** What each tool says while it runs. */
const RUNNING: Record<string, string> = {
  list_boards: "Looking at the boards…",
  read_board: "Reading the board…",
  create_board: "Making a board…",
  create_card: "Adding a card…",
  update_card: "Changing a card…",
  move_card: "Moving a card…",
};

/** A line with what's in quotes in bold: the titles and names it mentions. */
function said(text: string): ReactNode[] {
  return text.split(/(“[^”]*”)/).map((part, i) =>
    part.startsWith("“") ? <b key={i}>{part}</b> : part
  );
}

export const boardStepView = (call: ShownCall, ctx: ViewContext<ReactNode>): ReactNode => {
  const style = <style href="boards-web" precedence="copilotz">{STYLE}</style>;
  const space = typeof ctx.hints.in === "string" ? ctx.hints.in : undefined;
  if (ctx.hints.running === true) {
    return (
      <span className="board-step">
        {style}
        <Spinner size={14} />
        <span>{RUNNING[call.name] ?? "Working on a board…"}</span>
      </span>
    );
  }
  const answer = heard(call.output);
  const link = (board: { id: string; name: string }, card?: string) => (
    <a key={board.id} className="board-step-link" href={boardPath(board.id, space, card)}>
      <Glyph name="board" size={13} />
      <span>{board.name}</span>
    </a>
  );
  if (!answer.ok) {
    const quiet = call.name === "list_boards" && /^No boards/.test(answer.head);
    return (
      <span className="board-step">
        {style}
        <span className="board-step-mark" data-failed={quiet ? undefined : ""}>
          {quiet ? <Glyph name="board" size={13} /> : <Icon name="alert" size={13} />}
        </span>
        <span className="board-step-head" data-failed>
          {answer.head || "The board didn't answer."}
        </span>
      </span>
    );
  }
  const cards = /: \d+ columns, (\d+) cards?/.exec(call.output ?? "")?.[1];
  const head = call.name === "read_board"
    ? <>Read the board</>
    : call.name === "list_boards"
    ? <>Looked at {answer.boards.length === 1 ? "the board" : `${answer.boards.length} boards`}</>
    : <>{said(call.name === "create_board" ? "Made a board" : answer.head)}</>;
  return (
    <span className="board-step">
      {style}
      <span className="board-step-mark">
        <Glyph name="board" size={13} />
      </span>
      <span className="board-step-head">
        {head} {answer.boards.slice(0, 3).map((b) => link(b, answer.card))}
        {cards && call.name === "read_board"
          ? <span className="board-step-note">· {cards} card{cards === "1" ? "" : "s"}</span>
          : null}
      </span>
    </span>
  );
};
