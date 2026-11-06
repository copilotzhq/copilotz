/// <reference lib="dom" />
/**
 * Dragging cards with pointer events, so a mouse, a pen and a finger all
 * work, with no library. A mouse drag starts once the pointer moves a few
 * pixels; a finger's after a short press that stays put, so a swipe still
 * scrolls the board. The card lifts into a copy that follows the pointer,
 * and a slot opens where it would land: the column under the pointer (or
 * the nearest), above the first card whose middle is below it. Near an edge
 * the columns scroll sideways, a column's cards up and down, and the page
 * too. Letting go settles the copy into the slot, then hands the move over
 * (`onDrop`); Escape puts it back. The board shows the slot (`preview`).
 *
 * The board marks its parts: the row of columns `data-scroller`, a column
 * `data-column`, its cards' list `data-list="<column id>"` (positioned, so
 * cards measure from it), a card `data-card="<id>"`, the slot `data-slot`.
 */
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";

/** Where a lifted card would land: its column, and its place among the cards shown there. */
export type Preview = {
  card: string;
  column: string;
  index: number;
  /** The slot's height: the card's own. */
  height: number;
  by: "pointer" | "keyboard";
};

type Pressed = {
  card: string;
  column: string;
  pointer: number;
  touch: boolean;
  x: number;
  y: number;
  element: HTMLElement;
  timer?: ReturnType<typeof setTimeout>;
  started: boolean;
  ghost?: HTMLElement;
  /** Where the card was grabbed, from its corner. */
  dx: number;
  dy: number;
  /** The card's height when lifted: its slot's. */
  height: number;
  at: { x: number; y: number };
};

const MOUSE_SLOP = 4;
const TOUCH_SLOP = 10;
const TOUCH_DELAY = 220;
/** How near an edge scrolling starts, and how fast it goes there. */
const EDGE = 64;
const SPEED = 20;
const SETTLE_MS = 170;

/** The column under (or nearest) a point, and the place there: above the first card whose middle is below it. */
function targetAt(
  root: HTMLElement,
  x: number,
  y: number,
): { column: string; index: number } | undefined {
  const lists = [...root.querySelectorAll<HTMLElement>("[data-list]")];
  let best: HTMLElement | undefined;
  let nearest = Infinity;
  for (const list of lists) {
    const box = (list.closest("[data-column]") ?? list).getBoundingClientRect();
    const dx = x < box.left ? box.left - x : x > box.right ? x - box.right : 0;
    const dy = y < box.top ? box.top - y : y > box.bottom ? y - box.bottom : 0;
    const distance = dx * dx + dy * dy;
    if (distance < nearest) {
      nearest = distance;
      best = list;
    }
  }
  if (!best) return undefined;
  const column = best.dataset.list!;
  if (best.dataset.folded !== undefined) return { column, index: Infinity };
  const box = best.getBoundingClientRect();
  const top = box.top + best.clientTop - best.scrollTop;
  // Layout positions, not where cards are drawn while they glide aside.
  const cards = [...best.querySelectorAll<HTMLElement>(":scope > [data-card]:not([data-lifted])")];
  const index = cards.filter((c) => top + c.offsetTop + c.offsetHeight / 2 < y).length;
  return { column, index };
}

/** The nearest ancestor that scrolls up and down. */
function scrollerOf(element: HTMLElement | null): HTMLElement | undefined {
  for (let at = element?.parentElement; at; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    if (/(auto|scroll)/.test(overflowY) && at.scrollHeight > at.clientHeight) return at;
  }
  return undefined;
}

/** How far to scroll this frame, at `distance` from an edge. */
const pace = (distance: number) =>
  distance < EDGE ? Math.ceil(((EDGE - Math.max(distance, 0)) / EDGE) * SPEED) : 0;

export function useCardDrag(
  { root, enabled, onDrop }: {
    root: RefObject<HTMLElement | null>;
    enabled: boolean;
    /** The card let go of, its column, and its place among the cards shown there (`Infinity`: the bottom). */
    onDrop(card: string, column: string, index: number): void;
  },
) {
  const [preview, setPreview] = useState<Preview>();
  const latest = useRef({ enabled, onDrop });
  latest.current = { enabled, onDrop };
  // Made once: the listeners it adds are the ones it takes away.
  const [drag] = useState(() => dragging(root, setPreview, () => latest.current));
  useEffect(() => drag.finish, [drag]);
  return {
    preview,
    press: drag.press,
    /** Whether a drag just ended: the click that ends it doesn't open the card. */
    justDragged: drag.justDragged,
  };
}

