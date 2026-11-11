---
title: "Chapter 20: Recall in the prompt"
description: "Memory reaches agents as three of chat's contexts: how to use it in the cached system part, the core memories when a conversation begins, and each turn the memories relevant to what was last said."
section: Build Compass
order: 200
status: stable
---

# Chapter 20: Recall in the prompt

> Part 6, memory · Requires: Chapter 19 · Code: `lesson-6.2`

## The pain

The memories are there, and North never looks. It answers "I don't know your dog's name" with the
answer one query away. An agent can't use what it doesn't know it has.

## The problem

You could put every memory in the prompt. That stops working at the fortieth memory, and it costs
every turn. And the prompt's first part, the system text, is cached: whatever goes there must stay
the same, or every turn pays for all of it again. So memory needs three places, each with its own
rhythm: what never changes (how to use memory), what a conversation starts with (the core memories
about who's in it), and what each turn brings up (what's relevant to the last thing said).

## The solution

Chat already has the place for each: the `context` resource kind you used in Chapter 4 for the date.
A context is a View of the conversation, `context:<name>`, and its entry says where it goes:
`system` (stable, cached) or `turn` (after the conversation, told when it says something new, and
then kept where it was told). `resources/context.ts`:

```ts
export const contexts = {
  memory: { place: "system" },
  remembered: { place: "turn" },
  recall: { place: "turn" },
};
```

### How to use memory, in the system part

The `memory` context is the same text everywhere (`views/context.ts`):

```ts
export const GUIDE =
  "You remember across conversations. When you learn something that will matter " +
  "later (who someone is, what they prefer, a decision or commitment), remember it in one " +
  "self-contained sentence; mark it core when it's central to them. Before answering about " +
  "anything from earlier conversations, recall it instead of guessing. Correct or forget " +
  "memories that turn out wrong.";

export const guideView = (_thread: Thread, ctx: ViewContext) =>
  applies(ctx, ctx.viewer?.name ?? "") ? GUIDE : undefined;
```

`ctx.viewer` is the agent the prompt is for; `applies` checks the `memory` resource's `agents` (all
agents, unless it names some). A View that returns `undefined` adds nothing.

Copilotz's own memory goes further: its guide is the plugin's own fixed words, so it declares the
context as instructions (`{ place: "system", instructions: true }`), sent as they are rather than as
information, and it also tells agents to look (recall, and back through the conversation) before
saying they don't know or don't have something.

### Core memories, when the conversation begins

Core memories aren't in the system part, though they're stable: the system part is the same in every
conversation with the same people in the same space, so it's cached across them, and core memories
change whenever one is learned. They're a `turn` context that never changes: the core memories as
the conversation began knowing them (`before` its first message's time). Told on its first turn, the
same text every turn after, so it's never told again.

```ts
export const rememberedView = (thread: Thread, ctx: ViewContext) => {
  const scope = scopeOf(thread, ctx);
  if (!scope || !applies(ctx, scope.agent)) return undefined;
  const start = began(thread, ctx);
  if (start === null) return undefined;
  const { latest: _, ...who } = scope;
  const core = ctx.db.collection<Memory>("memory").query<Memory[]>("core", {
    ...who,
    ...(start ? { before: start } : {}),
  });
  if (core.status !== "ready" || !core.value.length) return undefined;
  return [
    "What you remember about the people here, yourself and everyone (memories can be " +
    "out of date: what's said in the conversation wins):",
    ...core.value.map((m) => String(ctx.show("llm.memory", m))),
  ].join("\n");
};
```

Who is here comes from the conversation's latest shared messages: whoever wrote or was written to
and isn't an agent (`shared/people.ts`, with chat's `agentsShown`).

```ts
function scopeOf(thread: Thread, ctx: ViewContext): (Scope & { latest?: Message }) | undefined {
  const agent = ctx.viewer?.name ?? "";
  const recent = ctx.db.collection<Message>("message").find(
    { thread: thread._id, private: { $ne: true } },
    { sort: { at: -1 }, limit: 50 },
  );
  if (recent.status !== "ready") return undefined;
  const agents = agentsShown(ctx, recent.value.flatMap((m) => [m.from, ...m.to]));
  if (!agents) return undefined;
  return {
    agent,
    thread: thread._id,
    people: peopleIn(recent.value, agents),
    // What comes up by itself was learned in this conversation's space.
    ...(thread.in ? { in: thread.in } : {}),
    latest: recent.value.find((m) => m.from !== agent),
  };
}
```

