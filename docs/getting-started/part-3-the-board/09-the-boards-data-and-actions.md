---
title: "Chapter 9: The board's data and Actions"
description: "Rebuild Copilotz's boards: two collections that must always agree, seven Actions that are the only way to change them, and transactions that commit what several documents must agree on together."
section: Getting Started
order: 90
status: stable
---

# Chapter 9: The board's data and Actions

> Part 3, the board · Requires: Chapter 8 · Code: `lesson-3.1`

## The pain

Plans made in a chat scroll away. "Who's doing the trailer? Is the page reviewed?" means scrolling
back and hoping. Work longer than one step needs a place where its state is, not a place where it
was mentioned.

## The problem

A kanban board is simple to draw and easy to corrupt. A board has columns in order; each card is in
one of them, at an order within it. Any write that touches one without the other can leave a card in
a column the board no longer has, or two cards at the same place. If people, scripts, the REST API
and agents may each write cards their own way, the board can only be as correct as the sloppiest of
them.

## The solution

Two collections, and **only Actions change them**. The rules live in the Actions, and every caller,
a click, an agent, a script, goes through the same ones.

### Two collections

Rebuilt with the same contract as Copilotz's `boards`. A board (`collections/board.ts`) is in a
space, with its columns in order; a new one starts with Backlog, To do, Doing, Blocked, In review
and Done. A card (`collections/card.ts`):

```ts
export const card = defineCollection({
  schema: {
    type: "object",
    properties: {
      in: { type: "string" },
      board: { type: "string" },
      column: { type: "string" },
      order: { type: "number" },
      title: { type: "string" },
      description: { type: "string" },
      assignee: { type: "string" },
      labels: { type: "array", items: { type: "string" } },
      due: { type: "string" },
      by: { type: "string" },
      at: { type: "string" },
      updatedBy: { type: "string" },
      updated: { type: "string" },
    },
    required: ["in", "board", "column", "order", "title", "at"],
  },
  indexes: [["board", "column"], ["in"]],
});
```

Both live in spaces, through the `shared` resource kind from Chapter 7: spaces' rule keeps them in
spaces that exist.

### Seven Actions, and one guard

`board.create`, `board.update`, `board.delete`, `card.create`, `card.update`, `card.move` and
`card.delete`. Each one reads what it needs and writes what must agree **in one transaction**:
either every write commits, with its events, or none does. Here's the heart of `card.move`
(`actions/move-card.ts`):

```ts
return await ctx.transaction(async (tx) => {
  const cards = tx.db.collection<Card>("card");
  const card = await cards.findOne({ _id: input.card });
  if (!card) throw notFound("No such card here: it may have been deleted.");
  const board = await tx.db.collection<Board>("board").findOne({ _id: card.board });
  if (!board) throw notFound("Its board was just deleted.");
  // … where it goes: a column, before or after another card, or the top or bottom
  const column = board.columns.find((c) => c.id === target);
  if (!column) throw invalid(`“${board.name}” has no column “${target}”.`);
  const others = byOrder(
    await cards.find({ in: board.in, board: board._id, column: column.id }),
  ).filter((c) => c._id !== card._id);
  const { order, renumbered } = orderAt(others, indexOf(others, place));
  const moved = await cards.updateOne(
    { _id: card._id },
    { $set: { column: column.id, order, updatedBy: by, updated } },
  );
  if (!moved.matchedCount) throw readOnly();
  for (const [id, fresh] of Object.entries(renumbered)) {
    await cards.updateOne({ _id: id }, { $set: { order: fresh } }, { writeConcern: { w: 0 } });
  }
  return { card: card._id, board: board._id, column: column.id, columnName: column.name /* … */ };
});
```

A card's order is a number between its neighbours'. When a column gets crowded and there's no number
left between two cards, the move renumbers the column, in the same commit. A column that isn't on
the board is refused before anything is written.

Then the guard (`mod.ts`), so nothing outside writes either collection directly:

```ts
export const boards: Plugin = definePlugin({
  name: "boards",
  requires: ["chat", "spaces"],
  collections: { board, card },
  actions: {
    "board.create": createBoardAction,
    "board.update": updateBoardAction,
    "board.delete": deleteBoardAction,
    "card.create": createCardAction,
    "card.update": updateCardAction,
    "card.move": moveCardAction,
    "card.delete": deleteCardAction,
  },
  resources: { shared: { board: {}, card: {} } },
  guard: (_actor, { collection, access, direct }) => {
    if ((collection === "board" || collection === "card") && direct && access === "write") {
      throw failure("forbidden", "Boards and cards change through their Actions.", {
        public: true,
      });
    }
    return undefined;
  },
});
```

The REST API and the browser's socket still **read** boards and cards (spaces' rule speaks for
them); only writes are refused. `failure(code, message, { public: true })` is a failure whose
message is safe to show the caller: it's answered with its code's status (`forbidden`, 403).

`app.ts` adds `boards` after spaces. A card's owner is you or an agent in its space: who else would
own one, in an app for one person?

## Run it

From any client that's you, the Actions are the board:

```ts
const { board } = await runtime.call("board.create", { in: space, name: "Launch" }, { actor });
const { card } = await runtime.call("card.create", { board, title: "Record the trailer" }, {
  actor,
});
await runtime.call("card.move", { card, column: "doing" }, { actor });
```

Each call is on the record (`action.started`, `card.updated`, `action.completed`), with Ana as its
actor.

## Check it

`tests/boards.test.ts`: a new board has the usual columns; cards keep their order through moves; a
move to a column the board doesn't have changes nothing; many moves into one place renumber the
column before orders collide; deleting a board deletes its cards; and every direct write over the
REST API is a 403 while reads still work.

## What you have now

A board whose rules can't be skipped, because the rules are the only door. Next, the board on
screen, in the browser and in the terminal.
