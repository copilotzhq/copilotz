/**
 * A space's boards (kind `boards.tab`: spaces' Board tab, item `{ _id }`,
 * hints `{ in, mode }`). With none, what a board is for, and one made in a
 * click; with one, the board itself, inline; with several, each with how
 * its work stands (a bar of its columns), opening its page, and those
 * archived apart. Beside a chat (`mode: "panel"`), compact: the board, or a
 * choice of boards and the one chosen.
 */
import { type ReactNode, useState } from "react";
import type { ViewContext } from "copilotz";
import {
  Button,
  EmptyState,
  LazyView,
  message,
  Notice,
  Select,
  Skeleton,
  Time,
} from "copilotz/web";
import type { Board, Card } from "../../contract.ts";
import { boardPath } from "../../contract.ts";
import { DEFAULT_COLUMNS, stageOf } from "../../shared/columns.ts";
import { NewBoard } from "./board-head.tsx";
import { Glyph, StageMark } from "./glyphs.tsx";
import { type Place, placeName, placesOf } from "./load.ts";
import { counted } from "./shown.ts";
import { STYLE } from "./style.ts";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

const style = <style href="boards-web" precedence="copilotz">{STYLE}</style>;

const byMade = (boards: Board[]) => [...boards].sort((a, b) => a.at.localeCompare(b.at));

/** What the empty tab says about agents: the app's `boardsText.agentHint`, else this. */
const hintOf = (ctx: ViewContext<ReactNode>): string =>
  (ctx.resources.boardsText as { agentHint?: string } | undefined)?.agentHint ??
    "Agents read boards too: ask one to set it up, or to move a card for you.";

export const boardsTabView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const space = item._id ?? (typeof ctx.hints.in === "string" ? ctx.hints.in : "");
  const compact = ctx.hints.mode === "panel";
  const boards = ctx.db.collection<Board>("board").find({ in: space }).value;
  const places = placesOf(ctx);
  if (!boards || !places) {
    return (
      <div className="boards" aria-busy="true">
        {style}
        <Skeleton height={compact ? 40 : 34} width="50%" />
        <div className="board-loading-columns">
          {[0, 1, 2].map((i) => <Skeleton key={i} height={compact ? 120 : 260} radius="xl" />)}
        </div>
      </div>
    );
  }
  const place = places.find((p) => p._id === space);
  const can = !!place?.can?.includes("write") && !place.archived;
  const active = byMade(boards.filter((b) => !b.archived));
  const archived = byMade(boards.filter((b) => b.archived));
  if (active.length === 1) {
    const board = ctx.show("board.inline", { _id: active[0]._id }, {
      in: space,
      mode: compact ? "panel" : "inline",
    });
    if (!archived.length || compact) return board;
    // Its archived boards stay within reach, folded under it.
    return (
      <div className="boards">
        {style}
        {board}
        <Archived boards={archived} space={space} />
      </div>
    );
  }
  // The cards of several boards, for how each stands (only when there are several to list).
  const cards = active.length > 1 && !compact
    ? ctx.db.collection<Card>("card").find({ in: space }).value
    : [];
  return (
    <div className={`boards${compact ? " boards-compact" : ""}`}>
      {style}
      <Boards
        space={space}
        place={place}
        can={can}
        active={active}
        archived={archived}
        cards={cards}
        compact={compact}
        call={ctx.call}
        hint={hintOf(ctx)}
      />
    </div>
  );
};

