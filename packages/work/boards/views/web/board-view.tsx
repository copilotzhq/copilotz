/**
 * A board, drawn: its filters, then its columns side by side (stacked in a
 * side panel), each with its cards in order. Cards drag within and across
 * columns (drag.ts): the others glide aside, a slot shows where it lands,
 * and the move shows at once while it's on its way. With the keyboard, the
 * arrows go from card to card; Space picks one up, the arrows carry it,
 * Space puts it down and Escape puts it back, each step said aloud. A card
 * opens its details; "New card" makes one in full; a column's foot adds one
 * by its title. Everything follows the board live, as others change it.
 */
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  Button,
  type MenuItem,
  message,
  Notice,
  openPalette,
  type PaletteStep,
} from "copilotz/web";
import type { Board, Card, Column, Place } from "../../contract.ts";
import { todayOf } from "../../shared/dates.ts";
import { byOrder, indexOf, orderAt } from "../../shared/order.ts";
import { CardSheet, Sheet } from "./card-sheet.tsx";
import { CardTile } from "./card-tile.tsx";
import { ColumnView, NewColumn } from "./column.tsx";
import { type Preview, useCardDrag } from "./drag.ts";
import {
  byColumn,
  type Filters,
  isDone,
  kept,
  labelsOn,
  type Names,
  NO_FILTERS,
  type Pending,
  type Someone,
  someoneOf,
  type Team,
} from "./shown.ts";
import { Toolbar } from "./toolbar.tsx";

type Call = <R = unknown>(action: string, input?: unknown) => Promise<R>;

/** How long a move may show where it's going before the board must say it's there. */
const PENDING_MS = 6000;

export type BoardProps = {
  board: Board;
  cards: Card[];
  /** The space's people and agents (and anyone cards already have). */
  people: Someone[];
  team?: Team;
  /** People's names by id (their profiles'), for those cards name. */
  names?: Names;
  me?: string;
  /** Whether the viewer may change it (an editor of its space). */
  can: boolean;
  /** On its page, inline in a space's tab, or compact beside a chat. */
  mode: "page" | "inline" | "panel";
  /** Where the person works, for links. */
  space?: string;
  call: Call;
  /** A card the address asks to open (`?card=`). */
  opened?: string;
  /** The board's own column to add (its menu's "Add a column"). */
  addingColumn?: boolean;
  onAddingColumn?(open: boolean): void;
  /** What goes over the filters: the board's name, inline. */
  head?: ReactNode;
};

