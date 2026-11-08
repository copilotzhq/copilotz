---
title: "Chapter 15: Documents for North"
description: "Documents' third reader is the model: five tools, offered wherever a conversation is in a space, that read and write through the same commit as your saves, each change a version by the agent, for you."
section: Getting Started
order: 150
status: stable
---

# Chapter 15: Documents for North

> Part 4, documents · Requires: Chapter 14 · Code: `lesson-4.4`

## The pain

You and North agree on the launch plan in a chat, and then you paste it into the document by hand.
Next week you ask North to update it, and North writes a fresh copy in the chat instead, because it
can't see the document at all.

## The problem

North should work on the document itself: read it before changing it, change only its part, and
leave what you wrote alone. Like the board's tools in Chapter 11, that must not be a looser way in:
North's changes must reach only the conversation's space, be versions like yours, saying it was
North, for you, and come back as short text a model can act on.

There's one more thing a model needs: a way to change part of a long document without sending it all
back. Rewriting a whole document to fix a line is slow, and it's how other people's work gets lost.

## The solution

### Five tools

Chat's `tools` resource kind, with Copilotz's names and inputs (`resources/tools.ts`):

```ts
export const tools: Record<string, Tool> = {
  list_documents: listDocuments,
  read_document: readDocument,
  write_document: writeDocument,
  append_document: appendDocument,
  edit_document: editDocument,
};
```

- `list_documents`: the space's documents, latest saved first, each a link, with its id, version,
  size, who saved it last and when, and how it opens.
- `read_document`: one, by title or id, its Markdown with its version; with `version`, an older one.
- `write_document`: a new one (title and text), or, naming one, its whole text replaced.
- `append_document`: text added at the end, after a blank line.
- `edit_document`: text that occurs exactly once replaced, so a model changes a line without
  rewriting the rest.

Each says `offer: inSpace`, as the board's do: offered, without being listed in an agent's `tools`,
wherever the conversation is in a space.

### One transaction, no conflicts

The board's tools call its Actions. Documents' tools, like Copilotz's own, write through the same
`commit` your Actions use, in a transaction of their own (`shared/tool-context.ts`):

```ts
/** Changes a named document in one transaction (read, then written): `how` says how, or why not. */
export async function change(
  ctx: Ctx,
  name: string,
  how: (doc: Document) => { title?: string; text: string } | string,
  kind: Kind,
): Promise<string> {
  const space = await spaceOf(ctx);
  if (!space) return NOWHERE;
  try {
    return await ctx.transaction(async (tx) => {
      const doc = await named(tx.db, space, name);
      if (typeof doc === "string") return doc;
      const next = how(doc);
      if (typeof next === "string") return next;
      const title = next.title ?? doc.title;
      return answer(await commit(tx, doc, { title, text: next.text, kind }, author(ctx)));
    });
  } catch (error) {
    return said(error);
  }
}
```

Two reasons. A tool reads the document and writes its change in one transaction, so nothing can come
between: an agent never starts from an old version, and never needs a `base` or a merge. And the
version it writes says what the agent did (`kind`: `write`, `append` or `edit`) and who:
`author(ctx)` is `agent:north`, `for` the person it works for, from the actor chat runs the tool as.
`named` finds the document in this space only, by its id or its title (exactly, else the one title
that has it). Copilotz's looks up an id anywhere the rules let the agent read; with one person,
every space is readable, so here the conversation's space is the limit, as it is for the board's
tools. Anything that goes wrong comes back as words for the model, not a failed turn.

`edit_document` is the smallest change, and the one the charter asks for:

```ts
run: ({ document, old, new: next }, ctx) =>
  change(ctx, document, (doc) => {
    const at = doc.text.indexOf(old);
    if (at < 0) {
      return `The text to replace isn't in ${link(doc)}: read it again (read_document) and ` +
        "copy it exactly.";
    }
    if (doc.text.indexOf(old, at + 1) >= 0) {
      const times = doc.text.split(old).length - 1;
      return `The text to replace occurs ${times > 1 ? `${times} times` : "more than once"} ` +
        `in ${link(doc)}: give more of what's around it.`;
    }
    return { text: doc.text.slice(0, at) + next + doc.text.slice(at + old.length) };
  }, "edit"),