function Boards(
  { space, place, can, active, archived, cards, compact, call, hint }: {
    hint: string;
    space: string;
    place?: Place;
    can: boolean;
    active: Board[];
    archived: Board[];
    cards?: Card[];
    compact: boolean;
    call: Call;
  },
): ReactNode {
  const [making, setMaking] = useState(false);
  const [chosen, setChosen] = useState<string>();
  const where = placeName(place);
  const form = making
    ? (
      <NewBoard
        space={space}
        where={where}
        onClose={() => setMaking(false)}
        call={call}
        open={!compact && active.length > 0}
      />
    )
    : null;
  if (!active.length) {
    return (
      <>
        <Empty
          space={space}
          where={where}
          can={can}
          compact={compact}
          call={call}
          hint={hint}
        />
        {archived.length ? <Archived boards={archived} space={space} /> : null}
        {form}
      </>
    );
  }
  if (compact) {
    const shown = active.find((b) => b._id === chosen) ?? active[0];
    return (
      <>
        {active.length > 1
          ? (
            <div className="boards-head">
              <Select
                size="sm"
                aria-label="Which board"
                value={shown._id}
                onChange={(event) => setChosen(event.target.value)}
              >
                {active.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
              </Select>
            </div>
          )
          : null}
        <LazyView
          kind="board.inline"
          item={{ _id: shown._id }}
          hints={{ in: space, mode: "panel" }}
          fallback={<Skeleton height={160} radius="xl" />}
        />
        {form}
      </>
    );
  }
  return (
    <>
      <div className="boards-head">
        <p className="boards-intro">
          Where the work in {where}{" "}
          stands: one real outcome per card, with its owner and an honest column. Agents here read
          and keep these too.
        </p>
        {can
          ? <Button variant="primary" icon="plus" onClick={() => setMaking(true)}>New board</Button>
          : null}
      </div>
      <ul className="boards-list">
        {active.map((b) => <BoardItem key={b._id} board={b} space={space} cards={cards} />)}
      </ul>
      {archived.length ? <Archived boards={archived} space={space} /> : null}
      {form}
    </>
  );
}

/** A board in a space's list: its name, what it's for, how its work stands, when it last changed. */
function BoardItem(
  { board, space, cards }: { board: Board; space: string; cards?: Card[] },
): ReactNode {
  const mine = (cards ?? []).filter((c) => c.board === board._id);
  const latest = [board.updated ?? board.at, ...mine.map((c) => c.updated ?? c.at)].sort().at(-1)!;
  const stages = board.columns.map((c) => ({
    column: c,
    n: mine.filter((card) => card.column === c.id).length,
  })).filter((s) => s.n);
  const done = stages.filter((s) => stageOf(s.column) === "done").reduce((n, s) => n + s.n, 0);
  return (
    <li>
      <a className="boards-item" href={boardPath(board._id, space)}>
        <span className="boards-item-name">
          <Glyph name="board" size={17} />
          <span>{board.name}</span>
        </span>
        {board.description ? <p className="boards-item-about">{board.description}</p> : null}
        {mine.length
          ? (
            <span
              className="boards-bar"
              role="img"
              aria-label={stages.map((s) => `${s.column.name} ${s.n}`).join(", ")}
            >
              {stages.map((s) => (
                <span key={s.column.id} data-stage={stageOf(s.column)} style={{ flex: s.n }} />
              ))}
            </span>
          )
          : null}
        <span className="boards-item-meta">
          <span>{mine.length ? counted(mine.length) : "No cards yet"}</span>
          {mine.length ? <span>· {done} done</span> : null}
          <span>
            · <Time at={latest} />
          </span>
        </span>
      </a>
    </li>
  );
}

function Archived({ boards, space }: { boards: Board[]; space: string }): ReactNode {
  return (
    <details className="boards-archived">
      <summary>Archived ({boards.length})</summary>
      <ul className="boards-list">
        {boards.map((b) => <BoardItem key={b._id} board={b} space={space} />)}
      </ul>
    </details>
  );
}

/** No board yet: what one is for, and one made in a click (renamed in place after). */
function Empty(
  { space, where, can, compact, call, hint }: {
    hint: string;
    space: string;
    where: string;
    can: boolean;
    compact: boolean;
    call: Call;
  },
): ReactNode {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const make = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await call("board.create", {
        in: space,
        name: where === "Personal" ? "My board" : `${where} board`,
      });
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };
  return (
    <div className="boards-empty">
      <EmptyState
        icon="check-circle"
        tone="primary"
        title="Keep the work on a board"
        action={can
          ? (
            <Button variant="primary" icon="plus" loading={busy} onClick={() => void make()}>
              Make a board
            </Button>
          )
          : null}
      >
        One real outcome per card, with its owner, an honest column, and any blocker. Agents here
        read it before they act and move cards as the work moves.{" "}
        {can ? "" : `Editors of ${where} make boards here.`}
      </EmptyState>
      {error ? <Notice tone="destructive" role="alert">{error}</Notice> : null}
      {compact ? null : (
        <>
          <div className="boards-preview" aria-hidden="true">
            {DEFAULT_COLUMNS.map((c, i) => (
              <div key={c.id} className="boards-preview-column">
                <b>
                  <StageMark stage={stageOf(c)} size={12} />
                  {c.name}
                </b>
                {Array.from(
                  { length: [2, 3, 2, 1, 1, 2][i] },
                  (_, n) => <span key={n} className="boards-preview-card" />,
                )}
              </div>
            ))}
          </div>
          <ol className="boards-teach" aria-label="How a board works">
            <li>
              <b>One outcome per card</b>
              <span>Something real that will be done, not a process step.</span>
            </li>
            <li>
              <b>An owner, an honest column</b>
              <span>A person or an agent; moved when the state changes.</span>
            </li>
            <li>
              <b>Read by agents too</b>
              <span>{hint}</span>
            </li>
          </ol>
        </>
      )}
    </div>
  );
}
