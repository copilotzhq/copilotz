---
title: "Chapter 39: Swapping in Copilotz's plugins"
description: "Every plugin you rebuilt kept Copilotz's contract, so one setting runs Compass on Copilotz's own plugins instead, the real Compass's. A test runs the same end-to-end scenario on both lists, and shows where they differ on purpose."
section: Getting Started
order: 390
status: stable
---

# Chapter 39: Swapping in Copilotz's plugins

> Part 13, from one person to many · Requires: Chapter 38 · Code: `lesson-13.1`

## The pain

Compass works, for you, on your machine. The day a second person needs it, a colleague who should
see the launch board, everything you wrote assumes there's one of you: identity says every request
from this machine is you, spaces have no invitations, nobody signs in. Starting over for many people
would throw away twelve parts of work.

## The problem

You don't have to start over, because of a rule you kept since part 2: every plugin you rebuilt has
the **same contract** as Copilotz's own. Same plugin name, same collections and fields, same Action
names and inputs, same tools. Copilotz's plugins are built for many people (the real Compass runs
them), and yours are the same shape at single-user scope.

So the claim to test is strong: take your list of plugins, put Copilotz's in place of yours, and
nothing else in the app should notice. Not North's tools, not the board's Actions, not the
terminal's front ends. And where the two lists differ, the difference should be on purpose: what
several people need, and nothing else.

## The solution

### A second list

`app.ts` takes one more setting, `copilotz`:

```ts
export type Settings = {
  // …
  /** Copilotz's own plugins in place of the ones you rebuilt. */
  copilotz?: boolean;
};
```

and `plugins` hands over to a second list when it's set:

```ts
/** Every plugin Compass runs, in order: yours, or with `copilotz`, Copilotz's in their place. */
export function plugins(settings: Settings): Plugin[] {
  if (settings.copilotz) return copilotzPlugins(settings);
  return [
    models,
    chat,
    history,
    identity,
    spaces,
    // …
  ];
}

/** The same list, on Copilotz's plugins: what the real Compass runs. */
function copilotzPlugins(settings: Settings): Plugin[] {
  return [
    models,
    chat,
    agents.history,
    ...access,
    work.boards,
    work.documents,
    agents.memory,
    ...(settings.openai ? [agents.memoryExtraction] : []),
    coordination,
    agents.skills,
    agents.routines,
    computers,
    // The computer's web_search goes here too, before Copilotz's webTools adds its own.
    definePlugin({ name: "web-search-from-webtools", resources: { tools: { web_search: null } } }),
    agents.webTools,
    mcp,
    compass,
    settingsPlugin(settings),
  ];
}
```

The imports are Copilotz's package entry points:

```ts
import * as agents from "copilotz/plugins/agents";
import * as work from "copilotz/plugins/work";
import { access } from "copilotz/plugins/access";
```

`access` is three plugins, `[spaces, identity, contacts]` (`plugins/access/mod.ts:46`): Copilotz's
identity and spaces in place of yours, and contacts, people outside an org who talk to its agents (a
WhatsApp customer), which you never needed.

Three stay as they were. `models`, `chat` and `computers` were Copilotz's all along. `coordination`
is Compass's own plugin in the real app too. And the MCP server stays yours: Copilotz's `mcp` speaks
for a _contact_, in a chat of its own, and won't start without the app's `links` resource ("mcp
needs the links resource (its origin and secret): its ids are made with it",
`plugins/interfaces/mcp/mod.ts:146`); yours speaks for you, on your machine. The settings plugin is
the same for both: the model aliases, the history's summarizer, the memory's embedder.

### The terminal

`terminal.ts` reads `COMPASS_COPILOTZ=1`:

```ts
const runtime = await createRuntime({
  // …
  plugins: [
    ...plugins({
      you: me,
      openai: process.env.OPENAI_API_KEY,
      tail,
      copilotz: process.env.COMPASS_COPILOTZ === "1",
    }),
    metrics(meter),
    // …
    spacesTerminal,
    boardsTerminal,
    documentsTerminal,
    // …
  ],
});
await runtime.call("person.set", me);
```

