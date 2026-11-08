---
title: "Chapter 13: Saves that merge, or refuse"
description: "Two saves from the same version merge line by line, a three-way merge against the version both started from, and are refused only where they touch the same lines; and who has a document open is live, in a collection kept in memory."
section: Getting Started
order: 130
status: stable
---

# Chapter 13: Saves that merge, or refuse

> Part 4, documents · Requires: Chapter 12 · Code: `lesson-4.2`

## The pain

You're fixing a typo at the top of the launch plan while North adds a line at the bottom. North
saves first. Your save is refused, and nothing you wrote is kept: you copy it out, reload, paste it
back. You touched different lines; nothing really clashed.

## The problem

Refusing every save that started from an old version is safe but blunt. Most of the time two writers
touch different parts of a document, and both changes should simply be kept. Only where they change
the same lines is there a real choice, and that choice is a person's, not the app's: it must never
pick one side silently.

And the best clash is the one that doesn't happen: if you can see that the document is open in
another tab, and being edited there, you know before you start.

## The solution

### A three-way merge

Every save already says the version it started from, `base`, and every version is kept, so the
server has three texts: the base, yours, and what's there now (theirs). `shared/merge.ts` compares
each with the base, line by line, as hunks: "the base's lines `start` to `end` became `lines`". Then
it walks the base, keeping each side's changes where the other didn't touch:

```ts
/** `mine` and `theirs`, both changed from `base`, as one text; undefined where they clash. */
export function merge(base: string, mine: string, theirs: string): string | undefined {
  if (mine === theirs || theirs === base) return mine;
  if (mine === base) return theirs;
  const lines = linesOf(base);
  const all = [
    ...hunksOf(lines, linesOf(mine), "mine"),
    ...hunksOf(lines, linesOf(theirs), "theirs"),
  ].sort((a, b) => a.start - b.start || (a.end - a.start) - (b.end - b.start));
  // Changes that overlap go together: each group is a stretch of the base both may have changed.
  const groups: { start: number; end: number; hunks: Hunk[] }[] = [];
  for (const h of all) {
    const last = groups.at(-1);
    const insertion = h.start === h.end;
    const over = last && (
      h.start < last.end ||
      // Both adding lines at the same place: which goes first is a choice.
      (insertion && last.start === last.end && h.start === last.start)
    );
    if (over) {
      last.end = Math.max(last.end, h.end);
      last.hunks.push(h);
    } else groups.push({ start: h.start, end: h.end, hunks: [h] });
  }
  const out: string[] = [];
  let at = 0;
  for (const g of groups) {
    out.push(...lines.slice(at, g.start));
    const of = (side: Hunk["side"]) => g.hunks.filter((h) => h.side === side);
    const ours = applied(lines, g.start, g.end, of("mine"));
    const others = applied(lines, g.start, g.end, of("theirs"));
    if (!of("theirs").length || equal(ours, others)) out.push(...ours);
    else if (!of("mine").length) out.push(...others);
    else return undefined;
    at = g.end;
  }
  return [...out, ...lines.slice(at)].join("\n");
}
```

A stretch only one side changed takes that side's lines; a stretch both changed the same way takes
them once; a stretch both changed differently (the same line, lines added in the same place, or a
line one changed and the other removed) is a clash, and there's no merge. Changes next to each
other, not over each other, merge. It's pure: no database, so it's tested on its own. Copilotz's
merge works the same way and also returns the clashing parts, for its side-by-side conflict screen;
yours says only whether it merged, which is all the Action and your simpler page need.

A title is merged whole, the same way: whichever side changed it wins (`mergeField`).

### The save, merging

`document.save` (`actions/save.ts`) now reads the base version in the same transaction and merges
instead of refusing:

```ts
let text = input.text;
let title = asked ?? doc.title;
const merging = input.base < doc.version;
if (merging) {
  const base = await tx.db.collection<DocumentVersion>("documentVersion").findOne({
    _id: versionId(doc._id, input.base),
  });
  const merged = base ? merge(base.text, input.text, doc.text) : undefined;
  const named = asked === undefined
    ? doc.title
    : base
    ? mergeField(base.title, asked, doc.title)
    : undefined;
  if (merged === undefined || named === undefined) {
    const who = await nameOf({ db: tx.db, resources: ctx.resources }, doc.savedBy);
    throw fail(
      `${who} saved version ${doc.version} since you started from version ` +
        `${input.base}, changing the same ${merged === undefined ? "lines" : "title"}. ` +
        "Nothing was saved: keep yours over theirs, take theirs, or merge them by hand.",
      "conflict",
      { version: doc.version, by: doc.savedBy, at: doc.savedAt },
    );
  }
  text = merged;
  title = named;
}
const written = await commit(tx, doc, {
  title,
  text,
  kind: "save",
  ...(merging ? { merged: true, base: input.base } : {}),
}, { by: keyOf(ctx.actor!) });
return { ...written, ...(merging ? { merged: true, text, title } : {}) };
```

A merged save is a version like any, marked `merged` with the `base` it started from, and the merged
text comes back, so the page that saved shows what was kept. Everything happens in the one
transaction that read the document, so nothing can land between the read and the write.

### Who has it open

