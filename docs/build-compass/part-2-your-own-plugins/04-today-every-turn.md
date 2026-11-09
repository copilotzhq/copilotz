---
title: "Chapter 4: Today, every turn"
description: "Tell every agent today's date with a turn context, and see why a prompt has a stable part and a part that changes: the provider's prompt cache."
section: Build Compass
order: 40
status: stable
---

# Chapter 4: Today, every turn

> Part 2, your own plugins · Requires: Chapter 3 · Code: `lesson-2.1`

## The pain

Ask North what day it is, and it guesses: a model knows only what it was trained on and what it's
told. A team that plans, dates its work and schedules it needs the date, every time.

## The problem

The obvious place for the date is North's instructions. But that part of the prompt is cached by the
provider: from one call to the next, only what changed is processed at full price. Putting something
that changes in the stable part breaks the cache on every call, and every call pays for the whole
prompt again. The date has to go somewhere else.

## The solution

Chat's prompt has a place for exactly this: **turn contexts**. A `turn` context goes after the
conversation, and it's sent only when it says something new; once told, it's kept on the turn's
first message, so the next call starts with everything the last call had. The cached part never
changes, and the date is always there.

Compass's View for it (`plugins/compass/views/now.ts`):

```ts
/**
 * Today's date and the time where you are (this machine's time zone), after
 * the conversation each turn, so the cached prompt before it never changes:
 * agents plan, date cards and schedule from it. Compass on a server says it in
 * UTC, for everyone; on your own machine, your clock is the one that counts.
 */
export const nowView = (): string => {
  const now = new Date();
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: zone,
  });
  const time = now.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: zone,
  });
  return `It's ${day}, ${time} (${zone}).`;
};
```

And in `mod.ts`, the View and where it goes:

```ts
views: {
  "context:compass": charterView,
  "context:today": nowView,
},
resources: {
  agents: { north },
  context: {
    compass: { place: "system", agents: TEAM, instructions: true },
    // The date, after the conversation: every agent's, new each turn.
    today: { place: "turn" },
  },
},
```

A context with no `agents` goes to every agent. Chat wraps a context's text in a
`<context name="today">` tag, marked as information rather than instructions, except the ones that
say `instructions: true` (the charter, the app's own words on how its agents work).

This is also the first change where single-user Compass differs from Compass on a server. The server
says the time in UTC, because its people are everywhere. On your own machine, the machine's time
zone is yours: at ten at night in São Paulo, North shouldn't say it's already tomorrow.

## Run it

```text
ana → north › Hi North. What day is it?
north › It's Saturday, 7 November 2026.
ana › /prompt
…
── turn (what's new, then kept in the history)
<context name="today">
It's Saturday, 7 November 2026, 22:13 (America/Sao_Paulo).
</context>
```

`/prompt` shows what North would be sent _now_. The date shows in the turn part only when it says
something new: here, the minute changed since North was told. Within the same minute the turn part
says `(nothing new)`, and the date sits in the history, on the message of the turn it was told in,
where every later call finds it. That's what the test checks.

## Check it

```ts
test("today's date comes after the conversation, and stays where it was told", async () => {
  const runtime = await createRuntime({
    store: memoryStore(),
    plugins: plugins({ you: { person: "ana" } }),
  });
  try {
    const { thread } = await runtime.call<{ thread: string }>("chat.send", {
      text: "What day is it?",
    });
    await runtime.idle();
    const { system, history } = await runtime.query<{ system: string[]; history: unknown[] }>(
      "thread.prompt",
      { thread, agent: "north" },
    );
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    // Never in the cached part, which would change with every date…
    assert.ok(!system.join("\n").includes("It's "));
    // …but told in the turn, and kept there in the conversation, so the next call starts the same.
    assert.ok(JSON.stringify(history).includes(`(${zone}).`));
  } finally {
    await runtime.close();
  }
});
```

## What you have now

The prompt's two parts: what's stable (instructions, the charter, who's here) and what's new each
turn. Any plugin adds to either with a `context` resource and a View. Next: keeping it all.
