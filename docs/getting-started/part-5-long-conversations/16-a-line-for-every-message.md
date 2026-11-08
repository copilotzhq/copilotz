---
title: "Chapter 16: A line for every message"
description: "Rebuild Copilotz's history plugin, starting with its Processor: as messages leave the recent tail, each gets a line, and pairs of lines merge up a binary tree, with a cheap model only for what's long."
section: Getting Started
order: 160
status: stable
---

# Chapter 16: A line for every message

> Part 5, long conversations · Requires: Chapter 15 · Code: `lesson-5.1`

## The pain

You plan the launch with North for a week, in one chat: the trailer, the page, who writes the copy,
the price. On Monday you ask "what did we settle about the price?", and North doesn't know. The chat
still has every message, but North isn't sent them all: chat sends an agent its latest 50 to 100 (a
window that moves 50 at a time), and the price was settled before those.

## The problem

Sending everything doesn't work either: a long chat outgrows the model's prompt, and every message
sent costs every turn. What North needs is the recent messages whole and the rest in short form,
without losing any of it. Three things make that hard:

- **The short form must be written before it's needed**, not while North is answering: the person
  would wait for it.
- **It costs a model call**, so only what's long should be summarized, and only once.
- **The prompt cache.** Providers charge much less for the part of a prompt that starts exactly as
  the last one did. A summary that changes every turn breaks that, and costs more than it saves.

Copilotz's `history` plugin solves this with what the course already has: a Processor that writes
summaries as messages come, and Views that put them in the prompt. You rebuild it in three lessons;
this one writes the summaries.

## The solution

### A line, then a tree

Every shared message gets a **line** (level 0), and two adjacent lines merge into one at level 1,
two of those at level 2, and so on: a binary tree over the conversation. A node at `level` covers
2^level messages, from `index` × 2^level on. The `summary` collection keeps it, with the same fields
as Copilotz's:

`collections/summary.ts`:

```ts
const summarySchema = {
  type: "object",
  properties: {
    thread: { type: "string" },
    /** A node at `level` covers 2^level messages, from `index` × 2^level on. */
    level: { type: "integer" },
    index: { type: "integer" },
    text: { type: "string" },
    bytes: { type: "integer" },
    /** Level 0: the message it summarizes. */
    message: { type: "string" },
    at: { type: "string" },
  },
  required: ["thread", "level", "index", "text", "bytes", "at"],
} as const;
```

A short message is its own line, and two short lines are just joined: only what's longer than a line
(512 bytes by default) asks the model.

`processors/summarize.ts`:

```ts
export async function summarize(
  ctx: Context,
  config: HistorySettings,
  index: number,
  m: Message,
  { get, put }: Nodes,
) {
  const text = lineOf(m, await namesOf(ctx));
  // Itself when short; else compressed, with the lines before it as context.
  let own = text;
  if (size(text) > config.line) {
    // … the four lines before it, as <chat>
    own = await write(
      ctx,
      config,
      `Compaction: compress message ${index} into one line of {limit}\n` +
        (before.length ? `<chat>\n${before.join("\n")}\n</chat>\n` : "") +
        `<input>\n${text}\n</input>`,
    );
  }
  put(0, index, own, m._id);

  // An odd index completes a pair: the two merge into their parent, and so on up.
  for (let [level, i] = [0, index]; i % 2 === 1; [level, i] = [level + 1, (i - 1) / 2]) {
    const [left, right] = [await get(level, i - 1), await get(level, i)];
    if (!left || !right) break;
    const joined = `${left.text}\n${right.text}`;
    const n = 2 ** level;
    const line = size(joined) <= config.line ? joined : await write(
      ctx,
      config,
      `Compaction: merge lines ${(i - 1) * n}+${n} and ${i * n}+${n}, adjacent, into one line ` +
        `of {limit}\n<input>\n${left.text}\n${right.text}\n</input>`,
    );
    put(level + 1, (i - 1) / 2, line);
  }
}
```

`write` asks the summarizer with `ctx.call("llm.generate", …)`, the models plugin's Action, with
instructions copied from Copilotz's (what people said matters most; copy names, numbers and ids
exactly; credit each item to who said it). When a line comes back too long, it asks again, showing
where the limit falls; after three tries it cuts the shortest one.

### The tail, and when lines are written