export function BoardView(props: BoardProps): ReactNode {
  const { board, cards, people, team, names, me, can, mode, space, call } = props;
  const compact = mode === "panel";
  const root = useRef<HTMLDivElement>(null);
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [pending, setPending] = useState<Pending & Record<string, { since?: number }>>({});
  const [held, setHeld] = useState<Preview>();
  const [open, setOpen] = useState<string | undefined>(props.opened);
  const [making, setMaking] = useState<string>();
  const [adding, setAdding] = useState<string>();
  const [ownColumn, setOwnColumn] = useState(false);
  const [folded, setFolded] = useState<Record<string, boolean>>(() =>
    compact ? Object.fromEntries(board.columns.filter(isDone).map((c) => [c.id, true])) : {}
  );
  const [said, setSaid] = useState("");
  const [error, setError] = useState<string>();
  const today = todayOf();
  const addingColumn = props.addingColumn ?? ownColumn;
  const setAddingColumn = props.onAddingColumn ?? setOwnColumn;

  // A card asked for by the address opens; one deleted meanwhile closes.
  useEffect(() => {
    if (props.opened) setOpen(props.opened);
  }, [props.opened]);
  const openCard = open ? cards.find((c) => c._id === open) : undefined;
  useEffect(() => {
    if (open && !openCard && cards.length) setOpen(undefined);
  }, [open, !!openCard]);

  // Moves on their way end once the board says the card is there (or after a while).
  const latest = useRef(cards);
  latest.current = cards;
  const settle = (id: string, at?: { column: string; order: number }) =>
    setPending((all) => {
      const card = latest.current.find((c) => c._id === id);
      const there = !at || !card || (card.column === at.column && card.order === at.order);
      const next = { ...all };
      if (there) delete next[id];
      else next[id] = { ...at, since: Date.now() };
      return next;
    });
  useEffect(() => {
    const now = Date.now();
    const settled = Object.entries(pending).filter(([id, p]) => {
      const card = cards.find((c) => c._id === id);
      return !card || (card.column === p.column && card.order === p.order) ||
        now - (p.since ?? now) > PENDING_MS;
    });
    if (settled.length) {
      setPending((all) => {
        const next = { ...all };
        for (const [id] of settled) delete next[id];
        return next;
      });
    }
  }, [cards]);

  const who = (key: string) => people.find((p) => p.key === key) ?? someoneOf(key, team, me, names);
  const columns = byColumn(board, cards, pending);
  const visible = (column: string) =>
    (columns.get(column) ?? []).filter((c) => kept(c, filters, (k) => who(k).name));
  const shownCount = board.columns.reduce((n, c) => n + visible(c.id).length, 0);

  /** Where a card dropped at `index` among a column's shown cards goes: next to its neighbours. */
  const placeOf = (card: string, column: string, index: number): Place => {
    const shown = visible(column).filter((c) => c._id !== card);
    if (index < shown.length) return { before: shown[index]._id };
    return shown.length ? { after: shown[shown.length - 1]._id } : { at: "bottom" };
  };

  /** Moves a card: shown there at once, then the board's move; said aloud. */
  const move = async (cardId: string, column: string, place: Place) => {
    const card = cards.find((c) => c._id === cardId);
    if (!card || !can) return;
    const others = byOrder((columns.get(column) ?? []).filter((c) => c._id !== cardId));
    const { order } = orderAt(others, indexOf(others, place));
    setPending((all) => ({ ...all, [cardId]: { column, order, since: Date.now() } }));
    const name = board.columns.find((c) => c.id === column)?.name ?? column;
    try {
      const done = await call<{ column: string; order: number }>("card.move", {
        card: cardId,
        column,
        ...place,
      });
      settle(cardId, { column: done.column, order: done.order });
      setTimeout(() => settle(cardId), PENDING_MS);
      setSaid(`Moved “${card.title}” to ${name}.`);
    } catch (e) {
      settle(cardId);
      setError(message(e));
    }
  };

  const drop = (cardId: string, column: string, index: number) => {
    const card = cards.find((c) => c._id === cardId);
    if (!card) return;
    const where = visible(column);
    const at = where.findIndex((c) => c._id === cardId);
    // Put back where it was: nothing to do.
    if (at >= 0 && (index === at || (index === Infinity && at === where.length - 1))) return;
    void move(cardId, column, placeOf(cardId, column, index));
  };

  const drag = useCardDrag({ root, enabled: can, onDrop: drop });
  const preview = drag.preview ?? held;

  // Cards glide to where they now are, when a slot opens or the board changes under them.
  const was = useRef(new Map<string, { list: string; top: number }>());
  useLayoutEffect(() => {
    const box = root.current;
    if (!box) return;
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const now = new Map<string, { list: string; top: number }>();
    const gliding: HTMLElement[] = [];
    for (const el of box.querySelectorAll<HTMLElement>("[data-card]:not([data-lifted])")) {
      const at = { list: el.parentElement?.dataset.list ?? "", top: el.offsetTop };
      now.set(el.dataset.card!, at);
      const before = was.current.get(el.dataset.card!);
      const by = before && before.list === at.list ? before.top - at.top : 0;
      if (!still && by && Math.abs(by) < 1600) {
        el.style.transition = "none";
        el.style.transform = `translateY(${by}px)`;
        gliding.push(el);
      }
    }
    was.current = now;
    if (!gliding.length) return;
    void box.offsetHeight;
    for (const el of gliding) {
      el.style.transition = "transform .2s cubic-bezier(.2, .8, .2, 1)";
      el.style.transform = "";
      el.addEventListener("transitionend", () => (el.style.transition = ""), { once: true });
    }
  });

  // A card carried by the keyboard keeps the focus as it goes.
  useLayoutEffect(() => {
    if (held) document.getElementById(`card-${held.card}`)?.focus();
  }, [held?.column, held?.index]);

  const columnOf = (id: string) => board.columns.findIndex((c) => c.id === id);

  const keys = (event: KeyboardEvent<HTMLElement>, card: Card, column: string) => {
    const list = visible(column);
    const at = list.findIndex((c) => c._id === card._id);
    const step = (id: string) => document.getElementById(`card-${id}`)?.focus();
    if (held?.card === card._id) {
      const others = (c: string) => visible(c).filter((x) => x._id !== card._id).length;
      const go = (to: string, index: number) => {
        const name = board.columns.find((c) => c.id === to)?.name ?? to;
        setHeld({ ...held, column: to, index });
        setSaid(`${name}, position ${index + 1} of ${others(to) + 1}.`);
      };
      const ci = columnOf(held.column);
      const sideways = (by: number) => {
        const next = board.columns[ci + by];
        if (next) go(next.id, Math.min(held.index, others(next.id)));
      };
      const moves: Record<string, () => void> = {
        ArrowUp: () => held.index > 0 && go(held.column, held.index - 1),
        ArrowDown: () => held.index < others(held.column) && go(held.column, held.index + 1),
        ArrowLeft: () => sideways(-1),
        ArrowRight: () => sideways(1),
        " ": () => {
          setHeld(undefined);
          drop(card._id, held.column, held.index);
        },
        Enter: () => {
          setHeld(undefined);
          drop(card._id, held.column, held.index);
        },
        Escape: () => {
          setHeld(undefined);
          setSaid(`“${card.title}” is back where it was.`);
          requestAnimationFrame(() => step(card._id));
        },
      };
      if (event.key === "Tab") {
        setHeld(undefined);
        return;
      }
      if (moves[event.key]) {
        event.preventDefault();
        event.stopPropagation();
        moves[event.key]();
      }
      return;
    }
    if (event.key === " " && can) {
      event.preventDefault();
      const height = (event.currentTarget.parentElement as HTMLElement).offsetHeight;
      setHeld({ card: card._id, column, index: at, height, by: "keyboard" });
      setSaid(
        `Picked up “${card.title}”. Arrows move it, Space puts it down, Escape puts it back.`,
      );
      return;
    }
    const ci = columnOf(column);
    const sideways = (by: number) => {
      for (let i = ci + by; i >= 0 && i < board.columns.length; i += by) {
        const there = visible(board.columns[i].id);
        if (there.length) return step(there[Math.min(Math.max(at, 0), there.length - 1)]._id);
      }
    };
    const moves: Record<string, () => void> = {
      ArrowUp: () => list[at - 1] && step(list[at - 1]._id),
      ArrowDown: () => list[at + 1] && step(list[at + 1]._id),
      ArrowLeft: () => sideways(-1),
      ArrowRight: () => sideways(1),
    };
    if (moves[event.key]) {
      event.preventDefault();
      moves[event.key]();
    }
  };

  /** "Move to…": the board's columns, in the command palette. */
  const moveStep = (card: Card): PaletteStep => ({
    title: `Move “${card.title.length > 40 ? `${card.title.slice(0, 39)}…` : card.title}” to…`,
    placeholder: "Find a column",
    items: () => [{
      title: "",
      items: board.columns.map((c) => ({
        key: `board:move:${c.id}`,
        label: c.name,
        icon: c.id === card.column ? "check" as const : "chevron" as const,
        description: c.id === card.column ? "Where it is" : undefined,
        disabled: c.id === card.column,
        run: () => move(card._id, c.id, { at: "bottom" }),
      })),
    }],
  });

  const menuOf = (card: Card): (MenuItem | "separator")[] => [
    { label: "Open", icon: "external", onSelect: () => setOpen(card._id) },
    ...(can
      ? [
        { label: "Move to…", icon: "move" as const, onSelect: () => openPalette(moveStep(card)) },
        {
          label: "Move to the top",
          icon: "send" as const,
          onSelect: () => void move(card._id, card.column, { at: "top" }),
        },
        {
          label: "Move to the bottom",
          icon: "down" as const,
          onSelect: () => void move(card._id, card.column, { at: "bottom" }),
        },
        ...(me && card.assignee !== `person:${me}`
          ? [{
            label: "Take it",
            icon: "person" as const,
            onSelect: () =>
              void call("card.update", { card: card._id, assignee: `person:${me}` }).catch((e) =>
                setError(message(e))
              ),
          }]
          : []),
        "separator" as const,
        {
          label: "Delete",
          icon: "trash" as const,
          tone: "destructive" as const,
          onSelect: () =>
            void call("card.delete", { card: card._id }).catch((e) => setError(message(e))),
        },
      ]
      : []),
  ];

  const changeColumns = (next: { id?: string; name: string }[], into?: string) =>
    call("board.update", { board: board._id, columns: next, ...(into ? { into } : {}) });

  const help = `board-help-${board._id}`;

  const list = (column: Column) => {
    const shown = visible(column.id);
    const carried = preview?.by === "keyboard"
      ? cards.find((c) => c._id === preview.card)
      : undefined;
    const items: ReactNode[] = [];
    const tile = (card: Card, extra: { lifted?: boolean; held?: boolean } = {}) => (
      <CardTile
        key={card._id}
        card={card}
        done={isDone(column)}
        today={today}
        owner={card.assignee ? who(card.assignee) : undefined}
        lifted={extra.lifted}
        held={extra.held}
        busy={!!pending[card._id] && !extra.held}
        menu={menuOf(card)}
        describedBy={can ? help : undefined}
        onOpen={() => {
          if (drag.justDragged() || held) return;
          setOpen(card._id);
        }}
        onPress={(event) => drag.press(event, card._id, column.id)}
        onKeys={(event) => keys(event, card, extra.held ? preview!.column : column.id)}
      />
    );
    const landing = () =>
      preview?.by === "pointer"
        ? (
          <li
            key="slot"
            className="board-slot"
            data-slot
            aria-hidden="true"
            style={{ height: preview.height }}
          />
        )
        : carried
        ? tile(carried, { held: true })
        : null;
    let k = 0;
    const here = preview && preview.column === column.id;
    for (const card of shown) {
      if (carried && card._id === carried._id) continue;
      const lifted = preview?.by === "pointer" && card._id === preview.card;
      if (here && !lifted && k === preview.index) items.push(landing());
      items.push(tile(card, { lifted }));
      if (!lifted) k++;
    }
    if (here && k <= preview.index) items.push(landing());
    return (
      <ul
        className="board-list"
        data-list={column.id}
        data-folded={compact && folded[column.id] ? "" : undefined}
        aria-label={`${column.name}'s cards`}
      >
        {items}
      </ul>
    );
  };

  return (
    <div className="board" data-mode={mode} ref={root}>
      {props.head}
      <Toolbar
        cards={cards}
        people={people}
        filters={filters}
        onFilters={setFilters}
        shown={shownCount}
        can={can}
        compact={compact}
        onNew={() => setMaking(board.columns[0]?.id)}
      />
      {error
        ? (
          <Notice
            tone="destructive"
            role="alert"
            title="That didn't work"
            action={
              <Button size="sm" variant="ghost" onClick={() => setError(undefined)}>Dismiss</Button>
            }
          >
            {error}
          </Notice>
        )
        : null}
      <div className="board-scroller" data-scroller>
        {board.columns.map((column, i) => {
          const total = (columns.get(column.id) ?? []).length;
          return (
            <ColumnView
              key={column.id}
              column={column}
              index={i}
              columns={board.columns}
              total={total}
              shown={visible(column.id).length}
              can={can}
              compact={compact}
              over={preview?.by === "pointer" && preview.column === column.id}
              folded={compact && !!folded[column.id]}
              onFold={() => setFolded((f) => ({ ...f, [column.id]: !f[column.id] }))}
              adding={adding === column.id}
              onAdding={(on) => {
                setAdding(on ? column.id : undefined);
                if (on) setFolded((f) => ({ ...f, [column.id]: false }));
              }}
              onAdd={async (title) => {
                await call("card.create", { board: board._id, title, column: column.id });
                setSaid(`Added “${title}” to ${column.name}.`);
              }}
              onChange={(next) => changeColumns(next)}
              onRemove={(into) =>
                changeColumns(board.columns.filter((c) => c.id !== column.id), into)}
            >
              {list(column)}
            </ColumnView>
          );
        })}
        {can
          ? (
            <NewColumn
              open={addingColumn}
              onOpen={setAddingColumn}
              onAdd={async (name) => {
                await changeColumns([...board.columns, { name }]);
                setSaid(`Added the column ${name}.`);
              }}
            />
          )
          : null}
      </div>
      <p id={help} hidden>
        Enter opens it. Space picks it up to move it with the arrow keys.
      </p>
      <p className="board-sr" aria-live="assertive">{said}</p>
      {openCard
        ? (
          <Sheet open onClose={() => setOpen(undefined)} label={openCard.title}>
            <CardSheet
              key={openCard._id}
              board={board}
              card={openCard}
              people={people}
              team={team}
              names={names}
              me={me}
              labels={labelsOn(cards).map((l) => l.label)}
              today={today}
              can={can}
              space={space}
              call={call}
              onClose={() => setOpen(undefined)}
              onMove={(card, column, at) => move(card._id, column, { at: at ?? "bottom" })}
            />
          </Sheet>
        )
        : null}
      {making
        ? (
          <Sheet open onClose={() => setMaking(undefined)} label={`New card on ${board.name}`}>
            <CardSheet
              board={board}
              column={making}
              people={people}
              team={team}
              names={names}
              me={me}
              labels={labelsOn(cards).map((l) => l.label)}
              today={today}
              can={can}
              space={space}
              call={call}
              onClose={() => setMaking(undefined)}
              onMove={async () => {}}
            />
          </Sheet>
        )
        : null}
    </div>
  );
}
