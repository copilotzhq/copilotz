---
title: "Chapter 14: Documents on the web and in the terminal"
description: "The same documents shown by Views in two places: a Documents tab on every space, a page to write and save each version, live as others save, and /doc in the terminal."
section: Build Compass
order: 140
status: stable
---

# Chapter 14: Documents on the web and in the terminal

> Part 4, documents · Requires: Chapter 13 · Code: `lesson-4.3`

## The pain

Documents have versions and merges now, but only a script can reach them. There's nowhere to write
the launch plan, and nowhere to see that North just changed it.

## The problem

Documents need a face where you work: in the browser, a place in each space to find them and a page
to write in; in the terminal, a way to list and read them. And the page must be honest about time.
While you type, North may save. The page should show that, take the new text when you have nothing
unsaved, and when you do, say that your save will merge, not pretend nothing happened.

## The solution

Views, as with boards in Chapter 10: the same reads, observed, drawn as React on the web and as text
in the terminal. A View's reads return at once with a `status`, and an observed View runs again when
what it read changes, so a save anywhere shows everywhere.

### On the web

`documentsWeb` (`web.tsx`) adds four Views and two resources other front ends read:

```ts
export const documentsWeb: Plugin = definePlugin({
  name: "documents-web",
  requires: ["web-shell"],
  views: {
    documents: documentsView,
    document: documentView,
    "document.history": historyView,
    "document.palette": documentsPaletteView,
  },
  resources: {
    spaceTabs: { documents: { title: "Documents", view: "documents", icon: "file", order: 30 } },
    palette: { documents: { view: "document.palette", order: 32 } },
  },
});
```

- **The Documents tab.** Spaces' `spaceTabs` resource kind (Chapter 8) puts a tab on every space's
  page, drawn by the `documents` View: the space's documents from the `list` query, latest saved
  first, each with how it opens, its version, and who saved it last; and a field to make a new one,
  which opens it.
- **A document's page.** The web shell shows the address `/<kind>/<id>` with that kind's View, so
  `/document/<id>` is the `document` View.
- **History**, `document.history`, under the page: every version, who and how, `+added −removed`,
  and Restore on the older ones.
- **The palette.** The web shell's `palette` resource: the Documents tab and "New document…" in the
  space you're in, and, as you search, the latest saved documents (`recent`).

The page (`views/web/page.tsx`) reads the document and who has it open, both observed:

```ts
export const documentView = (item: { _id?: string }, ctx: ViewContext<ReactNode>): ReactNode => {
  const doc = ctx.db.collection<Document>("document").findOne({ _id: item._id ?? "" }).value;
  if (doc === undefined) return <Skeleton height={300} />;
  if (!doc) return <EmptyState title="No document here">It may have been deleted.</EmptyState>;
  const here = ctx.db.collection<Presence>("documentPresence").find({ document: doc._id }).value ??
    [];
  const name = namesIn(ctx, doc.in, [doc.savedBy]);
  return (
    <Page title={doc.title} width="lg" back={{ href: documentsTab(doc.in), label: "Documents" }}>
      <style href="compass-documents" precedence="copilotz">{STYLE}</style>
      <Title text={doc.title} />
      <Editor key={doc._id} doc={doc} here={here} savedBy={name(doc.savedBy)} call={ctx.call} />
      <h2>History</h2>
      {ctx.show("document.history", { _id: doc._id }, { version: doc.version })}
    </Page>
  );
};
```

The editor keeps the version it started from, and what you've made of it since:

```ts
// The version this page started from, and what you've made of it since.
const [start, setStart] = useState({ version: doc.version, title: doc.title, text: doc.text });
const [title, setTitle] = useState(doc.title);
const [text, setText] = useState(doc.text);
// …
const dirty = title !== start.title || text !== start.text;
const behind = doc.version > start.version;
// …
// Someone saved: with nothing unsaved here, take it.
useEffect(() => {
  if (behind && !dirty) take(doc);
}, [doc.version]);
```

When someone saves, the observed read brings the new version. With nothing unsaved, the page takes
it. With something, it says who saved, and that saving will merge the two. Saving (Save, or ⌘S)
sends `base: start.version`, exactly the input `document.save` takes:

```ts
const save = async (base = start.version) => {
  // …
  try {
    const saved = await call<{ version: number; text?: string; title?: string }>("document.save", {
      document: doc._id,
      base,
      text,
      title: title.trim(),
    });
    take({ version: saved.version, title: saved.title ?? title.trim(), text: saved.text ?? text });
  } catch (e) {
    if ((e as { code?: string }).code === "conflict") setClash(message(e));
    else setError(message(e));
  } finally {
    setBusy(false);
  }
};
```

A merged save comes back with the merged text, and the page shows it. A clash shows the Action's own
words and two ways out: Keep mine (save again from the version that's there now, so yours goes over
it) or Take theirs. And while it's open, the page says so with `document.presence`, `open` or
`editing`, every `BEAT_MS`, and `gone` when it closes; another tab with the same document shows
"This is open in another tab too."

