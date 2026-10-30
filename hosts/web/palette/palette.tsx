/// <reference lib="dom" />
/**
 * The command palette: a field over a list, in a modal `<dialog>` near the
 * top of the page (the page behind it inert, focus kept in it and given
 * back after). What it lists comes from front ends: each a View that
 * returns groups of items for what's typed and where the person is (its
 * hints, and `search`), observed only while it's open; and the page's own
 * groups. Items go somewhere, do something (an Action), or open a step of
 * their own, a list over this one ("Move to…", then a space), opened from
 * anywhere with `openPalette(step)`.
 *
 * Keyboard first, as a combobox: typing filters, ↑ ↓ (or Ctrl+N, Ctrl+P)
 * move, Enter chooses, Escape goes back a step or closes it, and Backspace
 * in an empty field goes back too. The field keeps focus throughout; the
 * list says which item is active. A step that asks a question (`confirm`)
 * has no field: the list has focus, its first choice ready for Enter. An item that works shows a spinner and
 * keeps the palette open until it's done; one that fails says why, there.
 * An item may show a View in a dialog instead (a form), the palette closed.
 *
 * ```tsx
 * <Palette sources={[{ view: "spaces.palette" }]} hints={{ in: space, path }} />
 * ```
 */
import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { go } from "../host.tsx";
import { LazyView } from "../lazy.tsx";
import { message } from "../part.tsx";
import { Button } from "../toolkit/button.tsx";
import { Dialog } from "../toolkit/dialog.tsx";
import { Icon } from "../toolkit/icon.tsx";
import { IconButton } from "../toolkit/icon-button.tsx";
import { Kbd } from "../toolkit/kbd.tsx";
import { useModal } from "../toolkit/modal.ts";
import { Notice } from "../toolkit/notice.tsx";
import { sheet } from "../toolkit/sheet.tsx";
import { Skeleton } from "../toolkit/skeleton.tsx";
import { groupsOf, listOf } from "./list.ts";
import { Row } from "./row.tsx";
import { useOutputs } from "./sources.ts";
import {
  closePalette,
  type PaletteControl,
  type PaletteDialog,
  type PaletteGroup,
  type PaletteItem,
  paletteState,
  type PaletteStep,
} from "./state.ts";