A line is only read once its message has left the **tail**: the recent messages an agent is sent
whole. So that's when it's written, and a conversation that stays short never calls the model. The
Processor, `history.compact`, follows every message (`message.created`), one thread at a time, in
order, and measures what each costs a prompt in estimated tokens (`processors/weight.ts`: about four
bytes a token, through the message's `llm.message` View, with its files by what they are).

The tail grows to its maximum, then the oldest messages leave it until it's down to its minimum,
each shared one with its line:

`processors/compact.ts`:

```ts
if (tokens > config.tail[1]) {
  while (tokens > config.tail[0] && tail.length > 1 && !kept()) {
    // What was written up to this message was thought with the old start.
    cutAt = m.at;
    tokens -= tail.shift()!;
    const left = tailAt.shift()!;
    if (left > gone) gone = left;
    const id = tailIds.shift()!;
    if (tailSteps.shift()) continue; // A step leaves without a line.
    if (!await get(0, boundary)) {
      const message = await ctx.db.collection<Message>("message").findOne({ _id: id });
      if (message) await summarize(ctx, config, boundary, message, { get, put });
    }
    const line = await get(0, boundary);
    if (line) {
      // When its message was written: an agent's window by age leaves older lines out.
      lines.push([0, boundary, line.bytes, left]);
      bytes += line.bytes + 1;
    }
    boundary++;
  }
  // …
}
```

That's the **sawtooth**: the tail grows a message at a time, and shrinks in one batch. Between
batches, the start of what an agent is sent doesn't move, so the provider's cache holds it. The four
newest shared messages always stay whole (`KEPT`), however much they weigh. An agent's tool steps
(private messages) count in the tail, since their agent is sent them, but leave it without a line:
summaries keep what was said.

The lines that left make the **outline**, which grows the same way: past its maximum (128 KB), the
pairs that are most overdue merge into their parent until it's back under 64 KB, so older parts of
the conversation get coarser. The `outline` collection keeps it, one document per thread: which
lines are shown, where whole messages start (`boundary`, `since`) and the tail's weights. Everything
the batch made commits together, in one transaction, and the thread is marked `outlined` the first
time, so threads never summarized never look for an outline.

### Settings, and the app

What the plugin needs from the app is the `history` resource, the same as Copilotz's: the
`summarizer` model, and budgets it can lower.

`shared/settings.ts`:

```ts
export const DEFAULTS: Omit<HistorySettings, "summarizer"> = {
  line: 512,
  tail: [16_000, 48_000],
  outline: [64_000, 128_000],
};
```

`mod.ts` checks at startup that a summarizer is named and that the models plugin knows it
(`models.check`). In `app.ts`, history comes after chat, and the settings name a model alias, as
North's does:

```ts
  // What writes the lines of long chats. Offline, the fake model: short messages need none.
  summaries: settings.openai ? { model: "openai/gpt-6-luna", effort: "none" } : "fake/echo",
},
history: { summarizer: "summaries", ...(settings.tail ? { tail: settings.tail } : {}) },
```

`Settings.tail` is there to see it work on a short chat: the terminal reads `COMPASS_TAIL=40,80`.

What's left out of Copilotz's history, for one person: the summarizer's calls aren't tagged for
metering by space, lines aren't renamed when people's names become known (here there's only you),
and a PDF's pages are guessed from its size, not counted.

## Run it

In the terminal, with a small tail (`COMPASS_TAIL=40,80`), have a short conversation of eight
messages (offline, North answers "You said: …"), then look in the store:

```text
$ sqlite3 -header -column .data/compass.sqlite 'SELECT "index", text FROM summary WHERE level = 0'
index  text
-----  --------------------------------------------------------
0      Ana → north: Plan the launch for December
1      north → Ana: You said: Ana: Plan the launch for December
2      Ana → north: We need a trailer
3      north → Ana: You said: Ana: We need a trailer
4      Ana → north: And a landing page
5      north → Ana: You said: Ana: And a landing page
6      Ana → north: Who writes the copy?
7      north → Ana: You said: Ana: Who writes the copy?
$ sqlite3 -header -column .data/compass.sqlite 'SELECT level, count(*) AS lines FROM summary GROUP BY level'
level  lines
-----  -----
0      8
1      4
2      2
3      1
```

Eight of the sixteen messages left the tail, and each pair merged up the tree, all short enough to
be joined: no model was asked. `/prompt` still shows all sixteen messages: nothing reads the lines
yet. That's the next chapter.

## Check it

`tests/lines.test.ts` runs a scripted summarizer (`S<n>` for message n) with a tail of 25 to 50
tokens: two exchanges call nothing; past the tail, Ana's long messages are compressed and North's
short "ok" is its own line; the first pair is joined without a call; and erasing a chat
(`chat.erase`) erases its lines. `tests/parity.test.ts` has the same conversation of twelve
exchanges summarized by Copilotz's history and by yours, and compares what the summarizer was asked,
every line of the tree, and the outline.

## Also in this chapter

- `processors/erase.ts`: on `thread.deleted`, a chat's lines and outline go with it.
- `shared/lines.ts`: a node's id (`thread:level:index`), a line's size in bytes, and a message as
  one line (`Ana → north: …`), with your name from identity's `person`.
- `contract.ts`: the types other code may import (`HistorySettings`, `Outline`, `Line`, `Summary`).

`git diff lesson-4.4 lesson-5.1` shows every change.

## What you have now

A Processor that summarizes each conversation as it grows: one line per message, a tree of merged
lines, written in batches, with a cheap model only for what's long. Next, North reads them.