```

Answers are short and link the document, `[Launch plan](/document/<id>)`, so the model links it too:
"Saved [Launch plan](/document/…) as version 3: +1 −1 lines."

And your page takes it like any save (Chapter 14): with nothing unsaved, you see North's version at
once; with something, your next save merges with it, line by line (Chapter 13).

### In the chat

On the web, chat's `toolViews` resource names a View for each tool, so a call looks one way to the
model and another to you (`web.tsx`):

```ts
toolViews: {
  list_documents: "document.step",
  read_document: "document.step",
  write_document: "document.step",
  append_document: "document.step",
  edit_document: "document.step",
},
```

`document.step` (`views/web/step.tsx`) shows the answer's first line, with the document it names as
a link to its page. Copilotz's draws a card with what changed and an Open button; one line is enough
here.

### Telling North

North's instructions get one line (`plugins/compass/resources/agents.ts`):

```text
5. What we're making (a plan, a draft, a decision) goes in a document of the space, not only in
   the chat.
```

And the charter (`plugins/compass/resources/charter.ts`) gets Compass's own paragraph on the
document, from the charter of the real Compass, and the board's sentence now speaks of both:

```text
**The board and the document carry the work, not the chat.** A later turn, yours too, won't find
the work as you left it: read them before you act, and update them as you work, not at the end,
so anyone can pick up from them.

…

**The document** (`list_documents`, `read_document`, `edit_document`, `append_document`,
`write_document`): the deliverable, one per thing being made, and its working memory: the
current draft, argument, decision and open questions. Read it before you edit; keep others' work
(edit or append rather than rewrite it whole); change only your part; leave it coherent. Every
save is a version people can compare. Improve it instead of starting a rival copy in the chat,
and link it when you mention it.
```

"Keep others' work (edit or append rather than rewrite it whole)" is the tools' design said to the
model: `write_document`'s own description says the same.

## Run it

Offline, without a key, North answers with Copilotz's fake model, which calls a tool when your
message names it ("list documents" for `list_documents`) and answers with what the tool said:

```sh
printf '/doc new Launch plan: Record the trailer, then review the course page.\nNorth, list documents\n' | COMPASS_ME=ana COMPASS_DATA=.data/l44.sqlite OPENAI_API_KEY= node --disable-warning=ExperimentalWarning terminal.ts
```

```text
…
Ana → north › North, list documents
  ⚙ north: list_documents → Documents here (1), latest saved first:…
north › The tool says: Documents here (1), latest saved first:
- [Launch plan](/document/e849d67c-cc8d-4b4b-b6ab-bf30994fd59d) · id
e849d67c-cc8d-4b4b-b6ab-bf30994fd59d · version 1 · 48 bytes · saved by Ana
2026-11-08 10:44
  opens: Record the trailer, then review the course page.
```

That's the text the model reads. `/prompt` shows the five tools after the board's, at the top of
North's prompt:

```text
── tools · north
list_boards, read_board, create_board, create_card, update_card, move_card,
list_documents, read_document, write_document, append_document, edit_document
```

With a key, ask North in the browser to add a line to the launch plan: the chat shows the call as a
line linking the document, and the document's History shows the version, by North.

## Check it

`tests/tools.test.ts` runs a scripted model (the `script` adapter of Chapter 6) that calls each tool
in turn: it lists nothing, makes "Launch plan", is told a second one with that title already exists,
appends, edits, fails to edit text that isn't there, reads the document now and as version 1, and
lists it; every version is by `agent:north`, for `person:ana`, and all five tools are offered. Then
your save from version 1 merges with North's changes. Another test checks that a document in another
space, named by its title or by its id, isn't found from this conversation, and isn't changed.

`tests/parity.test.ts` runs the same scenario on Copilotz's documents (on Copilotz's identity and
spaces) and on yours: creates, saves that merge, clashes on lines and on titles, invalid versions,
renames, restores, presence, the `list`, `recent` and `history` queries, seventeen tool calls, and
deletes; it compares every answer, error and document, with ids and clock times set aside.

## Also in this chapter

- `resources/list-documents.ts`, `read-document.ts`, `write-document.ts`, `append-document.ts`: the
  other four tools.
- `mod.ts` and `contract.ts`: the `tools` resource, and the tools' names in the contract.
- The rest of `shared/tool-context.ts`: the conversation's space, a document by title or id, how an
  answer is said.

`git diff lesson-4.3 lesson-4.4` shows every change.

## What you have now

Documents that you and North write together: every change a version that says who, saves that merge
or ask you to choose, and the same documents in the browser, the terminal and the model's prompt.
With the board, North now has the two things the charter says carry the work.
