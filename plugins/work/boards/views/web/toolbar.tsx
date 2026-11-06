/**
 * What a board shows, chosen above its columns: a search (words in a card's
 * title, description, labels or owner), owners and labels (several at once;
 * "Nobody yet" for cards without an owner), how many cards show, and "New
 * card". Filters are the viewer's own: they change nothing for anyone else.
 */
import type { ReactNode } from "react";
import { Badge, Button, IconButton, Input } from "../../../../../hosts/web/mod.ts";
import type { Card } from "../../contract.ts";
import { Glyph } from "./glyphs.tsx";
import { Face, ManyPicker } from "./pickers.tsx";
import { filtering, type Filters, hueOf, labelsOn, NO_FILTERS, type Someone } from "./shown.ts";

export function Toolbar(
  { cards, people, filters, onFilters, shown, can, compact, onNew }: {
    cards: Card[];
    /** Who cards can go to, and who they already have. */
    people: Someone[];
    filters: Filters;
    onFilters(filters: Filters): void;
    /** How many cards the filters show. */
    shown: number;
    can: boolean;
    compact: boolean;
    onNew(): void;
  },
): ReactNode {
  const count = (key: string) => cards.filter((c) => (c.assignee ?? "none") === key).length;
  const owners = [
    { value: "none", label: "Nobody yet", leading: <Face size={22} />, count: count("none") },
    ...people.map((p) => ({
      value: p.key,
      label: p.name,
      leading: <Face someone={p} size={22} />,
      count: count(p.key),
    })),
  ].filter((o) => o.count > 0 || o.value !== "none");
  const labels = labelsOn(cards);
  const chosen = people.filter((p) => filters.assignees.includes(p.key));
  return (
    <div className="board-toolbar" role="group" aria-label="Filter the board">
      <Input
        size="sm"
        icon="search"
        type="search"
        className="board-search"
        placeholder="Filter cards"
        aria-label="Filter cards by words"
        value={filters.search}
        onChange={(event) => onFilters({ ...filters, search: event.target.value })}
      />
      <ManyPicker
        label="Owners"
        search={owners.length > 8 ? "Find someone" : undefined}
        options={owners}
        value={filters.assignees}
        onChange={(assignees) => onFilters({ ...filters, assignees })}
        trigger={(props) => (
          <Button
            size="sm"
            className="board-filter"
            data-on={filters.assignees.length ? "" : undefined}
            icon={filters.assignees.length ? undefined : "person"}
            {...props}
          >
            {filters.assignees.length
              ? (
                <span className="board-filter-faces">
                  {chosen.slice(0, 3).map((p) => <Face key={p.key} someone={p} size={18} />)}
                  {filters.assignees.includes("none") && chosen.length < 3
                    ? <Face size={18} />
                    : null}
                </span>
              )
              : null}
            {compact ? null : "Owner"}
          </Button>
        )}
      />
      {labels.length
        ? (
          <ManyPicker
            label="Labels"
            search={labels.length > 8 ? "Find a label" : undefined}
            options={labels.map(({ label, count }) => ({
              value: label,
              label,
              leading: <span className="board-label" data-hue={hueOf(label)} aria-hidden="true" />,
              count,
            }))}
            value={filters.labels}
            onChange={(chosenLabels) => onFilters({ ...filters, labels: chosenLabels })}
            trigger={(props) => (
              <Button
                size="sm"
                className="board-filter"
                data-on={filters.labels.length ? "" : undefined}
                {...props}
              >
                <Glyph name="label" size={14} />
                {compact ? null : "Label"}
                {filters.labels.length
                  ? <Badge tone="primary">{filters.labels.length}</Badge>
                  : null}
              </Button>
            )}
          />
        )
        : null}
      {filtering(filters)
        ? (
          <Button size="sm" variant="ghost" onClick={() => onFilters(NO_FILTERS)}>
            Clear
          </Button>
        )
        : null}
      <span className="board-toolbar-end">
        {compact ? null : (
          <span className="board-count" aria-live="polite">
            {filtering(filters) ? `${shown} of ${cards.length}` : `${cards.length}`} card
            {(filtering(filters) ? shown : cards.length) === 1 ? "" : "s"}
          </span>
        )}
        {can
          ? compact
            ? <IconButton icon="plus" label="New card" variant="outline" onClick={onNew} />
            : <Button size="sm" variant="primary" icon="plus" onClick={onNew}>New card</Button>
          : null}
      </span>
    </div>
  );
}
