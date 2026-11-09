---
title: "Chapter 19: Memories found by meaning"
description: "Rebuild the store half of Copilotz's memory plugin: statements about a person, an agent, a conversation or everyone, kept with an embedding, found by meaning and by words, and updated instead of repeated."
section: Build Compass
order: 190
status: stable
---

# Chapter 19: Memories found by meaning

> Part 6, memory · Requires: Chapter 18 · Code: `lesson-6.1`

## The pain

You tell North your dog is called Rex. Tomorrow, in a new chat, it has no idea. Every conversation
starts from nothing, and you repeat yourself: who you are, how you like answers, what you decided
last week.

## The problem

What an agent learns has to outlive the conversation, and come back when it matters. Two things make
that hard. Finding: tomorrow you won't ask "what is my dog's name?" in the words you used today, so
looking memories up by their words alone misses most of them. And repeating: an agent that keeps
everything it hears ends up with "Ana prefers short answers" ten times, slightly different each
time. Copilotz's answer is the `memory` plugin; you rebuild its contract, starting with what a
memory is and how one is found.

## The solution

### What a memory is

A memory is one self-contained statement, `about` someone or something: a person (`person:ana`), an
agent (`agent:north`), one conversation (`thread:<id>`), or `everyone`. `core` marks what to always
have in mind. It lives `in` the space it was learned in. The collection (`collections/memory.ts`)
keeps Copilotz's fields, and one more thing: a vector field.

```ts
const memorySchema = {
  type: "object",
  properties: {
    text: { type: "string" },
    /** `person:<id>`, `agent:<name>`, `thread:<id>` or `everyone`. */
    about: { type: "string" },
    /** Always in mind, rather than recalled when relevant. */
    core: { type: "boolean" },
    /** The space it was learned in: what comes up by itself was learned there. */
    in: { type: "string" },
    /** Who wrote it: an agent, or `memory` (the extractor). */
    by: { type: "string" },
    // … source, was, at, updated, forgotten
  },
  required: ["text", "about", "by", "at"],
} as const;

export const memoryCollection = defineCollection({
  schema: memorySchema,
  vectors: ["embedding"],
  // … queries
});
```

`vectors: ["embedding"]` tells the store that each document's `embedding` is a vector it can search
by nearness: `collection.nearest(vector, { filter, limit })` answers the documents closest to a
vector, best first, each with its cosine similarity as `_score`. Every store does it: the in-memory
store in JavaScript, SQLite by filtering in SQL and ranking in JavaScript, Postgres with pgvector
when it's installed.

### Meaning, as a vector

An embedding is a list of numbers that stands for what a text means: texts that mean similar things
get vectors that point the same way. An **embedder** makes them: a model the `models` plugin calls
with `embeddings.embed`. Which one is the app's choice, the `memory` resource's `embedder`
(`app.ts`):

```ts
memory: {
  // What memories mean, as vectors. Offline, `hash/words`: only the words they share.
  embedder: settings.openai
    ? { model: "openai/text-embedding-3-small", dimensions: 512 }
    : "hash/words",
},
```

With a key, OpenAI's small embeddings model. Without one, `hash/words`, the offline embedder the
models plugin ships: each word adds to a few of the vector's dimensions, so texts that share words
are similar, and nothing more. It's honest about what it is, and it's enough for every test in this
part to run without a network.

`shared/settings.ts` turns texts into vectors, and remembers the ones it has seen (a turn renders
its prompt more than once):

```ts
export async function vectors(
  ctx: Pick<Context, "resources"> & { call: ReadContext["call"] },
  texts: string[],
  tags: Record<string, string> = {},
): Promise<number[][] | undefined> {
  const { embedder } = settingsOf(ctx);
  if (!embedder) return undefined;
  // …
  const { vectors } = await ctx.call<Embedding>("embeddings.embed", {
    model: embedder,
    input: missing,
    tags: { ...tags, purpose: "memory" },
  });
  // …
}
```

### Found by meaning, and by words

`search` (`shared/search.ts`) asks the store for the memories nearest the text's vector, then adds a
bonus for the words they share: a name or a number that matches exactly counts, even when the
vectors only roughly agree.

```ts
const candidates: Scored[] = vector
  ? await memories.nearest(vector, { filter, limit: limit * 4 })
  : (await memories.find(filter, { sort: { at: -1 }, limit: 500 })).map((m) => ({
    ...m,
    _score: 0,
  }));
const query = words(text);
return candidates
  .map((m) => ({ ...m, _score: m._score + 0.2 * overlap(query, m.text) }))
  .filter((m) => m._score >= (o.least ?? 0) && (vector || m._score > 0))
  .sort((a, b) => b._score - a._score)
  .slice(0, limit);
```

