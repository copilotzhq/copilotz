---
title: "Chapter 25: Reading other conversations"
description: "Compass's coordination plugin, rebuilt for one person: two tools that let an agent list and read the other conversations of its space, through chat's own queries, storing nothing."
section: Build Compass
order: 250
status: stable
---

# Chapter 25: Reading other conversations

> Part 7, the team · Requires: Chapter 24 · Code: `lesson-7.3`

> Since 1.0.0-rc.36 these two tools are chat's own (`list_conversations`, `read_conversation`), and
> take a space (`in`): from a person's Personal space, their agents read every space they reach.
> Compass uses chat's. This chapter builds them as a plugin of your own, which is how they began.

## The pain

Yesterday, in another chat in the Launch space, you and North settled the price: 12 a month. Today,
in a new chat, you ask South to check the pricing page, and South asks you what the price is. Every
conversation starts from nothing, even when the answer is one chat away, in the same space.

## The problem

The team should read what was said elsewhere in the space before asking you. But not everywhere:
only the conversation's own space (your Personal space's chats don't leak into Launch), and only
what was said, not the agents' private steps (their tool calls). A model also needs it short: which
conversations there are, how each began and where it is now, and then one of them, a page at a time.

## The solution

### Compass's plugin, at your scope

This one isn't Copilotz's: it's Compass's own `coordination` plugin, two tools in chat's `tools`
resource kind, and nothing to store. Chat's own queries do the reading.

```text
plugins/coordination/
  mod.ts
  resources/tools.ts  list-conversations.ts  read-conversation.ts
  shared/space.ts  shared/lines.ts
  tests/start.ts  coordination.test.ts  parity.test.ts
```

```ts
export const coordination: Plugin = definePlugin({
  name: "coordination",
  requires: ["chat", "spaces"],
  resources: { tools },
});
```

Both tools are offered only where the conversation is in a space (`shared/space.ts`), the same
`offer` the board's tools use:

```ts
/** Offered only in a conversation that's in a space. */
export const inSpace = (_agent: string, thread: Thread) => !!thread.in;
```

### Listing

`list_conversations` asks chat's `thread.recent` query for the space's latest conversations, each
with how many messages it has and what its first and latest say, and leaves out the one the agent is
in:

```ts
run: async ({ limit }, ctx) => {
  const space = await spaceOf(ctx);
  if (!space) return NOWHERE;
  const most = limit ?? 20;
  const recent = await ctx.db.collection("thread").query<Recent[]>("recent", {
    in: space,
    limit: most + 1,
  });
  const others = recent.filter((t) => t._id !== ctx.thread).slice(0, most);
  if (!others.length) return "No other conversations in this space yet.";
  return others.map((t) =>
    [
      `- ${t._id}${t.title ? ` “${gist(t.title, 80)}”` : ""} · ${t.messages ?? 0} messages · ` +
      `last ${when(t.at)}`,
      `  opened: ${gist(t.first) || "(nothing to read)"}`,
      ...(t.last && t.latest !== t.opened ? [`  latest: ${gist(t.last)}`] : []),
    ].join("\n")
  ).join("\n");
},
```

### Reading

`read_conversation` checks the conversation is in the same space, then reads its messages, newest
first, one more than asked (to know whether there's more), and never the private ones:

```ts
const thread = await ctx.db.collection<Thread>("thread").findOne({ _id: conversation });
if (!thread || thread.in !== space) {
  return `No conversation "${conversation}" in this space that you can read.`;
}
const most = limit ?? 30;
// The latest first, one more than asked to know if there's more; agents' steps never.
const found = await ctx.db.collection<Message>("message").find(
  {
    thread: conversation,
    private: { $ne: true },
    ...(before ? { at: { $lt: before } } : {}),
  },
  { sort: { at: -1 }, limit: most + 1 },
);
const shown = found.slice(0, most).reverse();
// …
const names = await namesFor(ctx, namedIn(shown));
return `Conversation ${conversation}${title}:\n${
  shown.map((m) => line(m, names)).join("\n")
}${more}`;
```

Each message is one line, `[2026-11-08 10:42] Ana → north: …`. You show by your name, not your id:
`namesFor` (`shared/lines.ts`) asks where the `names` resource says people's names are (your spaces
point it at identity's `person` collection) through that collection's `names` query, the same way
Copilotz's plugins do. An agent isn't found there, and shows by its own name.

What's left out of Compass's: other people. Compass runs this plugin on Copilotz's access plugins,
where a message is read only if the person the agent works for may read it, and people show by their
profiles. Here everything is yours.

### Telling the team

The charter gets one more paragraph:

```text
**Other conversations here** (`list_conversations`, `read_conversation`): read them instead of
asking people to repeat themselves.
```

and `app.ts` runs the plugin after the others, before Compass's own:

```ts
return [
  models,
  chat,
  history,
  identity,
  spaces,
  boards,
  documents,
  memory,
  // Memories on their own, only where there's a model to write them.
  ...(settings.openai ? [memoryExtraction] : []),
  coordination,
  compass,
  settingsPlugin(settings),
];
```

## Run it

Offline, the fake model calls a tool when your message names it (`list conversations`):

```text
Compass
Ana → north › Pricing: we settled on 12 a month.
north › You said: Ana: Pricing: we settled on 12 a month.
ana › /new
New conversation.
Ana → north › What did we settle on pricing? list conversations
  ⚙ north: list_conversations → - 00d4ab2e-040e-4729-a65c-4f1147f338be …
north › The tool says: - 00d4ab2e-040e-4729-a65c-4f1147f338be · 2 messages · last 2026-11-08 10:42
  opened: Pricing: we settled on 12 a month.
  latest: You said: Ana: Pricing: we settled on 12 a month.
ana › /prompt
── tools · north
list_boards, read_board, create_board, create_card, update_card, move_card, list_documents,
read_document, write_document, append_document, edit_document, remember, recall, forget,
list_conversations, read_conversation, send_message
```

With a key, North reads the conversation it found with `read_conversation`, and answers "12 a month"
without asking you.

## Check it

`plugins/coordination/tests/coordination.test.ts`, on a scripted model: an agent lists the other
conversations of its space (not its own, not another space's), reads one with names in place of ids,
never sees an agent's tool call there, and is refused a conversation in another space. And
`parity.test.ts` beside it: Copilotz has no coordination plugin to compare with, so the same
scenario runs on Copilotz's access plugins (identity and spaces, where Compass runs its own) and on
yours, and every tool answer must be the same, ids and times aside.

## Also in this chapter

- `plugins/coordination/resources/tools.ts`: the two tools, by the names agents call them.
- `plugins/coordination/shared/space.ts`: the conversation's space, and the refusal outside one.
- `plugins/coordination/tests/start.ts`: the tests' runtime, on Compass's identity and spaces or on
  Copilotz's, with a scripted agent ("list" lists, "read <id>" reads).

`git diff lesson-7.2 lesson-7.3` shows every change.

## What you have now

A team of four that asks each other, at once when it can, and reads the rest of the space before
asking you. Next, the team gets skills to follow and routines that run on a schedule.