The names on the page come from `namesIn` (`shared/who.ts`), the View side of Chapter 12's `nameOf`:
your name from identity's `person`, an agent's from chat's `agents` query on `thread`, the same way
the board shows owners.

Copilotz's documents page does more, and you leave it out: templates, a draft kept in the browser as
you type, a Split view beside Write and Preview, a conflict screen that settles each clash on its
own, the compact `document.read` View beside a chat, and a version's own page with its changes
(`document.version`).

### In the terminal

`documentsTerminal` (`terminal.ts`) adds two text Views, `terminal.documents` and
`terminal.document`, and one command, `/doc` (`resources/terminal-commands.ts`):

```ts
"/doc": command({
  description: "Documents in this space: list them, read one, or make one",
  usage: "[n|title|id] | new <title>[: text]",
  async run(args, term) {
    const { space, listed = [] } = await term.state();
    if (!space) return await term.print("Choose a space first.");
    const asked = args.trim();
    const made = /^new\s+([^:]*)(?::\s*([\s\S]*))?$/.exec(asked);
    if (made) {
      const { document } = await term.runtime.call<{ document: string }>("document.create", {
        in: space, title: made[1].trim(), ...(made[2] ? { text: made[2].trim() } : {}),
      });
      return await term.show("terminal.document", { document });
    }
    const docs = await term.runtime.query<Listed[]>("document.list", { in: space });
    if (!asked) {
      await term.set({ listed: docs.map((doc) => doc._id) });
      return await term.show("terminal.documents", { space });
    }
    // … by number, id or title
    await term.show("terminal.document", { document: found._id });
  },
}),
```

`/doc` lists the space's documents, numbered, and remembers the list (`term.set({ listed })`, as
`/spaces` does), so `/doc 1` reads the first. The command calls the same Action and query the web
does, as you. One document, as text (`views/terminal/document.ts`):

```ts
return [
  `${bold(doc.value.title)} ${
    dim(`· version ${doc.value.version} · saved by ${name(doc.value.savedBy)}`)
  }`,
  "",
  doc.value.text.trim() ? doc.value.text.trimEnd() : dim("(It's empty.)"),
  "",
  dim("History:"),
  ...versions.map((v) =>
    dim(
      `  v${v.version} · ${name(v.by)} · ${v.kind}${
        v.merged ? " (merged)" : ""
      } · +${v.added} −${v.removed}`,
    )
  ),
].join("\n");
```

`terminal.ts` adds `documentsTerminal`, and `front.ts` adds `documentsWeb`.

## Run it

In the terminal, with piped input:

```sh
printf '/doc new Launch plan: Record the trailer, then review the course page.\n/doc\n/doc 1\n' | COMPASS_ME=ana COMPASS_DATA=.data/l43.sqlite OPENAI_API_KEY= node --disable-warning=ExperimentalWarning terminal.ts
```

```text
Compass
ana › /doc new Launch plan: Record the trailer, then review the course page.
Launch plan · version 1 · saved by Ana

Record the trailer, then review the course page.

History:
  v1 · Ana · create · +1 −0
ana › /doc
[1] Launch plan · version 1 · Ana
    Record the trailer, then review the course page.
ana › /doc 1
Launch plan · version 1 · saved by Ana

Record the trailer, then review the course page.

History:
  v1 · Ana · create · +1 −0
```

In the browser (`COMPASS_ME=ana COMPASS_DATA=.data/l43.sqlite npm run dev`, the same store, with the
terminal closed: one writer at a time), open your Personal space's Documents tab: the same Launch
plan. Open it, add a line, and save: History shows version 2. Open the same document in a second
tab, change different lines in each, and save both: the second save merges. Change the same line in
both: the second is refused, with Keep mine and Take theirs.

## Check it

`tests/web.test.ts` observes a document's page, saves through the Action, and checks the new version
shows in History with Restore, without reloading; and observes the Documents tab as a document is
made, checks its link, excerpt and "saved by Ana", and that the palette finds it as you search.
`tests/terminal.test.ts` runs `/doc new`, `/doc` and `/doc 2` through the real terminal host with a
fake standard output, and checks the list and a document with its History.

## Also in this chapter

- `views/web/documents-tab.tsx`, `history.tsx`, `palette.tsx` and `style.ts`: the tab, History, the
  palette's groups, and the layout (controls and colours come from the toolkit and the theme).
- `views/terminal/documents.ts`: the numbered list.
- `shared/who.ts`: `namesIn`, for Views.
- `tests/tsx.ts`: the test hook that turns the front ends' TSX into JavaScript, as boards' does.
- `front.ts` and `terminal.ts`: the two front ends, beside boards'.

`git diff lesson-4.2 lesson-4.3` shows every change.

## What you have now

Documents you can find, write and restore where you work, in the browser and the terminal, live as
others save. Next, the other writer: North, with tools to list, read, write, append to and edit
them.
