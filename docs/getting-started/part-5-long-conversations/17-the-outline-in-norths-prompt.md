---
title: "Chapter 17: The outline in North's prompt"
description: "Replace chat's history View: an agent is sent the summary lines first, then the recent messages whole, and chat reads only those, from where the history plugin says they start."
section: Getting Started
order: 170
status: stable
---

# Chapter 17: The outline in North's prompt

> Part 5, long conversations · Requires: Chapter 16 · Code: `lesson-5.2`

## The pain

Every message of a long chat now has its line, and North never reads one. `/prompt` still shows the
whole conversation: the lines sit in the store while North is sent message after message, until the
chat outgrows its prompt.

## The problem

What an agent is sent is chat's work, not yours: its prompt View (`thread.prompt`) puts the
instructions, the contexts and the conversation in the order the cache wants. You can't rewrite it,
and you shouldn't: everything else in the prompt must stay as it is. Two things have to change, and
only those: which messages chat reads for the prompt (not the ones the outline stands for), and how
the conversation is laid out (the lines first, then the messages still whole).

## The solution

Chat leaves both open, as Views. Its prompt View asks a View named `history.since` where whole
messages start, and lays out the conversation with a View named `history`:

Copilotz's `plugins/agents/chat/views/prompt.ts`:

```ts
// A summarized history (another plugin's) sends messages whole only from where it says;
// until it knows (null), nothing is read.
const since = ctx.show("history.since", thread);
const seen = since === null ? undefined : ctx.db.collection<Message>("message").query<Message[]>(
  "visible",
  { thread: thread._id, agent: name, ...(typeof since === "string" ? { since } : {}) },
);
// …
  history: (ctx.show("history", { thread, messages: history, from }) ?? []) as LlmMessage[],
```

Chat has no `history.since` View, so without the history plugin it reads its own window (`since` is
`undefined`). Its `history` View sends each message through its `llm.message` View. Plugins merge in
order, and a later plugin's View replaces an earlier one's of the same name: history comes after
chat in `app.ts`, so its Views are the ones chat finds.

### Where whole messages start

`views/since.ts`:

```ts
export const sinceView = (thread: Outlined, ctx: ViewContext): string | null | undefined => {
  const state = ctx.db.collection<Outline>("outline").findOne({ _id: thread._id });
  if (state.status !== "ready") return null;
  const outline = state.value;
  if (outline?.boundary) return outline.since;
  return outline?.complete ? "" : undefined;
};
```

Inside a View, a read returns a state: `ready` with its value, or not yet. Until the outline is
read, chat reads nothing (`null`). Once the tail has cut, whole messages start at `since`, when the
first message still whole was written. Before that, an outline that has weighed the thread from its
first message says `""`: every message, from the first. A thread from before the plugin was added
says `undefined`, and keeps chat's own window.

### The conversation, as North reads it

`views/history.ts`:

```ts
export function historyView(
  { thread, messages, from }: { thread: Outlined; messages: Message[]; from?: string },
  ctx: ViewContext,
): LlmMessage[] {
  const whole = (list: Message[]) =>
    list.flatMap((m) => (ctx.show("llm.message", m) ?? []) as LlmMessage[]);
  if (!thread.outlined) return whole(messages);
  const state = ctx.db.collection<Outline>("outline").findOne({ _id: thread._id });
  if (state.status !== "ready" || !state.value?.boundary) return whole(messages);
  const { since = "", cutAt = "" } = state.value;
  // A model's state from before the last cut was thought with the old start: it goes.
  const fresh = (m: Message) => m.state && m.at <= cutAt ? { ...m, state: undefined } : m;
  const recent = messages.filter((m) => m.at >= since).map(fresh);
  // Lines older than the agent's window by age go, as their messages did.
  const all = state.value.lines as Line[];
  const shown = from ? all.filter(([, , , until]) => until !== undefined && until >= from) : all;
  if (!shown.length) return whole(recent);
  const ids = shown.map(([level, index]) => node(thread._id, level, index));
  const found = ctx.db.collection<Summary>("summary").find({ _id: { $in: ids } });
  if (found.status !== "ready") return [];
  // …
  return [
    { role: "user", text: `${HEADER}\n<chat>\n${lines.join("\n")}\n</chat>` },
    ...whole(recent),
  ];
}
```