Who has a document open is state that matters only while it's true. Copilotz's collections can be
kept out of the store: `durable: false` keeps one in the runtime's memory, its writes record no
events, and it's gone on restart (`collections/document-presence.ts`):

```ts
export const documentPresence = defineCollection({
  durable: false,
  schema: {
    type: "object",
    properties: {
      document: { type: "string" },
      in: { type: "string" },
      /** Who: `person:ana`. */
      who: { type: "string" },
      /** `open`: reading it, or with nothing unsaved; `editing`: with changes not yet saved. */
      state: { enum: ["open", "editing"] },
      /** When the page last said so. */
      at: { type: "string" },
    },
    required: ["document", "in", "who", "state", "at"],
  },
});
```

A page says it's there with `document.presence` (`actions/presence.ts`), every little while
(`BEAT_MS`, 25 seconds), and that it's gone when it closes. It says `record: false`: an unrecorded
Action runs inline, with no events of its own, so saying it often costs the log nothing.

```ts
export const presenceAction = defineAction({
  description: "Says who has a document open, and whether they're editing it",
  record: false,
  // … input: document, page, state (open, editing, gone)
  run: async (ctx, input) => {
    const doc = await ctx.db.collection<Document>("document").findOne({ _id: input.document });
    if (!doc) return { present: false };
    const who = keyOf(ctx.actor!);
    const _id = presenceId(doc._id, who, input.page);
    const presence = ctx.db.collection("documentPresence");
    if (input.state === "gone") await presence.deleteOne({ _id });
    else {
      await presence.replaceOne(
        { _id },
        { document: doc._id, in: doc.in, who, state: input.state, at: new Date().toISOString() },
        { upsert: true },
      );
    }
    await presence.deleteMany({
      document: doc._id,
      at: { $lt: new Date(Date.now() - STALE_MS).toISOString() },
    });
    return { present: input.state !== "gone" };
  },
});
```

One entry per page: your two tabs are two. A tab that closes without saying goodbye stops beating,
and its entry goes once it's older than `STALE_MS` (90 seconds), the next time any page says
anything about that document.

The collection lives in spaces too, with `write: "read"` in the `shared` resource: saying you're
there takes only reading the document. In Copilotz's spaces, `write` names the verb that changing a
shared collection's documents needs; your spaces' rule now reads it too (`shared/rules.ts`):

```ts
// Reading, or a write that only takes reading (saying you have a document open).
if (access === "read" || shared[collection].write === "read") return true;
```

So a document in an archived space can still say who has it open.

## Run it

The same script as in Chapter 12, with one more save from version 1 before the clashing one, which
changes the first line:

```ts
await runtime.call("document.save", {
  document,
  base: 1,
  text: "Film the trailer.\nReview the page.",
}, { actor });
```

```text
{ document: '<id>', title: 'Launch plan', version: 1, added: 2, removed: 0 }
{ document: '<id>', title: 'Launch plan', version: 2, added: 1, removed: 0 }
{ document: '<id>', title: 'Launch plan', version: 3, added: 1, removed: 1, merged: true, text: 'Film the trailer.\nReview the page.\nShip it on Monday.' }
conflict: Ana saved version 3 since you started from version 1, changing the same lines. Nothing was saved: keep yours over theirs, take theirs, or merge them by hand.
{ document: '<id>', title: 'Launch plan', version: 4, added: 1, removed: 2 }
v4 restore from v1 by person:ana: +1 −2
v3 save (merged) by person:ana: +1 −1
v2 save by person:ana: +1 −0
v1 create by person:ana: +2 −0
```

Version 3 kept both changes: "Film" from this save, "Ship it on Monday." from version 2. The next
save from version 1 added a line at the very place version 2 added one: which goes first is a
choice, so it's refused, and nothing is written.

## Check it

`tests/merge.test.ts`. The merge on its own: changes to different lines merge, and lines added in
different places; one side's change alone is taken; the same change on both sides is no clash; both
changing one line, adding at one place, or changing what the other removed is a clash; and a title
merges whole. Then through the Action: a save from version 1 after another window's save is version
3, `merged`, with its `base`, and the merged text comes back; a third save changing the same line is
refused with "changing the same lines", and nothing is written. And presence: two tabs are two
entries, `gone` takes one away, an archived space's document still takes them, and deleting the
document takes them all.

`tests/documents.test.ts` keeps passing unchanged: its stale save changes the same line as the save
before it, so it's still refused.

## Also in this chapter

- `mod.ts` and `contract.ts`: the new collection and Action, `documentPresence` in the guard's list,
  and the `Presence` type, `BEAT_MS`, `STALE_MS` and `presenceId` in the contract.
- `actions/delete.ts`: deleting a document takes who had it open, in the same commit.
- `shared/presence.ts`: how often a page beats, how long an entry lasts, and an entry's `_id`.
- `tests/start.ts`: a `test.here` Action that reads who has a document open, as a page would.

`git diff lesson-4.1 lesson-4.2` shows every change.

## What you have now

Two writers who don't lose each other's work: saves that touch different lines are kept together,
and the app refuses only where a person must choose. Next, documents get a face: a Documents tab on
every space, a page to write in, and `/doc` in the terminal.
