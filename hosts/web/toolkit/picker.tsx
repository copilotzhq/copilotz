/**
 * A choice from a list, drawn as the app's own rather than the browser's
 * (a `Select` is the browser's): a button showing what's chosen, which opens
 * the options beside it (a `Popover`) with the chosen one marked. `search`
 * puts a box over a long list that narrows it as it's typed (↓ goes to the
 * list, Enter picks the first match). `MultiPicker` ticks several: its
 * button says `none` ("None chosen"), the one chosen, or how many.
 *
 * Opening it focuses the chosen option (or the search box); arrows, Home
 * and End move, Enter or Space picks, and picking one closes it (a
 * `MultiPicker` stays open to tick more). Given a `name`, the choice goes
 * with a form, as a hidden field (several, for a `MultiPicker`).
 *
 * `addon` and `addonEnd` join words, a glyph or a control to either side, as the
 * Input's do (`className` is then the group's). In a table cell the button fills
 * the cell and has no minimum width.
 *
 * ```tsx
 * <Picker label="Register mode" value={mode} onChange={setMode}
 *   options={[{ value: "sale", label: "Sale" }, { value: "return", label: "Return" }]} />
 * <Picker label="Customer" search value={customer} options={customers} onChange={setCustomer} />
 * <MultiPicker label="Payment types" values={types} options={TYPES} onChange={setTypes} />
 * ```
 */
import { type ReactNode, type Ref, useEffect, useRef, useState } from "react";
import { cx } from "./cx.ts";
import { Icon } from "./icon.tsx";
import { AddonGroup } from "./input.tsx";
import { Popover, type PopoverTrigger } from "./popover.tsx";
import { sheet } from "./sheet.tsx";
import { say } from "./words.ts";

/** One option: its value, and what it says. */
export type PickerOption<T extends string = string> = { value: T; label: string };

const SHEET = sheet(
  "picker",
  `
.copilotz-picker { display: inline-flex; align-items: center; justify-content: space-between; gap: 8px;
  box-sizing: border-box; min-width: var(--picker-min-width, var(--select-min-width, 160px)); max-width: 100%;
  height: var(--picker-height, var(--select-height, var(--input-height, 40px))); padding: var(--picker-padding, 0 10px 0 12px);
  border: var(--picker-border-width, var(--select-border-width, var(--input-border-width, 1px))) solid var(--picker-border-color, var(--input));
  border-radius: var(--picker-radius, var(--select-radius, var(--input-radius, var(--radius-lg)))); background: var(--picker-background, var(--select-background, var(--input-background, var(--card))));
  color: var(--picker-foreground, var(--foreground)); font: inherit; font-size: var(--picker-font-size, var(--select-font-size, var(--input-font-size, 14.5px)));
  font-weight: var(--picker-font-weight, 400); text-align: left; cursor: pointer;
  transition: border-color .15s, box-shadow .15s, background-color .15s; }
.copilotz-picker:hover:not(:disabled) { background: var(--picker-hover-background, var(--picker-background, var(--card)));
  color: var(--picker-hover-foreground, var(--picker-foreground, var(--foreground))); }
.copilotz-picker[aria-expanded=true] { border-color: var(--picker-open-border-color, var(--ring));
  background: var(--picker-open-background, var(--picker-background, var(--card)));
  color: var(--picker-open-foreground, var(--picker-foreground, var(--foreground))); }
.copilotz-picker:focus-visible { outline: none; border-color: var(--ring);
  box-shadow: var(--picker-focus-shadow,
    var(--input-focus-shadow, 0 0 0 4px color-mix(in oklab, var(--ring) 16%, transparent))); }
.copilotz-picker:disabled { opacity: .55; cursor: default; }
.copilotz-picker-sm { height: var(--picker-height-sm, var(--select-height-sm, var(--input-height-sm, 36px))); font-size: var(--picker-font-size-sm, var(--select-font-size-sm, var(--input-font-size-sm, 14px))); }
.copilotz-picker-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-picker-text[data-empty] { color: var(--muted-foreground); }
.copilotz-picker > .copilotz-icon { color: var(--picker-caret-color, var(--muted-foreground)); }
.copilotz-popover.copilotz-picker-menu { width: auto; min-width: var(--picker-menu-min-width, 200px);
  max-width: min(var(--picker-menu-max-width, 420px), calc(100vw - 16px));
  padding: var(--picker-menu-padding, 5px); font-size: var(--picker-item-font-size, 14px); }
.copilotz-picker-search { margin: 0 0 4px; }
.copilotz-picker-search > input { box-sizing: border-box; width: 100%; height: var(--picker-search-height, 34px);
  padding: 0 10px; border: 1px solid var(--input); border-radius: var(--picker-item-radius, var(--radius-md));
  background: var(--card); color: var(--foreground); font: inherit; }
.copilotz-picker-search > input:focus-visible { outline: none; border-color: var(--ring); }
.copilotz-picker-list { max-height: var(--picker-list-max-height, 320px); margin: 0; padding: 0; overflow-y: auto;
  list-style: none; }
.copilotz-picker-option { display: flex; align-items: center; gap: 10px; box-sizing: border-box; width: 100%;
  min-height: var(--picker-item-height, 34px); padding: var(--picker-item-padding, 6px 10px); border: 0;
  border-radius: var(--picker-item-radius, var(--radius-sm)); background: transparent;
  color: var(--picker-item-foreground, var(--popover-foreground)); font: inherit; text-align: left; cursor: pointer;
  outline: none; }
.copilotz-picker-option > span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.copilotz-picker-option:hover, .copilotz-picker-option:focus-visible, .copilotz-picker-option:focus {
  background: var(--picker-item-hover-background, var(--accent));
  color: var(--picker-item-hover-foreground, var(--accent-foreground)); }
.copilotz-picker-option[aria-selected=true] { background: var(--picker-item-chosen-background, transparent);
  color: var(--picker-item-chosen-foreground, var(--picker-item-foreground, var(--popover-foreground)));
  font-weight: var(--picker-item-chosen-font-weight, 600); }
.copilotz-picker-option[aria-selected=true]:hover, .copilotz-picker-option[aria-selected=true]:focus {
  background: var(--picker-item-chosen-hover-background, var(--picker-item-hover-background, var(--accent))); }
.copilotz-picker-check { flex: none; width: 16px; color: var(--picker-check-color, var(--primary-text)); }
.copilotz-picker-option[aria-selected=false] > .copilotz-picker-check { visibility: hidden; }
.copilotz-picker-none { margin: 0; padding: 8px 10px; color: var(--muted-foreground); }
@media (pointer: coarse) {
  .copilotz-picker { height: 44px; }
  .copilotz-picker-option { min-height: 44px; }
}
`,
);

