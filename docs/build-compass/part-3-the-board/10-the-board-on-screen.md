---
title: "Chapter 10: The board on screen"
description: "Show the same board in two places with Views: a Board tab on every space's page, plugged in through a resource kind, and a terminal View printed by a command. Both stay live."
section: Build Compass
order: 100
status: stable
---

# Chapter 10: The board on screen

> Part 3, the board · Requires: Chapter 9 · Code: `lesson-3.2`

## The pain

The board's rules are right, but you can't see it. And you work in two places, the browser and the
terminal: two front ends usually means two copies of every screen's logic, drifting apart.

## The problem

What the board _is_ (its documents, its Actions) shouldn't be written twice. Only how it _looks_
should differ, per place, in each place's own terms: React in the browser, text in the terminal. And
both should follow the data as it changes, without polling or refresh buttons.

## The solution

**Views**, one per place, over the same collections and Actions.

### On the web

`boardsWeb` (`web.tsx`) is boards' web front end:

```ts
export const boardsWeb: Plugin = definePlugin({
  name: "boards-web",
  requires: ["web-shell"],
  views: {
    board: boardPageView,
    "board.inline": boardInlineView,
    "boards.tab": boardsTabView,
    "boards.palette": boardsPaletteView,
  },
  resources: {
    spaceTabs: { board: { title: "Board", view: "boards.tab", icon: "check-circle", order: 20 } },
    palette: { boards: { view: "boards.palette", order: 30 } },
  },
});
```

One line, the `spaceTabs` entry, puts a Board tab on every space's page: the page you wrote in
Chapter 8 shows it without knowing boards exist. `/board/<id>` is a board's own page (the View named
`board`), and the palette finds boards by name.

The board itself is a View that reads cards and draws columns (`views/web/board-view.tsx`). Moving a
card is a column picker and two buttons, each a call to the same Action every caller uses:

```tsx
const move = async (card: string, place: { column?: string; before?: string; after?: string }) => {
  setBusy(true);
  setError(undefined);
  try {
    await call("card.move", { card, ...place });
  } catch (e) {
    setError(message(e));
  } finally {
    setBusy(false);
  }
};
// …
<Select
  size="sm"
  aria-label={`Column for ${card.title}`}
  value={card.column}
  disabled={busy}
  onChange={(event) => void move(card._id, { column: event.target.value })}
>
  {board.columns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
</Select>;
```

A refusal (a column that was just removed, say) comes back as an error with its message, shown where
you clicked.

Nothing re-renders by hand. The View is **observed**: the runtime remembers what it read, and when a
commit changes any document that matched those reads, it runs the View again. A card moved by an
agent, in another tab, or from the terminal, shows moved here.

### In the terminal

`boardsTerminal` (`terminal.ts`) adds a terminal View and a command:

```ts
export const boardsTerminal: Plugin = definePlugin({
  name: "boards-terminal",
  requires: ["boards", "terminal-shell"],
  views: { "terminal.board": boardView },
  resources: { commands },
});
```

A terminal View returns Ink elements or plain text. The board's returns text, with the terminal
toolkit's `bold` and `dim` (`views/terminal/board.ts`):

```ts
export const boardView = (item: { space: string; board?: string }, ctx: ViewContext): string => {
  const found = ctx.db.collection<Board>("board").find({ in: item.space }, { sort: { at: 1 } });
  if (found.status !== "ready") return dim("Loading boards…");
  // … which boards, their cards, who owns each
  return boards.map((board) =>
    [
      bold(board.name + (board.archived ? " (archived)" : "")),
      ...(board.description ? [dim(board.description)] : []),
      ...board.columns.flatMap((column) => {
        const here = cards.filter((card) => card.board === board._id && card.column === column.id);
        return [
          `  ${bold(column.name)} ${dim(`(${here.length})`)}`,
          ...(here.length ? here.map(cardLine) : [dim("    No cards.")]),
        ];
      }),
    ].join("\n")
  ).join("\n\n");
};
```

Plain text has a practical reason too: Node runs TypeScript files but not JSX. The browser's code is
bundled (esbuild reads `.tsx`), the terminal's isn't, so its Views are `.ts`.

The `/board` command (`resources/terminal-commands.ts`) prints that View for the space you're
working in. `terminal.ts` adds `boardsTerminal`; `front.ts` adds `boardsWeb`.

## Run it

In the browser, make a space, open its Board tab, and make a board, "Launch": it comes with its
columns. Add two cards in To do, "Record the trailer" for North and "Review the course page" for
you, and move the first to Doing. Then, with the server stopped, the terminal on the same store:

```text
ana › /spaces
[1] Course launch · shared · 5b4479ac-…
[2] Personal · personal · personal:ana ●
ana › /work 1
You work in Course launch now.
ana › /board
Launch
  Backlog (0)
    No cards.
  To do (1)
    • Review the course page · Ana
  Doing (1)
    • Record the trailer · North
  Blocked (0)
    No cards.
…
```

The same cards, in the same order.

## Check it

`tests/terminal.test.ts` renders `terminal.board` with `runtime.render` and runs `/board` through
the real terminal host with a fake standard output. `tests/web.test.ts` observes a board page,
creates, edits and moves cards through the Actions, and checks each change shows up in the observed
View.

## What you have now

One board, two front ends, no logic in either beyond how it looks. There's a third place to show it:
North's prompt.
