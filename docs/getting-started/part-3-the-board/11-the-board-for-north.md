---
title: "Chapter 11: The board for North"
description: "The third place the board shows is the model's prompt: six tools, offered wherever a conversation is in a space, that call the same Actions people use, and read back as plain text."
section: Getting Started
order: 110
status: stable
---

# Chapter 11: The board for North

> Part 3, the board · Requires: Chapter 10 · Code: `lesson-3.3`

## The pain

You agree on the work with North in a chat ("let's record the trailer, then review the page"), and
then you copy it to the board by hand. North can talk about the board but can't touch it.

## The problem

Giving an agent the board must not give it a second, looser way in. Whatever an agent does to a card
should pass the same rules a click does, be recorded the same way, and reach only the space its
conversation is in, for the person it works for. And a model reads differently from a person: it
needs ids to act on, short lines, no pixels.

## The solution

**Tools**: chat's `tools` resource kind. A tool is what a model may call: a description the model
reads, a JSON Schema input, and a `run`. Boards declares six, `list_boards`, `read_board`,
`create_board`, `create_card`, `update_card` and `move_card`, and each one is small: it finds the
conversation's space and resolves the names a model uses ("Doing", "North", "the launch board") to
ids. `list_boards` and `read_board` only read; the four that change the board **call its Actions, by
name**.

`resources/create-card.ts`:

```ts
export const createCard = tool({
  offer: inSpace,
  description: "Add a card to a board in this space: one real outcome, with its owner " +
    "(assignee), what done looks like and any blocker in its description, and an honest " +
    "column. The board is the space's first unless you name one; the column, its first.",
  input: {
    type: "object",
    properties: {
      title: { type: "string", minLength: 1, maxLength: 300 },
      board: { type: "string", description: "The board's name or id." },
      column: { type: "string", description: "The column's name or id." },
      description: {
        type: "string",
        description: "Markdown: the outcome, how we'll know it's done, any blocker.",
      },
      assignee: {
        type: "string",
        description: "Who owns it: me (you), an agent's name, or a person's name or email.",
      },
      // … labels, due, at
    },
    required: ["title"],
  },
  run: async (input, ctx) => {
    const space = await spaceOf(ctx);
    if (!space) return NOWHERE;
    const board = await boardNamed(ctx, space, input.board);
    if (typeof board === "string") return board;
    const column = input.column ? columnNamed(board, input.column) : board.columns[0];
    if (typeof column === "string") return column;
    // … the owner, by name
    try {
      const made = await ctx.call<{ card: string; title: string }>("card.create", {
        board: board._id,
        title: input.title,
        column: column.id,
        // …
      });
      const card = { _id: made.card, title: made.title };
      return onBoard(
        `Created ${cardNamed(card)} in ${column.name}${owner ? `, for ${shown(owner)}` : ""}`,
        board,
      );
    } catch (error) {
      return refused(error);
    }
  },
});
```

Three things make it safe and readable:

- **`offer: inSpace`.** A tool with an `offer` is offered without being listed in an agent's
  `tools`, where `offer` says so: here, wherever the conversation is in a space. Out of a space, the
  model never sees it. (Since Chapter 7 every chat a person starts is in a space, so North has them
  everywhere you talk to it.)
- **The Action does the work.** `ctx.call("card.create", …)` runs as the agent, acting **for** the
  person it works for: the rules apply to every read and write it makes, the Action's own checks
  run, and the record says `{ kind: "agent", id: "north", for: { kind: "person", id: "ana" } }`. (An
  Action's `allow` is for callers from outside, a browser or a script; plugin code, a tool included,
  calls any Action, so the tool is where you decide what an agent may do.) A tool is never a back
  door; it's one more caller of the same Actions.
- **Text for the model.** A tool returns what the model reads: short lines with the ids it needs
  next (`read_board` lists each card as `- [id] title · owner · labels · due`). A refusal comes back
  as text too, so the model can read why and try again, instead of the turn failing.

On the web, each call shows in the chat as a card linking to the board: chat's `toolViews` resource
names a View for each tool (`board.step`), so a tool's result looks one way to the model and another
to you.

### Telling North

North's instructions get one line, and the charter a section on how the board carries the work:

```text
4. Anything longer than one step goes on the board, with an owner and "done when".
```

```text
**The board carries the work, not the chat.** A later turn, yours too, won't find the work as you
left it: read the board before you act, and update it as you work, not at the end, so anyone can
pick up from it.

**The board** (`list_boards`, `read_board`, `create_board`, `create_card`, `update_card`,
`move_card`), for anything over one step: one real outcome per card, with its owner (you or an
agent), what done looks like, an honest column, and any blocker. Read it before you change it;
update it when the state changes. No cards for process nobody needs. Say what you did ("I added it
to the board"), not which tool you called, and never before the tool says it's done.
```

The last sentence comes from watching models work: some announce what they'll do instead of doing
it, or say it's done before the tool answers. The charter says what you want, in plain words.

## Run it

In a new space, ask in the browser: "Put on the board: record the trailer, and review the course
page." North lists the boards, finds none, makes one, adds two cards, and only then answers. The
chat shows each tool call as a card (`board.step`), then the answer:

```text
No boards in this space yet. Make one with create_board
Made the board “Course launch” (/board/cf6e36f039df), with columns Backlog, To do, Doing, Blocked,
In review, Done. Add cards with create_card                                       Course launch
Created “Record the trailer” in To do, for Ana                                     Course launch
Created “Review the course page” in To do, for Ana                                 Course launch

I added both to the Course launch board in To do, assigned to you. "Record the trailer" is done
when it's recorded and ready for review; "Review the course page" is done when it's reviewed and
any needed changes are identified.
```

The model reads a fuller text for each call (the card's id, and the board it's on); the card in the
chat is the `board.step` View of it, with a link to the board.

Open the Board tab, or `/board` in the terminal: the same two cards. `/prompt` shows the six tools
at the top of North's prompt:

```text
── tools · north
list_boards, read_board, create_board, create_card, update_card, move_card
```

## Check it

`tests/tools.test.ts` runs a scripted model (the `script` adapter of Chapter 6) that calls
`create_card` then `read_board`, and checks what it read back; another checks that tools can't reach
a board in another conversation's space. And `tests/parity.test.ts` runs the same Actions and tool
calls on Copilotz's boards (on Copilotz's identity and spaces) and on yours, and compares every
answer.

## What you have now

Compass: an agent of your own, spaces, and a board that people and agents share, every change on the
record, shown in the browser, the terminal and the model's prompt. Every plugin besides the agentic
core is yours, with the same contract as Copilotz's.

From here, the course continues with the rest of Compass's plugins: documents with versions and
merges, history that keeps long conversations within the prompt (Processors and Views together),
memory across conversations, skills, routines on a schedule, web search, and agents reading their
space's other conversations.
