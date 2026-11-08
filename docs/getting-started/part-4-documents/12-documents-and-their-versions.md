---
title: "Chapter 12: Documents and their versions"
description: "Rebuild Copilotz's documents plugin for one person by its contract: Markdown in a space, every save a version that says who, what and when, an old version brought back as a new one, and a stale save refused."
section: Getting Started
order: 120
status: stable
---

# Chapter 12: Documents and their versions

> Part 4, documents · Requires: Chapter 11 · Code: `lesson-4.1`

## The pain

The board says what's being done. But the thing being made, the launch plan, the script, the
decision and why, lives in a chat, scrolled away, or in a file on your desktop that North can't see.
And when North rewrites a paragraph you liked, there's no way back.

## The problem

Work needs a place for what's being made: text that you and your agents both write, in a space, next
to the board. Writing it together brings two needs. Every change must be on the record, so you can
see who changed what, when, and bring an older text back. And two writers must not lose each other's
work: if North saved while you were editing, your save must not silently write over it.

Copilotz has this as its `documents` plugin, and its contract is your specification again: the
`document` and `documentVersion` collections, their queries, and the Actions `document.create`,
`document.save`, `document.rename`, `document.restore` and `document.delete`. What exists there only
because several people share an app (viewers who may only read, editors, names from profiles) stays
out.

## The solution

```text
plugins/documents/
  mod.ts  contract.ts
  collections/document.ts  collections/document-version.ts
  actions/create.ts  save.ts  rename.ts  restore.ts  delete.ts
  shared/write.ts  diff.ts  text.ts  who.ts
  tests/start.ts  tests/documents.test.ts
```

### Two collections

A `document` is Markdown in a space, as it is now: its title, its text, the version it's at, its
size, and who made it and saved it last. Each save is also a `documentVersion`, the document as it
was then (`collections/document-version.ts`):

```ts
export const documentVersion = defineCollection({
  schema: {
    type: "object",
    properties: {
      document: { type: "string" },
      in: { type: "string" },
      version: { type: "integer", minimum: 1 },
      title: { type: "string" },
      text: { type: "string" },
      by: { type: "string" },
      for: { type: "string" },
      at: { type: "string" },
      kind: { enum: ["create", "save", "rename", "restore", "write", "append", "edit"] },
      merged: { type: "boolean" },
      base: { type: "integer" },
      from: { type: "integer" },
      added: { type: "integer" },
      removed: { type: "integer" },
      renamed: { type: "string" },
    },
    required: [
      "document",
      "in",
      "version",
      "title",
      "text",
      "by",
      "at",
      "kind",
      "added",
      "removed",
    ],
  },
  indexes: [["document", "version"], ["in"]],
  queries: {
    history: {
      allow: (actor) => actor.kind === "person",
      // … newest first, without their text
    },
  },
});
```

Its `_id` is `<document>:<version>`, so a version is had once. `kind` says how it was made: by you
(`create`, `save`, `rename`, `restore`) or, from Chapter 15, by an agent's tool (`write`, `append`,
`edit`). `by` and `for` say who: `person:ana`, or `agent:north` working for `person:ana`. The
`document` collection has two queries for front ends, `list` (a space's documents, latest saved
first, each with an `excerpt` instead of its text) and `recent`; `documentVersion` has `history`.

### One way to change a document

Every change goes through one function, `commit` (`shared/write.ts`), in the transaction that read
the document:

```ts
export async function commit(
  tx: TransactionScope,
  doc: Document,
  change: Change,
  author: Author,
): Promise<Written> {
  const { title, text } = change;
  if (title === doc.title && text === doc.text) {
    return {
      document: doc._id,
      title,
      version: doc.version,
      added: 0,
      removed: 0,
      unchanged: true,
    };
  }
  checked(title, text);
  const version = doc.version + 1;
  const at = new Date().toISOString();
  const { added, removed } = changes(doc.text, text);
  const saved = await tx.db.collection("document").updateOne(
    { _id: doc._id, version: doc.version },
    {
      $set: {
        title,
        text,
        version,
        size: sizeOf(text),
        savedBy: author.by,
        savedAt: at,
        // …
      },
    },
  );
  if (!saved.matchedCount) throw fail(ARCHIVED, "forbidden");
  await tx.db.collection("documentVersion").insertOne({
    _id: versionId(doc._id, version),
    document: doc._id,
    in: doc.in,
    version,
    title,
    text,
    by: author.by,
    // … for, at, kind, merged, from, renamed
    added,
    removed,
  });
  return { document: doc._id, title, version, added, removed };
}
```

The document and its new version commit together, or not at all. The same title and text writes
nothing. And the update matches only a document still at the version that was read: in an archived
space, spaces' rule (Chapter 7) turns the write down, and `plainly` says so in words: "This
document's space is archived: restore the space to change it."

How many lines a save `added` and `removed` comes from `shared/diff.ts`: the two texts compared line
by line, after their common start and end are set aside, by a table of how many lines each pair of
positions keeps in common (the longest common subsequence). Copilotz's documents use Myers'
algorithm, which is faster on long texts; the table is simpler to read, and past four million line
pairs it counts the middle as replaced whole. On texts of ordinary size both find the fewest lines
added and removed, so the counts agree.

