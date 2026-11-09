---
title: "Chapter 18: Zoom"
description: "A summary line never replaces its messages: the zoom tool, offered once a thread is summarized, opens a line into the two it was made from, down to the message itself, whole."
section: Build Compass
order: 180
status: stable
---

# Chapter 18: Zoom

> Part 5, long conversations · Requires: Chapter 17 · Code: `lesson-5.3`

## The pain

North is sent a long chat's start as lines now, and a line is short on purpose: "Ana: price stays at
49; north: ok". When you ask "what exactly did we say about the price, and why?", the answer may be
in the message, not in its line. North can only guess, or ask you to repeat yourself.

## The problem

Every message is still in the chat, whole; North just can't reach it. It needs a way to open a line
that costs nothing until it's used, works at any level of the tree (a line at level 3 stands for
eight messages), and reads a message the way North would have been sent it, files and all. And it
should be offered only where there's something to open: a tool listed in every prompt costs every
prompt.

## The solution

A tool: chat's `tools` resource kind, as the board's are (Chapter 11). `zoom(id, n)` takes a line as
the outline writes it (`id+n|text`: the n messages from id on) and answers with the two lines it was
made from, n/2 messages each. `zoom(id, 1)` answers with the message itself.

`resources/zoom.ts`:

```ts
export const zoom = tool({
  // Only where there is a summary to open.
  offer: (_agent, thread, ctx) => {
    if (!(thread as Outlined).outlined) return false;
    const state = ctx.db.collection<Outline>("outline").findOne({ _id: thread._id });
    return state.status === "ready" && Boolean(state.value?.boundary);
  },
  description:
    "Open a line of the summarized conversation: zoom(id, n) with the line's id+n gives the two " +
    "lines it was made from (n/2 messages each); zoom(id, 1) gives the message whole. Whenever you " +
    "need something from earlier, find its latest mention in the summary and zoom until you have " +
    "it whole, before you act, guess or ask.",
  input: {
    type: "object",
    properties: {
      id: { type: "integer", description: "The line's first message, as in id+n." },
      n: { type: "integer", description: "How many messages the line covers, as in id+n." },
    },
    required: ["id", "n"],
  },
  run: async (input, ctx) => {
    const [id, n] = [Number(input.id), Number(input.n)];
    // A line's n is a power of two, and its id a multiple of it.
    if (!Number.isInteger(id) || !Number.isInteger(n) || n < 1 || n & (n - 1) || id % n) {
      return "Error: zoom takes a line's id and n, as written: id+n.";
    }
    const nodes = ctx.db.collection<Summary>("summary");
    if (n === 1) {
      // … message `id`, through its llm.message View, as the agent is sent it
      return `${id}+1|${text}`;
    }
    // The two halves, one level down.
    const [level, half] = [Math.log2(n) - 1, n / 2];
    const children = await Promise.all([
      nodes.findOne({ _id: node(ctx.thread, level, id / half) }),
      nodes.findOne({ _id: node(ctx.thread, level, id / half + 1) }),
    ]);
    if (!children[0] || !children[1]) return `Error: no line ${id}+${n} here.`;
    return children.map((s) => summaryView(s!)).join("\n");
  },
});
```

Four things to see:

- **`offer` as a function.** Chat calls it while it builds the prompt, inside its View, so it reads
  like one: the thread says it's `outlined` (the Processor set that the first time it cut), and the
  outline has lines. A conversation that was never summarized doesn't see the tool at all.
- **The tree does the addressing.** Line `id+n` at level log2(n) has its halves at level log2(n) −
  1, index `id / (n/2)` and the next one. No search, two reads.
- **A message whole, as it was sent.** For `n` = 1, the line's `message` field names the message,
  and zoom shows it through `llm.message` as the calling agent sees it: a text file's content, a
  transcript. So the summary loses nothing that a call or two can't bring back.
- **Errors are text.** A wrong id or n comes back as a sentence the model reads and corrects, not as
  a failed turn.

North needs no new instructions: the outline's header tells it how lines read and that `zoom` opens
them, and it's in the prompt exactly when the tool is.

`mod.ts` gets one line:

```ts
resources: { tools: { zoom } },
```

## Run it

The conversation of the last two chapters, then a message that names the tool. Offline, the fake
model calls a tool you name, with no input; chat checks a tool's input against its schema before it
runs it, and answers with what's missing. Then `/prompt`:

```text
Ana → north › zoom into the start
  ⚙ north: zoom → Error: zoom input: Instance does not ha…
north › The tool says: Error: zoom input: Instance does not have required
property "n". (#)
ana › /prompt
── tools · north
zoom, list_boards, read_board, create_board, create_card, update_card,
move_card, list_documents, read_document, write_document, append_document,
edit_document
```

`zoom` is offered first, before the board's and the documents' tools: history comes before both in
`app.ts`. In a chat that isn't summarized yet, it isn't listed at all.

## Check it

`tests/zoom.test.ts` uses the scripted model, which calls `zoom` with the id and n it's told: zoom
isn't offered in a chat of one exchange and is once it's summarized; `zoom(0, 2)` answers `0+1|S0`
and `1+1|north → Ana: ok`; `zoom(0, 1)` answers Ana's first message whole; `zoom(1, 2)` (not a line)
and `zoom(64, 1)` (no such message) answer with an error the model can read. `tests/parity.test.ts`
now also compares the tools offered and four zooms, on Copilotz's history and on yours.

## Also in this chapter

- `tests/start.ts`: the scripted model calls `zoom` when the last message ends with `zoom <id> <n>`,
  and keeps what North was sent (`turns`), to read the tool's answer.

`git diff lesson-5.2 lesson-5.3` shows every change.

## What you have now

Long conversations, whole: every message stays in the chat, North is sent the recent ones whole and
the rest as lines, coarser with age, in a prompt the provider's cache can follow, and any line opens
back down to its message. Three of Copilotz's primitives did it together: a Processor that writes in
the background, Views that shape the prompt, and a tool.