const SHEET = sheet(
  "palette",
  `
.copilotz-palette { width: min(640px, calc(100vw - 32px)); max-width: none;
  max-height: min(560px, calc(100dvh - 20vh)); margin: 12vh auto auto; padding: 0;
  border: 1px solid var(--border); border-radius: var(--radius-2xl); background: var(--popover);
  color: var(--popover-foreground); box-shadow: var(--shadow-lg); overflow: hidden; }
.copilotz-palette[open] { display: flex; flex-direction: column; animation: copilotz-palette .16s cubic-bezier(.2, .8, .2, 1); }
.copilotz-palette::backdrop { background: rgb(8 8 14 / .4); }
.copilotz-palette[open]::backdrop { animation: copilotz-palette-backdrop .16s ease-out; }
@keyframes copilotz-palette { from { opacity: 0; transform: translateY(-8px) scale(.985); } }
@keyframes copilotz-palette-backdrop { from { opacity: 0; } }
.copilotz-palette-head { flex: none; display: flex; align-items: center; gap: 8px; min-height: 56px;
  padding: 0 12px 0 16px; border-bottom: 1px solid var(--border); }
.copilotz-palette-head > .copilotz-icon { color: var(--muted-foreground); }
.copilotz-palette-head > .copilotz-icon-button { margin-left: -6px; }
.copilotz-palette-step { flex: 0 1 auto; max-width: 48%; overflow: hidden; padding: 4px 10px;
  border-radius: var(--radius-full); background: var(--primary-soft); color: var(--primary-text);
  font-size: 13px; font-weight: 620; line-height: 1.3; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-palette-question { max-width: none; padding: 0; background: transparent; color: var(--foreground);
  font-size: 15.5px; font-weight: 650; }
.copilotz-palette-gap { flex: 1; min-height: 54px; }
.copilotz-palette-list:focus-visible { outline: 0; }
.copilotz-palette-field { flex: 1; min-width: 0; height: 54px; margin: 0; padding: 0; border: 0; outline: 0;
  background: transparent; color: var(--foreground); font-size: 16px; }
.copilotz-palette-field::placeholder { color: var(--muted-foreground); opacity: .9; }
.copilotz-palette-field::-webkit-search-cancel-button { display: none; }
.copilotz-palette-note { flex: none; margin: 0; padding: 10px 18px 2px; color: var(--muted-foreground); font-size: 13px;
  line-height: 1.5; }
.copilotz-palette-error { flex: none; margin: 10px 12px 0; }
.copilotz-palette-list { flex: 1 1 auto; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 6px;
  scroll-padding: 6px; scrollbar-width: thin; scrollbar-color: var(--input) transparent; }
.copilotz-palette-group + .copilotz-palette-group { margin-top: 6px; }
.copilotz-palette-heading { padding: 8px 10px 5px; color: var(--muted-foreground); font-family: var(--font-display);
  font-size: 11.5px; font-weight: 650; letter-spacing: .07em; text-transform: uppercase; }
.copilotz-palette-row { display: flex; align-items: center; gap: 11px; min-height: 42px; padding: 6px 10px;
  border-radius: var(--radius-md); cursor: pointer; user-select: none; }
.copilotz-palette-row[aria-selected=true] { background: var(--accent); color: var(--accent-foreground); }
.copilotz-palette-row[aria-disabled=true] { opacity: .5; cursor: default; }
.copilotz-palette-lead { flex: none; display: grid; place-items: center; width: 28px; height: 28px;
  border-radius: var(--radius-sm); background: var(--muted); color: var(--secondary-foreground);
  transition: background-color .12s; }
.copilotz-palette-lead:has(> .copilotz-avatar) { background: transparent; }
.copilotz-palette-row[aria-selected=true] .copilotz-palette-lead:not(:has(> .copilotz-avatar)) {
  background: var(--background); color: var(--foreground); }
.copilotz-palette-row[data-tone=destructive] :is(.copilotz-palette-label, .copilotz-palette-lead) { color: var(--destructive-text); }
.copilotz-palette-text { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.copilotz-palette-label { flex: 0 1 auto; min-width: 0; overflow: hidden; font-size: 14.5px; text-overflow: ellipsis;
  white-space: nowrap; }
.copilotz-palette-description { flex: 0 10000 auto; min-width: 0; overflow: hidden; color: var(--muted-foreground);
  font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-palette-hit { color: var(--foreground); font-weight: 700; }
.copilotz-palette-end { flex: none; display: flex; align-items: center; min-width: 20px; justify-content: flex-end;
  color: var(--muted-foreground); }
.copilotz-palette-empty { margin: 0; padding: 30px 16px; color: var(--muted-foreground); text-align: center; }
.copilotz-palette-loading { display: grid; gap: 8px; padding: 8px 4px; }
.copilotz-palette-foot { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 16px; padding: 9px 16px;
  border-top: 1px solid var(--border); background: color-mix(in oklab, var(--muted) 40%, var(--popover));
  color: var(--muted-foreground); font-size: 12px; }
.copilotz-palette-foot > span { display: inline-flex; align-items: center; gap: 5px; }
.copilotz-palette-cancel { display: none; }
@media (pointer: coarse) {
  .copilotz-palette-foot, .copilotz-palette-enter, .copilotz-palette-esc { display: none; }
  .copilotz-palette-cancel { display: inline-flex; }
  .copilotz-palette-row { min-height: 48px; }
}
@media (max-width: 640px) {
  .copilotz-palette { width: calc(100vw - 16px); max-height: calc(100dvh - 16px); margin-top: 8px;
    border-radius: var(--radius-xl); }
  .copilotz-palette-step { max-width: 40%; }
}
`,
);

/** Where the palette is: a step, or its first (none), and what's typed there (kept, for going back). */
type Entry = { step?: PaletteStep; search: string };

const entriesOf = (steps: PaletteStep[]): Entry[] =>
  steps.length ? steps.map((step) => ({ step, search: step.value ?? "" })) : [{ search: "" }];

const thenable = (value: unknown): value is PromiseLike<unknown> =>
  !!value && typeof (value as PromiseLike<unknown>).then === "function";