### What's relevant, each turn

The `recall` context takes what was last said to the agent and asks the `relevant` query from
Chapter 19. Only what's at least 0.3 alike comes up, at most five; core ones learned since the
conversation began come up here too, since `remembered` won't say them.

```ts
export const recallView = (thread: Thread, ctx: ViewContext) => {
  const scope = scopeOf(thread, ctx);
  if (!scope?.latest?.text || !applies(ctx, scope.agent)) return undefined;
  const start = began(thread, ctx);
  if (start === null) return undefined;
  const { latest, ...who } = scope;
  const relevant = ctx.db.collection<Memory>("memory").query<Memory[]>("relevant", {
    ...who,
    text: latest.text,
    ...(start ? { since: start } : {}),
  });
  if (relevant.status !== "ready" || !relevant.value.length) return undefined;
  return "Memories that may be relevant to the latest message:\n" +
    relevant.value.map((m) => ctx.show("llm.memory", m)).join("\n");
};
```

Copilotz's own `recall` context searches a little wider: the latest message, the two before it and
the conversation's title, each memory scored by the closest (so "see above" still finds what the
question above was about); in its person's own Personal space, everywhere they can read; and each
memory says when and where it was learned, which `recall`'s `source` opens.

Each memory is said by one View, `llm.memory` (`views/memory.ts`, with `shared/said.ts`): a line,
its subject when it isn't a person, and its id, which the tools of the next chapter take.

```ts
export const line = (m: Memory, agent?: string) =>
  `- ${m.text}${
    m.about.startsWith("person:") ? "" : ` (about ${subject(m.about, agent)})`
  } [${m._id}]`;
```

`mod.ts` registers the four Views and the contexts:

```ts
views: {
  "llm.memory": memoryView,
  "context:memory": guideView,
  "context:remembered": rememberedView,
  "context:recall": recallView,
},
// A memory lives in a space (`shared`): where it was learned.
resources: { memory: {}, context: contexts, shared: { memory: {} } },
```

## Run it

Offline, nothing writes memories yet, so only the guide shows. `/prompt` puts it in the system part,
after the charter and where you are:

```text
$ printf 'My dog is called Rex.\n/prompt\n' | COMPASS_ME=ana COMPASS_DATA=.data/r62.sqlite OPENAI_API_KEY= node --disable-warning=ExperimentalWarning terminal.ts
Compass
Ana → north › My dog is called Rex.
north › You said: Ana: My dog is called Rex.
ana › /prompt
── tools · north
list_boards, read_board, create_board, create_card, update_card, move_card,
list_documents, read_document, write_document, append_document, edit_document
── system (cached across turns)
# North
…
<context name="where">
This conversation is in Ana's Personal space: only Ana sees what's here.
</context>

<context name="memory">
You remember across conversations. When you learn something that will matter
later (who someone is, what they prefer, a decision or commitment), remember it
in one self-contained sentence; mark it core when it's central to them. Before
answering about anything from earlier conversations, recall it instead of
guessing. Correct or forget memories that turn out wrong.
</context>
── history (cached as it grows)
user      Ana: My dog is called Rex.
assistant You said: Ana: My dog is called Rex.
── turn (what's new, then kept in the history)
<context name="today">
It's Sunday, 8 November 2026, 07:47 (America/Sao_Paulo).
</context>
```

## Check it

`tests/prompt.test.ts` keeps a core memory ("Ana is a designer in Recife.") and another ("Ana's dog
is called Rex."), then asks "What's my dog's name?" and reads `thread.prompt`. The guide is in the
system part, and no memory is. In the history, right after the question: the `remembered` context
with the designer, and the `recall` context with the dog, each line with its id. A second test keeps
a core memory after the conversation began: it doesn't join `remembered`, but comes up in `recall`
when the question is about it. A third leaves North out of the `agents` setting, and its prompt has
no memory at all.

## Also in this chapter

- `plugins/memory/shared/people.ts`: the people in a conversation, from its messages.
- `plugins/memory/shared/said.ts`: `subject`, whom a memory is about in words ("you" for the agent
  reading it).
- `plugins/memory/mod.ts`: the Views and the `context` entries.

`git diff lesson-6.1 lesson-6.2` shows every change.

## What you have now

Memories reach the prompt on their own: how to use them, always; the core ones, as a conversation
starts; the relevant ones, each turn. Next, North writes them itself.