The `filter` is what a conversation may read (`shared/scope.ts`): memories about the people in it,
its agent, the conversation itself, or everyone, learned in its space, and not forgotten. A memory
about Bob never reaches a conversation without Bob.

```ts
export const readable = (scope: Scope) => ({
  forgotten: { $exists: false },
  ...(scope.in ? { in: scope.in } : {}),
  about: {
    $in: [
      "everyone",
      `agent:${scope.agent}`,
      `thread:${scope.thread}`,
      ...scope.people.map((person) => `person:${person}`),
    ],
  },
});
```

### Updated, not repeated

`keep` writes a memory, unless one already says it: about the same subject, in the same space, and
at least 0.9 alike (`SAME`). Then it updates that one, and keeps what it said before in `was`. What
it returns is a sentence, because an agent will read it:

```ts
if (!existing) {
  const same = {
    about: entry.about,
    forgotten: { $exists: false },
    ...(entry.in ? { in: entry.in } : {}),
  };
  existing = embedding
    ? (await memories.nearest(embedding, { filter: same, limit: 1 })).find((m) =>
      m._score >= SAME
    ) ?? null
    : await memories.findOne({ ...same, text: entry.text });
}
if (existing) {
  if (existing.text === entry.text && (entry.core === undefined || entry.core === existing.core)) {
    return `Already remembered [${existing._id}].`;
  }
  await memories.updateOne({ _id: existing._id }, {
    $set: {
      text: entry.text,
      was: existing.text,
      // … updated, core, embedding
    },
  });
  return `Updated [${existing._id}]; it said: "${existing.text}".`;
}
```

### The queries, and the plugin

The collection's three queries keep Copilotz's names: `list` (everything remembered, newest first,
for you to read: `allow: people`), `core` (the core memories a conversation reads), and `relevant`
(the most relevant to a text, at least `RELEVANT`, 0.3, alike). `relevant` never fails a turn: if
the embedder is down, it logs and finds nothing.

```ts
export const memory: Plugin = definePlugin({
  name: "memory",
  requires: ["chat", "identity"],
  collections: { memory: memoryCollection },
  // A memory lives in a space (`shared`): where it was learned.
  resources: { memory: {}, shared: { memory: {} } },
  guard: (_actor, { collection, access, direct }) => {
    if (direct && access === "write" && collection === "memory") {
      throw failure("forbidden", `"${collection}" changes through the memory plugin.`, {
        public: true,
      });
    }
    return undefined;
  },
  async check(merged) {
    const { embedder } = settingsOf(merged);
    if (embedder) await merged.call("models.check", { model: embedder, port: "embeddings" });
  },
});
```

`shared: { memory: {} }` hands the collection to spaces' rule from Chapter 7: a memory can only be
written into a space that exists and is active. The guard keeps everyone, you included, from writing
memories directly. `check` runs at startup and asks the models plugin whether the embedder can be
used, so a wrong one fails as the app starts, not in the middle of a chat.

## Run it

Nothing writes memories yet: that's the next two chapters. The tests write them with `keep`, through
a test Action, and read them back:

```text
$ node --disable-warning=ExperimentalWarning --test plugins/memory/tests/memory.test.ts
✔ remembering what's already known updates it instead of repeating it (48.01925ms)
✔ recall finds by meaning and words, among what the conversation reads (19.319333ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
```

## Check it

`tests/memory.test.ts` keeps a sentence twice (`Already remembered`), then a close variant of it
(`Updated …; it said: "…"`), and finds one memory with its `was`. Then it keeps four memories, two
about Ana, one about Bob and one about everyone, and asks `memory.relevant` for "What's the name of
Ana's dog?" in a conversation with Ana: her dog comes first, Bob's never, and the core memory stays
out (that's `memory.core`'s). `tests/start.ts` is the runtime the memory tests share: Copilotz's
chat, Compass's identity and spaces, and the `hash/words` embedder.

## Also in this chapter

- `plugins/memory/contract.ts`: the `Memory` type and `MemorySettings`, the shape of the `memory`
  resource (`embedder`, `extractor`, `every`, `agents`).
- `plugins/memory/shared/scope.ts`: `Scope`, the limits (`LIMIT`, `SAME`, `RELEVANT`), `words` and
  `overlap`.
- `app.ts`: `memory` after `documents` in the plugin list, and its `embedder`.

`git diff lesson-5.3 lesson-6.1` shows every change.

## What you have now

Memories, stored with what they mean, found by meaning and by words, never repeated. Agents don't
see them yet: next, they come up in the prompt by themselves.