### Saving says where you started

`document.save` takes the version you started from, `base` (`actions/save.ts`):

```ts
run: async (ctx, input) => {
  const title = input.title === undefined ? undefined : input.title.trim() || UNTITLED;
  return await ctx.transaction(async (tx) => {
    const doc = await load(tx.db, input.document);
    if (input.base > doc.version) {
      throw fail(`There's no version ${input.base} yet: it's at ${doc.version}.`, "invalid");
    }
    if (input.base < doc.version) {
      const who = await nameOf({ db: tx.db, resources: ctx.resources }, doc.savedBy);
      throw fail(
        `${who} saved version ${doc.version} since you started from version ${input.base}. ` +
          "Nothing was saved: keep yours over theirs, or take theirs.",
        "conflict",
        { version: doc.version, by: doc.savedBy, at: doc.savedAt },
      );
    }
    return await commit(tx, doc, { title: title ?? doc.title, text: input.text, kind: "save" }, {
      by: keyOf(ctx.actor!),
    });
  }).catch((error) => {
    throw plainly(error);
  });
},
```

If someone saved since, the save is refused with `conflict`, naming who (`shared/who.ts`: an agent
by the name the `agents` resource gives it, you by your name in identity's `person`), and nothing is
written. That's safe, but blunt: in the next chapter, saves that touch different lines merge.

`document.restore` brings an old version back as the next one, its title and text over what's there
now, and the versions between stay. `document.rename` is a version too. `document.delete` takes the
document and every version of it, in one commit.

### The plugin

```ts
export const documents: Plugin = definePlugin({
  name: "documents",
  requires: ["chat", "spaces"],
  collections: { document, documentVersion },
  actions: {
    "document.create": createAction,
    "document.save": saveAction,
    "document.rename": renameAction,
    "document.delete": deleteAction,
    "document.restore": restoreAction,
  },
  resources: { shared: { document: {}, documentVersion: {} } },
  guard: (_actor, { collection, access, direct }) => {
    if (OWN.includes(collection) && direct && access === "write") {
      throw failure("forbidden", "Documents change through their Actions.", { public: true });
    }
    return undefined;
  },
});
```

Both collections live in spaces (spaces' `shared` resource kind), so the rule of Chapter 7 keeps
every write in a space that exists and isn't archived. And, as with boards, the guard refuses any
write from outside (`direct`: the REST API, a browser's socket): a document written directly would
be a save with no version.

## Run it

From a small script on the app's runtime, as you:

```ts
const actor = { kind: "person", id: "ana" } as const;
const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor });
const { document } = await runtime.call<{ document: string }>("document.create", {
  in: space,
  title: "Launch plan",
  text: "Record the trailer.\nReview the page.",
}, { actor });
await runtime.call("document.save", {
  document,
  base: 1,
  text: "Record the trailer.\nReview the page.\nShip it on Monday.",
}, { actor });
// From version 1 again, as a second window would:
await runtime.call("document.save", {
  document,
  base: 1,
  text: "Record the trailer.\nReview the page.\nShip it on Friday.",
}, { actor });
await runtime.call("document.restore", { document, version: 1 }, { actor });
await runtime.query("documentVersion.history", { document }, { actor });
```

```text
{ document: '<id>', title: 'Launch plan', version: 1, added: 2, removed: 0 }
{ document: '<id>', title: 'Launch plan', version: 2, added: 1, removed: 0 }
conflict: Ana saved version 2 since you started from version 1. Nothing was saved: keep yours over theirs, or take theirs.
{ document: '<id>', title: 'Launch plan', version: 3, added: 0, removed: 1 }
v3 restore from v1 by person:ana: +0 −1
v2 save by person:ana: +1 −0
v1 create by person:ana: +2 −0
```

The second save from version 1 is refused, and History shows three versions: made, saved, and
version 1 restored as version 3.

## Check it

`tests/documents.test.ts`: each save is the next version, with who, how and how many lines; the same
text saves nothing; a rename is a version that remembers the old title; `history` lists versions
newest first without their text, and `list` gives each document's excerpt instead of its text; an
old version comes back as a new one; a save from an old version is refused with `conflict`, saying
"Ana saved version 2 since you started from version 1", and nothing is written; an archived space's
documents are read, not changed; deleting takes every version; and every direct write over the REST
API is a 403 while reads still work.

## Also in this chapter

- `app.ts`: `documents` after `boards`, after `spaces`, which it requires.
- `plugins/spaces/tests/work.test.ts`: the test that runs Copilotz's own boards and documents on
  your spaces takes your `documents` out of the list too, since two plugins can't share a name.
- The rest of documents: `contract.ts` (the shapes of a document and a version, its addresses and
  limits), `collections/document.ts`, `actions/create.ts`, `rename.ts`, `restore.ts`, `delete.ts`,
  `shared/text.ts` (sizes, keys, addresses, and how a document opens as plain text), and
  `tests/start.ts`, the tests' own runtime.

`git diff lesson-3.3 lesson-4.1` shows every change.

## What you have now

Documents whose history can't be skipped, because the Actions are the only door and every one of
them writes a version. Next, two saves from the same version stop simply clashing: they merge, line
by line, or are refused only where they really touch the same lines.