/** What the button and list share, single or multiple. */
type Common<T extends string> = {
  /** What it is, said to screen readers (and the button's tooltip). */
  label: string;
  options: PickerOption<T>[];
  /** A box over the list that narrows it as it's typed. */
  search?: boolean;
  /** The button's id. */
  id?: string;
  /** Sends the choice with a form, as hidden fields of this name. */
  name?: string;
  size?: "sm" | "md";
  side?: "top" | "bottom";
  align?: "start" | "end";
  disabled?: boolean;
  /** Before the button, joined to it: words, a glyph or a control. */
  addon?: ReactNode;
  /** After the button, joined to it. */
  addonEnd?: ReactNode;
  /** The button's class, or the group's when it has addons. */
  className?: string;
};

/**
 * The button: what's chosen and a caret. Once opened, it focuses the chosen
 * option (the popover focuses the first item first; this comes after it).
 */
function Trigger(
  { opener, label, text, empty, id, size, disabled, className, list, search }: {
    opener: PopoverTrigger;
    label: string;
    text: string;
    empty: boolean;
    id?: string;
    size: "sm" | "md";
    disabled?: boolean;
    className?: string;
    list: { current: HTMLUListElement | null };
    search?: boolean;
  },
): ReactNode {
  const open = opener["aria-expanded"];
  useEffect(() => {
    if (!open || search) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() =>
        list.current?.querySelector<HTMLElement>("[aria-selected=true]")?.focus()
      );
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  return (
    <button
      type="button"
      {...opener}
      aria-haspopup="listbox"
      id={id}
      title={label}
      disabled={disabled}
      className={cx("copilotz-picker", size === "sm" && "copilotz-picker-sm", className)}
    >
      <span className="copilotz-picker-text" data-empty={empty || undefined}>{text}</span>
      <Icon name="chevron-down" size={16} />
    </button>
  );
}

/** The list (and the search box over it), for one choice or several. */
function Options<T extends string>(
  { label, options, search, chosen, multiple, list, onPick }: {
    label: string;
    options: PickerOption<T>[];
    search?: boolean;
    chosen: readonly T[];
    multiple: boolean;
    list: Ref<HTMLUListElement>;
    onPick(value: T): void;
  },
): ReactNode {
  const [text, setText] = useState("");
  const box = useRef<HTMLUListElement | null>(null);
  const needle = text.trim().toLocaleLowerCase();
  const shown = needle
    ? options.filter((o) => o.label.toLocaleLowerCase().includes(needle))
    : options;
  return (
    <>
      {search
        ? (
          <div className="copilotz-picker-search">
            <input
              data-popover-item
              type="search"
              aria-label={say("search")}
              placeholder={say("search")}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  box.current?.querySelector<HTMLElement>("[role=option]")?.focus();
                } else if (event.key === "Enter" && shown[0]) {
                  event.preventDefault();
                  onPick(shown[0].value);
                }
              }}
            />
          </div>
        )
        : null}
      <ul
        ref={(node) => {
          box.current = node;
          if (typeof list === "function") list(node);
          else if (list) (list as { current: HTMLUListElement | null }).current = node;
        }}
        className="copilotz-picker-list"
        role="listbox"
        aria-label={label}
        aria-multiselectable={multiple || undefined}
      >
        {shown.map((option) => {
          const on = chosen.includes(option.value);
          return (
            <li key={option.value} role="none">
              <button
                type="button"
                data-popover-item
                role="option"
                aria-selected={on}
                className="copilotz-picker-option"
                onClick={() => onPick(option.value)}
              >
                <Icon name="check" size={16} className="copilotz-picker-check" />
                <span>{option.label}</span>
              </button>
            </li>
          );
        })}
      </ul>
      {shown.length === 0 && needle
        ? <p className="copilotz-picker-none">{say("noMatches", { text: text.trim() })}</p>
        : null}
    </>
  );
}

