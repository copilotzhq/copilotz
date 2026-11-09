/**
 * A card on a board: its labels, its title, when it's due (an overdue one
 * says so, unless it's done), a mark when it has a description, and who
 * owns it (a person's initial, an agent's emoji). It opens its details; it
 * drags by pointer (a mouse at once, a finger after a short press); with the
 * keyboard, Space picks it up and the arrows move it. Its menu: open it,
 * move it (to a column, the top, the bottom), take it, delete it.
 */
import type { KeyboardEvent, PointerEvent, ReactNode } from "react";
import { Avatar, Menu, type MenuItem, Tooltip } from "copilotz/web";
import type { Card } from "../../contract.ts";
import { Glyph } from "./glyphs.tsx";
import { dueShown, hueOf, says, type Someone } from "./shown.ts";

export function CardTile(
  {
    card,
    done,
    today,
    owner,
    lifted,
    held,
    busy,
    menu,
    describedBy,
    onOpen,
    onPress,
    onKeys,
  }: {
    card: Card;
    /** In a column of finished work: a past due date isn't overdue there. */
    done: boolean;
    today: string;
    owner?: Someone;
    /** Being dragged: the slot shows where it goes, so it hides here. */
    lifted?: boolean;
    /** Picked up with the keyboard. */
    held?: boolean;
    busy?: boolean;
    menu?: (MenuItem | "separator")[];
    describedBy?: string;
    onOpen(): void;
    onPress?(event: PointerEvent<HTMLElement>): void;
    onKeys?(event: KeyboardEvent<HTMLElement>): void;
  },
): ReactNode {
  const due = card.due ? dueShown(card.due, today, done) : undefined;
  return (
    <li
      className="board-card"
      data-card={card._id}
      data-lifted={lifted || undefined}
      data-held={held || undefined}
      data-busy={busy || undefined}
      onPointerDown={onPress}
    >
      <button
        type="button"
        className="board-card-open"
        id={`card-${card._id}`}
        aria-describedby={describedBy}
        aria-pressed={held ? true : undefined}
        onClick={onOpen}
        onKeyDown={onKeys}
      >
        {card.labels?.length
          ? (
            <span className="board-card-labels">
              {card.labels.map((label) => (
                <span key={label} className="board-label" data-hue={hueOf(label)}>
                  <span>{label}</span>
                </span>
              ))}
            </span>
          )
          : null}
        <span className="board-card-title">{card.title}</span>
        {due || says(card) || owner
          ? (
            <span className="board-card-meta">
              {due
                ? (
                  <span className="board-due" data-tone={due.tone} title={due.title}>
                    <Glyph name="calendar" size={12} />
                    {due.text}
                    <span className="board-sr">, {due.title}</span>
                  </span>
                )
                : null}
              {says(card)
                ? (
                  <span className="board-card-mark" title="Has a description">
                    <Glyph name="lines" size={14} />
                    <span className="board-sr">Has a description.</span>
                  </span>
                )
                : null}
              {owner
                ? (
                  <span className="board-card-who">
                    <Tooltip text={owner.name} describe={false}>
                      <Avatar
                        name={owner.name}
                        kind={owner.kind}
                        icon={owner.icon}
                        size={22}
                        title={owner.name}
                      />
                    </Tooltip>
                    <span className="board-sr">Owned by {owner.name}.</span>
                  </span>
                )
                : null}
            </span>
          )
          : null}
      </button>
      {menu
        ? (
          <span className="board-card-menu" data-no-drag>
            <Menu label={`${card.title}: more`} align="end" size="sm" items={menu} />
          </span>
        )
        : null}
    </li>
  );
}