/** The drag's machinery, made once per board: its state is refs, not React's. */
function dragging(
  root: RefObject<HTMLElement | null>,
  setPreview: (preview: Preview | undefined) => void,
  current: () => { enabled: boolean; onDrop(card: string, column: string, index: number): void },
) {
  let pressed: Pressed | undefined;
  let shown: Preview | undefined;
  let frame: number | undefined;
  let ended = 0;

  const show = (next: Preview | undefined) => {
    const was = shown;
    if (
      was === next ||
      (was && next && was.card === next.card && was.column === next.column &&
        was.index === next.index)
    ) return;
    shown = next;
    setPreview(next);
  };

  const follow = (p: Pressed, x: number, y: number) => {
    p.at = { x, y };
    if (p.ghost) p.ghost.style.translate = `${x - p.dx}px ${y - p.dy}px`;
    const target = root.current ? targetAt(root.current, x, y) : undefined;
    if (target) show({ ...target, card: p.card, height: p.height, by: "pointer" });
  };

  /** Scrolls what the pointer is near the edge of, every frame while dragging. */
  const scroll = () => {
    const p = pressed;
    const board = root.current;
    if (!p?.started || !board) return;
    const { x, y } = p.at;
    let moved = false;
    const row = board.querySelector<HTMLElement>("[data-scroller]");
    if (row && row.scrollWidth > row.clientWidth) {
      const box = row.getBoundingClientRect();
      const by = pace(x - box.left) ? -pace(x - box.left) : pace(box.right - x);
      if (by && y > box.top - EDGE && y < box.bottom + EDGE) {
        const before = row.scrollLeft;
        row.scrollLeft += by;
        moved ||= row.scrollLeft !== before;
      }
    }
    const list = shown
      ? board.querySelector<HTMLElement>(`[data-list="${CSS.escape(shown.column)}"]`)
      : null;
    for (const area of [list, scrollerOf(board)]) {
      if (!area || area.scrollHeight <= area.clientHeight) continue;
      const box = area.getBoundingClientRect();
      const top = Math.max(box.top, 0);
      const bottom = Math.min(box.bottom, innerHeight);
      const by = pace(y - top) ? -pace(y - top) : pace(bottom - y);
      if (!by) continue;
      const before = area.scrollTop;
      area.scrollTop += by;
      if (area.scrollTop !== before) {
        moved = true;
        break;
      }
    }
    if (moved) follow(p, x, y);
    frame = requestAnimationFrame(scroll);
  };

  const lift = (p: Pressed) => {
    p.started = true;
    const box = p.element.getBoundingClientRect();
    p.dx = p.x - box.left;
    p.dy = p.y - box.top;
    p.height = box.height;
    const ghost = p.element.cloneNode(true) as HTMLElement;
    ghost.removeAttribute("data-card");
    for (const named of [ghost, ...ghost.querySelectorAll("[id]")]) named.removeAttribute("id");
    ghost.setAttribute("aria-hidden", "true");
    ghost.classList.add("board-ghost");
    Object.assign(ghost.style, {
      width: `${box.width}px`,
      height: `${box.height}px`,
      translate: `${box.left}px ${box.top}px`,
    });
    document.body.append(ghost);
    p.ghost = ghost;
    document.documentElement.dataset.boardDragging = "";
    if (p.touch) navigator.vibrate?.(8);
    follow(p, p.x, p.y);
    frame = requestAnimationFrame(scroll);
  };

  const finish = () => {
    const p = pressed;
    if (p?.timer) clearTimeout(p.timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
    frame = undefined;
    p?.ghost?.remove();
    if (p?.started) ended = performance.now();
    pressed = undefined;
    delete document.documentElement.dataset.boardDragging;
    removeEventListener("pointermove", moved);
    removeEventListener("pointerup", released);
    removeEventListener("pointercancel", cancelled);
    removeEventListener("keydown", escaped, true);
    document.removeEventListener("touchmove", held);
    show(undefined);
  };

  function moved(event: PointerEvent) {
    const p = pressed;
    if (!p || event.pointerId !== p.pointer) return;
    if (!p.started) {
      const far = Math.hypot(event.clientX - p.x, event.clientY - p.y);
      // A finger that moves before the press settles is scrolling, not dragging.
      if (p.touch) {
        if (far > TOUCH_SLOP) finish();
        return;
      }
      if (far < MOUSE_SLOP) return;
      lift(p);
    }
    event.preventDefault();
    follow(p, event.clientX, event.clientY);
  }

  function released(event: PointerEvent) {
    const p = pressed;
    if (!p || event.pointerId !== p.pointer) return;
    if (!p.started) return finish();
    follow(p, event.clientX, event.clientY);
    const target = shown;
    const slot = root.current?.querySelector<HTMLElement>("[data-slot]");
    const ghost = p.ghost;
    removeEventListener("pointermove", moved);
    if (!target || !slot || !ghost || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (target) current().onDrop(p.card, target.column, target.index);
      return finish();
    }
    // Settle into the slot, then hand the move over.
    const box = slot.getBoundingClientRect();
    ghost.classList.add("board-ghost-settling");
    ghost.style.translate = `${box.left}px ${box.top}px`;
    ghost.style.width = `${box.width}px`;
    p.timer = setTimeout(() => {
      current().onDrop(p.card, target.column, target.index);
      finish();
    }, SETTLE_MS);
  }

  function cancelled(event: PointerEvent) {
    if (pressed && event.pointerId === pressed.pointer) finish();
  }

  function escaped(event: KeyboardEvent) {
    if (event.key !== "Escape" || !pressed?.started) return;
    event.preventDefault();
    event.stopPropagation();
    finish();
  }

  // While a finger drags, the page mustn't scroll under it.
  function held(event: TouchEvent) {
    if (pressed?.started && event.cancelable) event.preventDefault();
  }

  /** On a card's pointerdown: starts watching for a drag. */
  const press = (event: ReactPointerEvent<HTMLElement>, card: string, column: string) => {
    if (!current().enabled || pressed || event.button !== 0 || !event.isPrimary) return;
    if ((event.target as HTMLElement).closest("[data-no-drag], input, textarea, select, a")) return;
    const p: Pressed = {
      card,
      column,
      pointer: event.pointerId,
      touch: event.pointerType !== "mouse",
      x: event.clientX,
      y: event.clientY,
      element: event.currentTarget,
      started: false,
      dx: 0,
      dy: 0,
      height: 0,
      at: { x: event.clientX, y: event.clientY },
    };
    pressed = p;
    addEventListener("pointermove", moved, { passive: false });
    addEventListener("pointerup", released);
    addEventListener("pointercancel", cancelled);
    addEventListener("keydown", escaped, true);
    if (p.touch) {
      document.addEventListener("touchmove", held, { passive: false });
      p.timer = setTimeout(() => pressed === p && lift(p), TOUCH_DELAY);
    }
  };

  return { press, finish, justDragged: () => performance.now() - ended < 400 };
}
