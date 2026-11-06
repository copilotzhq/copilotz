/**
 * Choosing on a board, in popovers: whom a card goes to (the space's people
 * and agents, found as you type), its labels (the board's, or a new one),
 * and what the board is filtered by (owners, labels: several at once). Each
 * list is a popover's items: arrows move, Enter chooses, Escape closes.
 */
import { type KeyboardEvent, type ReactNode, useState } from "react";
import { Avatar, Icon, Input, Popover, type PopoverTrigger } from "../../../../../hosts/web/mod.ts";
import { fold } from "../../shared/columns.ts";
import { hueOf, type Someone } from "./shown.ts";

/** An option's face: a person's initial, an agent's emoji, or nobody's dashed ring. */
export function Face({ someone, size = 24 }: { someone?: Someone; size?: number }): ReactNode {
  if (!someone) {
    return (
      <span className="board-unassigned" style={{ width: size, height: size }} aria-hidden="true">
        <Icon name="person" size={Math.round(size * 0.55)} />
      </span>
    );
  }
  return <Avatar name={someone.name} kind={someone.kind} icon={someone.icon} size={size} />;
}

/** Arrow keys from a popover's search field to its first item. */
const down = (event: KeyboardEvent<HTMLInputElement>) => {
  if (event.key !== "ArrowDown") return;
  event.preventDefault();
  event.currentTarget.closest("[popover]")?.querySelector<HTMLElement>(
    "[data-popover-item]:not(input)",
  )?.focus();
};

/** Whether someone fits what's typed: their name, their note (an email), their key. */
const fits = (someone: Someone, typed: string) =>
  fold(`${someone.name} ${someone.note ?? ""} ${someone.key}`).includes(fold(typed));

/** Whom a card goes to: one of the space's people or agents, or nobody. */
export function AssigneePicker(
  { people, value, onChange, trigger, label = "Owner" }: {
    people: Someone[];
    value?: string;
    onChange(key: string | null): void;
    trigger(props: PopoverTrigger): ReactNode;
    label?: string;
  },
): ReactNode {
  const [typed, setTyped] = useState("");
  const shown = people.filter((p) => fits(p, typed));
  const humans = shown.filter((p) => p.kind === "person");
  const agents = shown.filter((p) => p.kind === "agent");
  const option = (someone: Someone | undefined, close: () => void) => (
    <button
      key={someone?.key ?? "nobody"}
      type="button"
      role="menuitemradio"
      aria-checked={(someone?.key ?? undefined) === value}
      className="board-option"
      data-popover-item
      onClick={() => {
        onChange(someone?.key ?? null);
        close();
      }}
    >
      <Face someone={someone} />
      <span className="board-option-text">
        <span>{someone?.name ?? "Nobody yet"}</span>
        {someone?.note && someone.note !== someone.name
          ? <span className="board-option-note">{someone.note}</span>
          : null}
      </span>
      <Icon name="check" size={16} className="board-option-check" />
    </button>
  );
  return (
    <Popover label={label} trigger={trigger} width={300}>
      {(close) => (
        <div role="menu" aria-label={label}>
          <div className="board-options-search">
            <Input
              size="sm"
              icon="search"
              placeholder="Find someone here"
              aria-label="Find someone here"
              value={typed}
              data-popover-item
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
              onKeyDown={down}
            />
          </div>
          <div className="board-options">
            {typed ? null : option(undefined, close)}
            {humans.length ? <p className="board-options-head">People</p> : null}
            {humans.map((p) => option(p, close))}
            {agents.length ? <p className="board-options-head">Agents</p> : null}
            {agents.map((p) => option(p, close))}
            {!shown.length
              ? <p className="board-option-none">Nobody here called “{typed}”.</p>
              : null}
          </div>
        </div>
      )}
    </Popover>
  );
}

