---
title: "Chapter 21: Remember, recall, forget"
description: "Three tools with Copilotz's names and inputs let agents keep, search and drop memories; the charter says what's worth keeping, and the terminal and the web show what's kept."
section: Getting Started
order: 210
status: stable
---

# Chapter 21: Remember, recall, forget

> Part 6, memory · Requires: Chapter 20 · Code: `lesson-6.3`

## The pain

You tell North "I'm allergic to peanuts, keep that in mind", and it says it will. It won't: nothing
writes memories yet. And when a memory is wrong, there's no way to say so.

## The problem

The agent is the one who knows, mid-conversation, that something is worth keeping, so the agent has
to be able to write it. But a model writing to its own memory needs guard rails: it must say whom a
fact is about, it shouldn't pile up near-copies, it must be able to correct and drop what's wrong,
and nothing it writes should vanish without a trace. And you need to see what it kept.

## The solution

### Three tools

Like the board's tools in Chapter 11, they're chat's `tools` resource kind, with Copilotz's names
and inputs. Each is offered to every agent with memory (`offer`), with no need to list it in an
agent's `tools`. `resources/remember.ts`:

```ts
export const remember = tool({
  offer: (agent, _thread, ctx) => applies(ctx, agent),
  description:
    "Remember something worth knowing in later conversations: one self-contained statement " +
    "naming who it is about, and why it matters if that isn't obvious. about: the person it " +
    // …
    "something you already know updates it; give the id to correct a specific memory.",
  input: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1 },
      about: { type: "string" },
      core: { type: "boolean" },
      id: { type: "string", description: "A memory to update, as [id]." },
    },
    required: ["text"],
  },
  run: async (input, ctx) => {
    const [scope, trigger] = await Promise.all([
      scopeFor(ctx),
      ctx.db.collection<Message>("message").findOne({ _id: ctx.trigger }),
    ]);
    return await keep(ctx, {
      ...(scope.in ? { in: scope.in } : {}),
      text: input.text,
      about: aboutOf(input.about, scope, ctx, trigger),
      ...(input.core !== undefined ? { core: input.core } : {}),
      by: ctx.agent,
      source: { thread: ctx.thread, message: ctx.trigger },
    }, input.id);
  },
});
```