A thread never summarized (`outlined` isn't set) never reads an outline: it gets every message, as
chat's own View would send it. A summarized one gets one message with the outline, then the messages
still whole, each through its own View as before. Each line goes through the `summary` View, so
another plugin could show lines differently:

`views/summary.ts`:

```ts
export function summaryView(s: Summary): string {
  const n = 2 ** s.level;
  return `${s.index * n}+${n}|${s.text.replace(/\s*\n\s*/g, " ")}`;
}
```

`0+1|Ana → north: Plan the launch for December` is message 0's own line; `8+4|…` covers messages 8
to 11. The header before the lines tells the model how to read them.

`from` is where an agent's window by age starts (an agent with `history: { maxAge }` in its
settings): chat already leaves out older messages, and this View leaves out the lines whose newest
message is older, as each line says (`until`).

### Why it holds the cache

The outline and the tail only grow at their end between batches: a new message adds to the tail; a
cut moves messages to the end of the outline, all at once. So between cuts, each prompt starts
exactly as the last one did, and the provider reads that part from its cache. A model's own state
(its thinking, sent back to the model that wrote it) is bound to how the conversation started when
it was written, so after a cut, the state of messages written before it (`cutAt`) is left out.

`mod.ts` gets one line:

```ts
views: { history: historyView, "history.since": sinceView, summary: summaryView },
```

## Run it

The same conversation as in Chapter 16, with the same small tail:

```text
$ printf 'Plan the launch for December\n…\nThe price stays at 49\n/prompt\n' | COMPASS_ME=ana \
  COMPASS_TAIL=40,80 OPENAI_API_KEY= node --disable-warning=ExperimentalWarning terminal.ts
…
── history (cached as it grows)
user      Earlier in this conversation, summarized, oldest first. Each line is
id+n|text: the n messages from id on. zoom(id, n) opens a line into the two it
was made fr…
user      Ana: Ship on the 12th
assistant You said: Ana: Ship on the 12th
user      Ana: Book the studio
assistant You said: Ana: Book the studio
user      Ana: The price stays at 49
assistant You said: Ana: The price stays at 49
── turn (what's new, then kept in the history)
<context name="today">
It's Sunday, 8 November 2026, 08:15 (America/Sao_Paulo).
</context>
```

Where Chapter 16 sent sixteen messages, North is sent the outline and the last three exchanges.
`/prompt` shows each message's first 160 characters; the first one holds the lines of the ten
messages before them.

Ten, not Chapter 16's eight: chat tells North a turn context (`today`) again when the conversation
it's sent no longer has the message it was last told in. Once the outline stands for that message,
North's next reply carries the date again, weighs more, and the tail cuts further.

## Check it

`tests/prompt.test.ts` checks the layout (the outline with `0+1|S0`, `1+1|north → Ana: ok` and
`2+1|S2`, then the messages from the fourth on, whole), that a message that doesn't make the tail
cut only adds to the end of the prompt, and that a long conversation's outline merges its oldest
pairs first: coarse first, fine last. `tests/parity.test.ts` now compares the prompt too.

## Also in this chapter

- `tests/start.ts`: a `prompt` helper (`thread.prompt` for North) and `text`, exported.

`git diff lesson-5.1 lesson-5.2` shows every change.

## What you have now

A conversation that never outgrows the prompt: North is sent the recent messages whole and the rest
as lines, coarser with age, and the prompt changes in batches the provider's cache can follow. But a
line is a summary: next, North gets a way to open one.