/** One choice of a list. */
export function Picker<T extends string>(
  {
    label,
    value,
    options,
    onChange,
    placeholder,
    search,
    id,
    name,
    size = "md",
    side,
    align,
    disabled,
    addon,
    addonEnd,
    className,
  }:
    & Common<T>
    & {
      value: T | undefined;
      onChange(value: T): void;
      /** What the button says while nothing is chosen. */
      placeholder?: string;
    },
): ReactNode {
  const list = useRef<HTMLUListElement | null>(null);
  const grouped = addon !== undefined || addonEnd !== undefined;
  const join = (node: ReactNode) =>
    grouped
      ? (
        <AddonGroup addon={addon} addonEnd={addonEnd} size={size} className={className}>
          {node}
        </AddonGroup>
      )
      : node;
  const chosen = options.find((o) => o.value === value);
  return (
    <>
      {SHEET}
      {join(
        <>
          <Popover
            label={label}
            side={side}
            align={align ?? "start"}
            className="copilotz-picker-menu"
            trigger={(opener) => (
              <Trigger
                opener={opener}
                label={label}
                text={chosen?.label ?? placeholder ?? ""}
                empty={!chosen}
                id={id}
                size={size}
                disabled={disabled}
                className={grouped ? undefined : className}
                list={list}
                search={search}
              />
            )}
          >
            {(close) => (
              <Options
                label={label}
                options={options}
                search={search}
                chosen={value === undefined ? [] : [value]}
                multiple={false}
                list={list}
                onPick={(picked) => {
                  close();
                  if (picked !== value) onChange(picked);
                }}
              />
            )}
          </Popover>
          {name && value !== undefined ? <input type="hidden" name={name} value={value} /> : null}
        </>,
      )}
    </>
  );
}

/** Several choices of a list, ticked. */
export function MultiPicker<T extends string>(
  {
    label,
    values,
    options,
    onChange,
    none,
    search,
    id,
    name,
    size = "md",
    side,
    align,
    disabled,
    addon,
    addonEnd,
    className,
  }:
    & Common<T>
    & {
      values: T[];
      onChange(values: T[]): void;
      /** What the button says while nothing is ticked ("None chosen"). */
      none?: string;
    },
): ReactNode {
  const list = useRef<HTMLUListElement | null>(null);
  const grouped = addon !== undefined || addonEnd !== undefined;
  const join = (node: ReactNode) =>
    grouped
      ? (
        <AddonGroup addon={addon} addonEnd={addonEnd} size={size} className={className}>
          {node}
        </AddonGroup>
      )
      : node;
  const picked = options.filter((o) => values.includes(o.value));
  const text = picked.length === 0
    ? none ?? say("noneChosen")
    : picked.length === 1
    ? picked[0].label
    : say("chosen", { count: picked.length });
  return (
    <>
      {SHEET}
      {join(
        <>
          <Popover
            label={label}
            side={side}
            align={align ?? "start"}
            className="copilotz-picker-menu"
            trigger={(opener) => (
              <Trigger
                opener={opener}
                label={label}
                text={text}
                empty={picked.length === 0}
                id={id}
                size={size}
                disabled={disabled}
                className={grouped ? undefined : className}
                list={list}
                search={search}
              />
            )}
          >
            <Options
              label={label}
              options={options}
              search={search}
              chosen={values}
              multiple
              list={list}
              onPick={(value) =>
                onChange(
                  values.includes(value) ? values.filter((v) => v !== value) : [...values, value],
                )}
            />
          </Popover>
          {name ? values.map((v) => <input key={v} type="hidden" name={name} value={v} />) : null}
        </>,
      )}
    </>
  );
}