The work is Chapter 19's `keep`: what the memory repeats, it updates. `about` is said the way a
model says it, and `aboutOf` (`shared/conversation.ts`) turns it into a subject: a person here by
name ("Ana", from identity's `person.names`), `me` (the agent itself), `thread`, `everyone`; with
nothing given, the person it's talking with. The memory lives in the conversation's space, and
remembers the message it came from.

`recall` (`resources/recall.ts`) is Chapter 19's `search` with the core ones included, where the
conversation is, or in another space it names with `in`:

```ts
run: async (input, ctx) => {
  const here = await scopeFor(ctx);
  const scope = input.in ? { ...here, in: input.in } : here;
  const found = await search(ctx, scope, input.query, input.limit ?? LIMIT.recall, { core: true });
  if (!found.length) return "Nothing remembered about that.";
  return found.map((m) => line(m, ctx.agent)).join("\n");
},
```

`forget` (`resources/forget.ts`) never deletes. It marks the memory `forgotten`, keeps why in `was`,
and drops its embedding, so nothing finds it again, and the record keeps it:

```ts
await memories.updateOne({ _id: input.id }, {
  $set: {
    forgotten: now(),
    ...(input.why ? { was: `${found.text} (forgotten: ${input.why})` } : {}),
  },
  // Out of recall by meaning too.
  $unset: { embedding: 1 },
});
return `Forgotten [${input.id}].`;
```

### What's worth keeping

Tools say how; the charter says what. Compass's Memory paragraph joins "How the work moves"
(`plugins/compass/resources/charter.ts`):

```text
**Memory** (`remember`, `recall`, `forget`): only lasting context the person has confirmed
and that will matter later, never the task: plans, decisions and blockers go on the board or in
the document. Never a guessed trait; nothing sensitive unless they ask. Correct a wrong memory
instead of adding one that contradicts it.
```

### Seeing what's kept

The terminal gets `/memories` (`memoryTerminal`, in `terminal.ts`): the `list` query, each memory
through the `terminal.memory` View, core ones starred.

```ts
export const memoryLine = (m: Memory, ctx: ViewContext): string => {
  const ids = [...(m.about.startsWith("person:") ? [m.about.slice("person:".length)] : []), m.by];
  const names = ctx.db.collection("person").query<Record<string, string>>("names", { ids }).value ??
    {};
  return `${dim(`[${m._id}]`)} ${m.core ? accent("★ ") : ""}${m.text} ${
    dim(`(${subject(m.about, undefined, names)}, by ${names[m.by] ?? m.by})`)
  }`;
};
```

The web gets `memoryWeb` (in `front.ts`): a Memories section in each space's Settings, Copilotz's
`spaceTabs` entry, `under: "settings"`; the `memories` View groups what was learned there by whom
it's about, and at `/memories` shows everything.

```ts
export const memoryWeb: Plugin = definePlugin({
  name: "memory-web",
  requires: ["web-shell"],
  views: { memories: memoriesView },
  resources: {
    spaceTabs: {
      memories: {
        title: "Memories",
        view: "memories",
        icon: "sparkles",
        under: "settings",
        order: 20,
      },
    },
  },
});
```

## Run it

`/prompt` now lists the three tools after the board's. Offline, the fake model calls a tool whose
name you write, with no input, so the tool's input check answers instead, and nothing is kept:

```text
$ printf 'Please remember that I like tea.\n/memories\n' | COMPASS_ME=ana COMPASS_DATA=.data/r63.sqlite OPENAI_API_KEY= node --disable-warning=ExperimentalWarning terminal.ts
Compass
Ana → north › Please remember that I like tea.
  ⚙ north: remember → Error: remember input: Instance does no…
north › The tool says: Error: remember input: Instance does not have required
property "text". (#)
ana › /memories
Nothing remembered yet.
```

With a key, North writes the sentence itself; `/memories` then lists it, and so does the space's
Settings → Memories. The tests drive the tools with a scripted model:

```text
✔ tool answers, kept memories and the prompt match Copilotz's memory (603.7755ms)
✔ North remembers, recalls what it knows, and forgets (159.489709ms)
✔ recall looks where the conversation is, and in another space only when asked (50.717084ms)
✔ without an embedder, recall still matches words (48.20075ms)
```

## Check it

`tests/tools.test.ts` runs a scripted North (`tests/agent.ts`, a scripted model as in Chapter 11):
it remembers a core memory, is told `Already remembered` when it repeats it, writes a note to itself
(`about: "me"`, recalled as "(about you)"), recalls, forgets with a reason, and recalls nothing.
Another test keeps a memory in your Personal space and recalls from a Work space: nothing, until it
asks with `in`. `tests/screens.test.ts` prints `/memories` through the real terminal host and
renders a space's Memories. And `tests/parity.test.ts` runs the same tool calls on Copilotz's memory
(on Copilotz's identity and spaces) and on yours, and compares the answers, the memories kept and
the next conversation's prompt.

## Also in this chapter

- `plugins/memory/resources/tools.ts`: the three tools, as chat's `tools` resource.
- `plugins/memory/views/web/style.ts`, `resources/commands.ts`: the page's layout and `/memories`.
- `tests/store.test.ts`: its message said "Remember me", which the offline model now takes as asking
  for the `remember` tool; it says "See you tomorrow" instead.

`git diff lesson-6.2 lesson-6.3` shows every change.

## What you have now

Agents that keep what matters, find it later by meaning, correct it and drop it, and a place to see
what they kept. Next, memories arrive even when nobody asks.