export function Palette(
  { sources, hints, own = [], placeholder = "Search, or type a command" }: {
    /** Front ends' lists: Views that return groups for what's typed (the `palette` resource). */
    sources: { view: string }[];
    /** Where the person is, for every View it shows; `search`, what's typed, is added. */
    hints: Record<string, unknown>;
    /** The page's own groups, ranked with the rest. */
    own?: PaletteGroup[];
    placeholder?: string;
  },
): ReactNode {
  const state = useSyncExternalStore(paletteState.subscribe, paletteState.get);
  const [seen, setSeen] = useState(state);
  const [entries, setEntries] = useState<Entry[]>(() => entriesOf(state.steps));
  const [active, setActive] = useState<string>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [dialog, setDialog] = useState<PaletteDialog & { open: boolean }>();
  const field = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const scroll = useRef(false);
  const id = useId();
  // Opened again (or at another step): it starts over.
  if (seen !== state) {
    setSeen(state);
    setEntries(entriesOf(state.steps));
    setActive(undefined);
    setError(undefined);
    setBusy(undefined);
  }
  const open = state.open;
  const { ref, events } = useModal(open, closePalette);
  const entry = entries[entries.length - 1];
  const step = entry.step;
  const search = entry.search;

  const asked = { ...hints, search };
  const { values, loading } = useOutputs(
    !open
      ? []
      : step?.view
      ? [{ kind: step.view, item: step.item, hints: { ...asked, ...step.hints } }]
      : step
      ? []
      : sources.map((s) => ({ kind: s.view, hints: asked })),
  );
  const groups = step?.items
    ? step.items(search)
    : step
    ? groupsOf(values[0])
    : [...values.flatMap(groupsOf), ...own];
  const listed = listOf(groups, search, step?.filter ?? true);
  const usable = listed.items.filter((item) => !item.disabled);
  const current = usable.find((item) => item.key === active) ?? usable[0];
  const optionId = (item: PaletteItem) => `${id}-${listed.items.indexOf(item)}`;

  // Focus goes where keys go, each step (back by its button too): the field (a name to change
  // chosen, to type over), or a question's list.
  const asking = step?.confirm === true;
  useEffect(() => {
    if (!open) return;
    if (asking) return list.current?.focus();
    field.current?.focus();
    if (step?.value) field.current?.select();
  }, [open, entries.length]);
  // The active item, moved to by keys, stays in view.
  useEffect(() => {
    if (!scroll.current || !current) return;
    scroll.current = false;
    document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
  });

  const typed = (next: string) => {
    setEntries((all) => [...all.slice(0, -1), { ...all[all.length - 1], search: next }]);
    setActive(undefined);
    setError(undefined);
    list.current?.scrollTo({ top: 0 });
  };
  const push = (next: PaletteStep) => {
    setEntries((all) => [...all, { step: next, search: next.value ?? "" }]);
    setActive(undefined);
    setError(undefined);
  };
  const back = () => {
    if (entries.length < 2) return closePalette();
    setEntries((all) => all.slice(0, -1));
    setActive(undefined);
    setError(undefined);
  };
  const control = (moved: { yes: boolean }): PaletteControl => ({
    search,
    push(next) {
      moved.yes = true;
      push(next);
    },
    back() {
      moved.yes = true;
      back();
    },
    close: closePalette,
    async pick(value) {
      const asker = [...entries].reverse().find((e) => e.step?.pick)?.step;
      return await asker?.pick?.(value);
    },
    dialog(shown) {
      moved.yes = true;
      setDialog({ ...shown, open: true });
      closePalette();
    },
  });

  const choose = async (item: PaletteItem) => {
    if (item.disabled || busy) return;
    setError(undefined);
    if (item.step) return push(item.step);
    if (item.href) {
      closePalette();
      return go(item.href);
    }
    if (!item.run) return;
    const moved = { yes: false };
    try {
      const done = item.run(control(moved));
      if (thenable(done)) {
        setBusy(item.key);
        await done;
      }
      if (!moved.yes) closePalette();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(undefined);
    }
  };

  const move = (by: number) => {
    if (!usable.length) return;
    const at = current ? usable.indexOf(current) : -1;
    scroll.current = true;
    setActive(usable[(at + by + usable.length) % usable.length].key);
  };
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    if (event.nativeEvent.isComposing) return;
    const ctrl = event.ctrlKey && !event.metaKey && !event.altKey;
    if (event.key === "ArrowDown" || (ctrl && event.key === "n")) move(1);
    else if (event.key === "ArrowUp" || (ctrl && event.key === "p")) move(-1);
    else if (
      event.key === "Enter" && (event.target === field.current || event.target === list.current)
    ) {
      if (current) void choose(current);
    } else if (event.key === "Escape") back();
    else if (event.key === "Backspace" && event.target === field.current && !search) {
      if (entries.length < 2) return;
      back();
    } else return;
    event.preventDefault();
  };

  const title = step?.title;
  const count = listed.items.length;
  // A name being typed lists only what it would do: nothing, until there's something to.
  const quiet = step?.filter === false;
  return (
    <>
      {SHEET}
      <dialog
        ref={ref}
        className="copilotz-palette"
        aria-label={title ?? "Command palette"}
        closedby="any"
        {...events}
        onKeyDown={keys}
      >
        <div className="copilotz-palette-head">
          {entries.length > 1
            ? <IconButton icon="chevron-left" label="Back" size="sm" onClick={back} />
            : <Icon name="search" size={18} />}
          {title
            ? (
              <span
                className={`copilotz-palette-step${asking ? " copilotz-palette-question" : ""}`}
                title={title}
              >
                {title}
              </span>
            )
            : null}
          {asking ? <span className="copilotz-palette-gap" /> : (
            <input
              ref={field}
              className="copilotz-palette-field"
              type="search"
              role="combobox"
              aria-expanded="true"
              aria-controls={`${id}-list`}
              aria-autocomplete="list"
              aria-activedescendant={current ? optionId(current) : undefined}
              aria-label={title ?? placeholder}
              placeholder={step?.placeholder ?? (step ? "Search" : placeholder)}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              enterKeyHint="go"
              value={search}
              onChange={(event) => typed(event.target.value)}
            />
          )}
          <span className="copilotz-palette-esc" aria-hidden="true">
            <Kbd>esc</Kbd>
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="copilotz-palette-cancel"
            onClick={closePalette}
          >
            Cancel
          </Button>
        </div>
        {step?.note ? <p className="copilotz-palette-note">{step.note}</p> : null}
        {error
          ? (
            <Notice tone="destructive" role="alert" className="copilotz-palette-error">
              {error}
            </Notice>
          )
          : null}
        <div
          ref={list}
          id={`${id}-list`}
          role="listbox"
          aria-label={title ?? "Commands"}
          className="copilotz-palette-list"
          // A question's choices take the keys themselves.
          tabIndex={asking ? 0 : -1}
          aria-activedescendant={asking && current ? optionId(current) : undefined}
          hidden={!count && quiet}
        >
          {listed.groups.map((group, g) => (
            <div
              key={group.title || g}
              role="group"
              className="copilotz-palette-group"
              aria-labelledby={group.title ? `${id}-g${g}` : undefined}
            >
              {group.title
                ? (
                  <div id={`${id}-g${g}`} className="copilotz-palette-heading">
                    {group.title}
                  </div>
                )
                : null}
              {group.items.map((item) => (
                <Row
                  key={item.key}
                  id={optionId(item)}
                  item={item}
                  active={item === current}
                  busy={busy === item.key}
                  search={quiet ? "" : search}
                  choose={() => void choose(item)}
                  point={() => setActive(item.key)}
                />
              ))}
            </div>
          ))}
          {count || quiet
            ? null
            : loading
            ? (
              <div className="copilotz-palette-loading" aria-busy="true">
                {[0, 1, 2].map((i) => <Skeleton key={i} height={34} width={`${88 - i * 14}%`} />)}
              </div>
            )
            : (
              <p className="copilotz-palette-empty">
                {search.trim() ? <>Nothing found for “{search.trim()}”</> : "Nothing here yet"}
              </p>
            )}
        </div>
        <p className="copilotz-sr" role="status">
          {search.trim() && !loading
            ? count ? `${count} result${count === 1 ? "" : "s"}` : "No results"
            : ""}
        </p>
        <footer className="copilotz-palette-foot" aria-hidden="true">
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to move
          </span>
          <span>
            <Kbd>↵</Kbd> to choose
          </span>
          <span>
            <Kbd>esc</Kbd> {entries.length > 1 ? "to go back" : "to close"}
          </span>
        </footer>
      </dialog>
      {dialog
        ? (
          <Dialog
            open={dialog.open}
            onClose={() => setDialog(undefined)}
            title={dialog.title}
            description={dialog.description}
            size={dialog.size}
            footer={<Button onClick={() => setDialog({ ...dialog, open: false })}>Done</Button>}
          >
            <LazyView kind={dialog.view} item={dialog.item ?? {}} hints={dialog.hints ?? {}} />
          </Dialog>
        )
        : null}
    </>
  );
}