The front ends are yours, unchanged, on either list. They call Actions and read collections by name,
and the names are the contract. `person.set` and `space.personal` are Copilotz's too: Copilotz's
identity keeps a person with `person.set` (`plugins/access/identity/actions/person.ts`), and its
spaces make your Personal space, `personal:<you>`, the id yours make.

### The same scenario, twice

The test kit takes the setting too (`tests/kit.ts`: `compass({ copilotz: true })`), and
`tests/copilotz.test.ts` runs one scenario on each list. Ana asks; North, on a scripted model, makes
a board, a card and a document; then the test collects what Ana reads, what each tool told North,
and what's stored:

```ts
const MOVES = [
  { tool: "create_board", input: { name: "Course launch" } },
  { tool: "create_card", input: { title: "Record the trailer", column: "To do", assignee: "Ana" } },
  {
    tool: "write_document",
    input: { title: "Trailer script", text: "# Trailer\n\nThirty seconds, one take." },
  },
  "The trailer is on the board, and its script is in Documents.",
];
// …
test("the same scenario on your plugins and on Copilotz's", async () => {
  const yours = await scenario(false);
  assert.deepEqual(await scenario(true), yours);
  // …
});
```

Ids and times differ by run; `stable` (from `tests/parity.ts`) names them before comparing. Every
other value must be equal: the tools' words
(`Created “Record the trailer” [<card>] in To do, for
Ana — on “Course launch” (/board/<board>).`),
the card's column and assignee, the document's text and version, and the record that North made the
card acting for Ana.

### Where they differ, on purpose

The second test lists both runtimes' Actions (`runtime.describe().actions`):

```ts
const yours = await actionsOf(false);
const theirs = await actionsOf(true);
assert.deepEqual(yours.filter((name) => !theirs.includes(name)), []);
const more = theirs.filter((name) => !yours.includes(name));
for (
  const name of [
    "session.start", // identity: a sign-in proves someone, with a session
    "invitation.send", // spaces: people join a shared space by an invitation
    "invitation.accept",
    "member.set", // and its managers change their roles
    "org.join", // an org's people, each with a role there
    "contact.start", // contacts: people outside the org, on WhatsApp
  ]
) assert.ok(more.includes(name), `${name} is Copilotz's`);
```

Yours have no Action Copilotz's don't. Copilotz's have about thirty more, and every one is about
other people: sessions, invitations, members' roles, an org's people and seats, contacts. That's
exactly what "single-user scope" left out, and it's the next two chapters.

## Run it

On Copilotz's plugins, with your terminal:

```sh
printf 'Hi North\n/space Launch\n/doc new Plan: Record the trailer first.\n/doc\n/spaces\n' \
  | COMPASS_COPILOTZ=1 COMPASS_ME=ana COMPASS_DATA=.data/r131.sqlite OPENAI_API_KEY= \
    node --disable-warning=ExperimentalWarning terminal.ts
```

```text
Compass
Ana → north › Hi North
north › You said: Ana: Hi North
ana › /space Launch
You work in Launch now.
ana › /doc new Plan: Record the trailer first.
Plan · version 1 · saved by Ana

Record the trailer first.

History:
  v1 · Ana · create · +1 −0
ana › /doc
[1] Plan · version 1 · Ana
    Record the trailer first.
ana › /spaces
[1] Launch · shared · 2a1f5984-848b-4d71-a807-03f8c7e0432e ●
[2] Personal · personal · personal:ana
/work <n> works in one; new conversations go there.
```

The same commands, the same answers: what's under them, the space, the document and its versions, is
kept by Copilotz's plugins now.

## Check it

`tests/copilotz.test.ts`: the same end-to-end scenario on both lists must answer the same, ids and
times aside; and the Actions only Copilotz's list has are the ones several people need, while yours
have none of their own. The rest of the suite still runs on your plugins, the default.

## Also in this chapter

- `.env.example`: `COMPASS_COPILOTZ`.
- `app.ts` and `terminal.ts`: their doc comments, rewritten to say what each runs now.

`git diff lesson-12.3 lesson-13.1` shows every change.

## What you have now

One app, two lists of plugins, the same behavior. Your plugins were never a toy version: they are
Copilotz's contracts at single-user scope, and Copilotz's own fit where they were. `npm run dev` and
`npm run terminal` still run yours, by default.