/** A card's labels: the board's to choose from, or a new one typed. */
export function LabelPicker(
  { known, value, onChange, trigger }: {
    /** The board's labels, most used first. */
    known: string[];
    value: string[];
    onChange(labels: string[]): void;
    trigger(props: PopoverTrigger): ReactNode;
  },
): ReactNode {
  const [typed, setTyped] = useState("");
  const has = (label: string) => value.some((v) => fold(v) === fold(label));
  const toggle = (label: string) =>
    onChange(has(label) ? value.filter((v) => fold(v) !== fold(label)) : [...value, label]);
  const all = [...value, ...known.filter((k) => !value.some((v) => fold(v) === fold(k)))];
  const shown = all.filter((l) => fold(l).includes(fold(typed)));
  const fresh = typed.trim() && !all.some((l) => fold(l) === fold(typed.trim()))
    ? typed.trim().slice(0, 32)
    : undefined;
  return (
    <Popover label="Labels" trigger={trigger} width={280}>
      <div role="menu" aria-label="Labels">
        <div className="board-options-search">
          <Input
            size="sm"
            icon="search"
            placeholder="Find or make a label"
            aria-label="Find or make a label"
            value={typed}
            maxLength={32}
            data-popover-item
            autoComplete="off"
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (fresh || shown[0])) {
                event.preventDefault();
                toggle(fresh ?? shown[0]);
                setTyped("");
              } else down(event);
            }}
          />
        </div>
        <div className="board-options">
          {shown.map((label) => (
            <button
              key={label}
              type="button"
              role="menuitemcheckbox"
              aria-checked={has(label)}
              className="board-option"
              data-popover-item
              onClick={() => toggle(label)}
            >
              <span className="board-label" data-hue={hueOf(label)}>
                <span>{label}</span>
              </span>
              <span className="board-option-text" />
              <Icon name="check" size={16} className="board-option-check" />
            </button>
          ))}
          {fresh
            ? (
              <button
                type="button"
                role="menuitem"
                className="board-option"
                data-popover-item
                onClick={() => {
                  toggle(fresh);
                  setTyped("");
                }}
              >
                <Icon name="plus" size={16} />
                <span className="board-option-text">
                  <span>Make “{fresh}”</span>
                </span>
              </button>
            )
            : null}
          {!shown.length && !fresh
            ? <p className="board-option-none">Type a label to make one.</p>
            : null}
        </div>
      </div>
    </Popover>
  );
}

/** Several of a list at once (a filter's owners or labels), each with how many cards have it. */
export function ManyPicker<T extends string>(
  { label, options, value, onChange, trigger, search }: {
    label: string;
    options: { value: T; label: string; leading?: ReactNode; count?: number }[];
    value: T[];
    onChange(value: T[]): void;
    trigger(props: PopoverTrigger): ReactNode;
    /** A field to narrow a long list. */
    search?: string;
  },
): ReactNode {
  const [typed, setTyped] = useState("");
  const shown = options.filter((o) => fold(o.label).includes(fold(typed)));
  return (
    <Popover label={label} trigger={trigger} width={280}>
      <div role="menu" aria-label={label}>
        {search
          ? (
            <div className="board-options-search">
              <Input
                size="sm"
                icon="search"
                placeholder={search}
                aria-label={search}
                value={typed}
                data-popover-item
                autoComplete="off"
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={down}
              />
            </div>
          )
          : null}
        <div className="board-options">
          {shown.map((o) => {
            const on = value.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                className="board-option"
                data-popover-item
                onClick={() =>
                  onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
              >
                {o.leading}
                <span className="board-option-text">
                  <span>{o.label}</span>
                </span>
                {o.count !== undefined
                  ? <span className="board-option-count">{o.count}</span>
                  : null}
                <Icon name="check" size={16} className="board-option-check" />
              </button>
            );
          })}
          {!shown.length ? <p className="board-option-none">Nothing matches.</p> : null}
        </div>
      </div>
    </Popover>
  );
}
