---
title: "Build Compass: a workspace for people and agents"
description: "The deep track: build Compass, a workspace where people and agents share chats, a board and documents, and learn the runtime's contract by building each part of it, one primitive at a time."
section: Build Compass
order: 1
status: stable
---

# Build Compass: a workspace for people and agents

Compass is a workspace where people and a team of AI agents share chats, a board and documents. In
this track you build it yourself, for one person on their own machine, in 41 chapters.

It's the deep dive into the contract the runtime keeps for every caller, whichever way they come in:

- **Who is asking, for whom, and where.** Every call carries an actor, such as you or an agent
  working for you, and its work happens in a space.
- **What can be done.** Each thing anyone can do is an Action. A click, an agent's tool and a script
  call the same one.
- **What anyone sees.** A View shows the data in one place: the browser, the terminal or the model's
  prompt. Observed Views stay live.
- **The rules, checked at the data.** They filter every read and write, whichever way the call came
  in.
- **The record.** Every write and every Action call is an event that names who acted.

You import 2 of Copilotz's plugins as they are: `models`, which talks to model providers, and
`chat`, which runs conversations, agents and their tools. You rebuild the rest of Compass's plugins
yourself: identity, spaces, the board, documents, memory and more. Each keeps the contract of
Copilotz's plugin of the same name (its collections, Actions, events, Views, resources and tools),
so Copilotz's web and terminal front ends work with yours in its place. You leave out only what
exists because several people share an app: invitations, roles, orgs and billing. The last part runs
Compass on Copilotz's own plugins, which have them.

By the end you know how the runtime and its plugins work, because you built them. You drag a card in
the browser. North reads the same board in its prompt, a script moves a card over the REST API, and
an assistant reaches the board over MCP. All of them go through the same Actions, under the same
rules, on the same record.

## How Copilotz works, in one minute

An app is a list of **plugins**. A plugin is a plain object made of 6 primitives, and the runtime
knows nothing else:

| Primitive      | What it is                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Collection** | documents with a JSON Schema, read and written with the MongoDB collection API; every write records an event in the same commit   |
| **Action**     | something that can be done, by name, with a JSON Schema input and an `allow` saying who may call it; every call is on the record  |
| **Processor**  | what happens when events happen: it hears the events it names, runs at least once per event, in order per key                     |
| **View**       | how data presents itself in one place: text for the model (the agent's prompt is a View), Ink for the terminal, React for the web |
| **Resource**   | configuration as named plain objects, by kind (`agents`, `tools`, `provider`…); a later plugin patches an earlier one's           |
| **Adapter**    | one implementation of a port, by name: a model provider's protocol, an embedder                                                   |

Plugins reach each other only through the runtime, by name. They call each other's Actions, plug
into each other's resource kinds, and hear each other's events. One owner writes everything to one
store (in memory, SQLite or PostgreSQL), so every change is on the record, and every screen follows
it live.

Each part of the contract has chapters of its own:

- **Who and where:** a who, a route and a rule for one person (Chapter 3), spaces (Chapters 7 and
  8), and sign-in for many people (Chapter 40).
- **Actions:** the board's 7 Actions, the only way to change it (Chapter 9), and the tools that call
  them for North (Chapter 11).
- **Views:** a charter in North's prompt (Chapter 2), the board on the web and in the terminal
  (Chapter 10), and chat's history View replaced (Chapter 17).
- **The record:** the events one message leaves (Chapter 1), the store's tables (Chapter 5), and
  every save a version that says who, what and when (Chapter 12).
- **Every way in:** the REST API, the client and MCP (Chapters 33 to 35).

Three things people often get wrong, and the track shows each one running:

- **Two kinds of events.** A collection write records `<collection>.created`, `.updated` or
  `.deleted`. An Action call records `action.started`, then `action.completed` or `action.failed`. A
  plugin can also declare events of its own (chat's `turn.requested`) and emit them. Callers call
  Actions; events are what Actions and writes produce.
- **Watching events and watching Views are different.** `runtime.subscribe` hears every event as
  it's committed; Processors react to the ones they name. `runtime.observe` renders a View, and
  renders it again when what it read changes: that's how screens stay live.
- **Queries read; Actions write.** A collection's named queries never write. Anything that changes
  data, however many documents it touches, is an Action.

## What you need

- Node 24 or newer (the guide uses Node; Copilotz also runs on Deno, Bun and Cloudflare Workers).
- An OpenAI API key is optional. Without one, agents answer with Copilotz's offline fake model, and
  every test in the guide runs without a key.
- The track and its course are built on Copilotz `1.0.0-rc.29`, and install that version. To move
  your Compass to a later release, follow the upgrade notes for rc.30 to rc.32 in the
  [CHANGELOG](../CHANGELOG.md): files upload on their own, `allow` is asked of tools too, and an
  agent's work reaches only the space it works in.

```sh
mkdir compass && cd compass
npm init -y && npm pkg set type=module
npm install copilotz@1.0.0-rc.29 react@19 react-dom@19
npm install -D typescript @types/node @types/react @types/react-dom esbuild
```

Node runs TypeScript files as they are, so there's no build step for the server or the terminal. The
editor and `tsc` need to know imports end in `.ts`; this `tsconfig.json` is the guide's:

```json
{
  "compilerOptions": {
    "target": "ES2024",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2024", "DOM", "DOM.Iterable", "DOM.AsyncIterable"],
    "types": ["node"],
    "jsx": "react-jsx",
    "jsxImportSource": "react",
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": false,
    "verbatimModuleSyntax": true,
    "erasableSyntaxOnly": true,
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

And the scripts the chapters run, in `package.json` (each arrives with the chapter that needs it):

```json
"scripts": {
  "hello": "node --env-file-if-exists=.env hello.ts",
  "terminal": "node --disable-warning=ExperimentalWarning --env-file-if-exists=.env terminal.ts",
  "dev": "node --disable-warning=ExperimentalWarning --env-file-if-exists=.env server.ts",
  "test": "node --disable-warning=ExperimentalWarning --test --test-timeout=60000 --test-concurrency=1 \"plugins/*/tests/*.test.ts\" \"tests/*.test.ts\"",
  "check": "tsc --noEmit -p ."
}
```

A `.env` beside them may hold `OPENAI_API_KEY=sk-…`; the scripts read it if it's there.

The code at the end of each chapter comes with the [Copilotz course](https://copilotz.com/learn):
one git repository with a tag per lesson (`lesson-1.1`, `lesson-1.2`…), and each chapter is also one
of its video lessons. Chapters show the files that matter; each ends with what else changed, and
`git diff lesson-a lesson-b` shows all of it.

## The chapters

**Part 1: an agent of your own**

1. [One agent, one message](build-compass/part-1-an-agent-of-your-own/01-one-agent-one-message.md):
   compose a runtime from two of Copilotz's plugins and one of your own, send an agent a message,
   and read the events it leaves.
2. [North, in your terminal](build-compass/part-1-an-agent-of-your-own/02-north-in-your-terminal.md):
   move North into a plugin of your own, laid out by primitive; give the team a charter as a View in
   North's prompt; talk to North in Copilotz's terminal and see exactly what it's sent.
3. [Compass in the browser](build-compass/part-1-an-agent-of-your-own/03-compass-in-the-browser.md):
   rebuild Copilotz's identity plugin for one person on their own machine (a collection, an Action,
   a who, a route and a rule), then serve Compass's web page in its own look.

**Part 2: your own plugins**

4. [Today, every turn](build-compass/part-2-your-own-plugins/04-today-every-turn.md): tell every
   agent today's date with a turn context, and see why a prompt has a stable part and a part that
   changes: the provider's prompt cache.
5. [One store](build-compass/part-2-your-own-plugins/05-one-store.md): keep Compass in one SQLite
   file: what the store's tables hold, each collection as a SQL view, and why the store has one
   writer at a time.
6. [Chats that name themselves](build-compass/part-2-your-own-plugins/06-chats-that-name-themselves.md):
   write a Processor: it hears chat's message.created events and names new chats with a small model.
   Then test it with a scripted model, swapped in through resources and an adapter.
7. [Spaces](build-compass/part-2-your-own-plugins/07-spaces.md): rebuild Copilotz's spaces plugin
   for one person by its contract: what chat and other plugins ask of it, a rule that keeps shared
   documents in real spaces, and a parity test against Copilotz's own.
8. [Spaces on the web](build-compass/part-2-your-own-plugins/08-spaces-on-the-web.md): give spaces a
   web front end: React Views the web shell places by name, a page for each space, and resource
   kinds that let other plugins add tabs without knowing your code.

**Part 3: the board**

9. [The board's data and Actions](build-compass/part-3-the-board/09-the-boards-data-and-actions.md):
   rebuild Copilotz's boards: two collections that must always agree, seven Actions that are the
   only way to change them, and transactions that commit what several documents must agree on
   together.
10. [The board on screen](build-compass/part-3-the-board/10-the-board-on-screen.md): show the same
    board in two places with Views: a Board tab on every space's page, plugged in through a resource
    kind, and a terminal View printed by a command. Both stay live.
11. [The board for North](build-compass/part-3-the-board/11-the-board-for-north.md): the third place
    the board shows is the model's prompt: six tools, offered wherever a conversation is in a space,
    that call the same Actions people use, and read back as plain text.

**Part 4: documents**

12. [Documents and their versions](build-compass/part-4-documents/12-documents-and-their-versions.md):
    rebuild Copilotz's documents plugin for one person by its contract: Markdown in a space, every
    save a version that says who, what and when, an old version brought back as a new one, and a
    stale save refused.
13. [Saves that merge, or refuse](build-compass/part-4-documents/13-saves-that-merge-or-refuse.md):
    two saves from the same version merge line by line, a three-way merge against the version both
    started from, and are refused only where they touch the same lines; and who has a document open
    is live, in a collection kept in memory.
14. [Documents on the web and in the terminal](build-compass/part-4-documents/14-documents-on-the-web-and-in-the-terminal.md):
    the same documents shown by Views in two places: a Documents tab on every space, a page to write
    and save each version, live as others save, and /doc in the terminal.
15. [Documents for North](build-compass/part-4-documents/15-documents-for-north.md): documents'
    third reader is the model: five tools, offered wherever a conversation is in a space, that read
    and write through the same commit as your saves, each change a version by the agent, for you.

**Part 5: long conversations**

16. [A line for every message](build-compass/part-5-long-conversations/16-a-line-for-every-message.md):
    rebuild Copilotz's history plugin, starting with its Processor: as messages leave the recent
    tail, each gets a line, and pairs of lines merge up a binary tree, with a cheap model only for
    what's long.
17. [The outline in North's prompt](build-compass/part-5-long-conversations/17-the-outline-in-norths-prompt.md):
    replace chat's history View: an agent is sent the summary lines first, then the recent messages
    whole, and chat reads only those, from where the history plugin says they start.
18. [Zoom](build-compass/part-5-long-conversations/18-zoom.md): a summary line never replaces its
    messages: the zoom tool, offered once a thread is summarized, opens a line into the two it was
    made from, down to the message itself, whole.

**Part 6: memory**

19. [Memories found by meaning](build-compass/part-6-memory/19-memories-found-by-meaning.md):
    rebuild the store half of Copilotz's memory plugin: statements about a person, an agent, a
    conversation or everyone, kept with an embedding, found by meaning and by words, and updated
    instead of repeated.
20. [Recall in the prompt](build-compass/part-6-memory/20-recall-in-the-prompt.md): memory reaches
    agents as three of chat's contexts: how to use it in the cached system part, the core memories
    when a conversation begins, and each turn the memories relevant to what was last said.
21. [Remember, recall, forget](build-compass/part-6-memory/21-remember-recall-forget.md): three
    tools with Copilotz's names and inputs let agents keep, search and drop memories; the charter
    says what's worth keeping, and the terminal and the web show what's kept.
22. [Memories on their own](build-compass/part-6-memory/22-memories-on-their-own.md): rebuild
    Copilotz's memoryExtraction: a Processor counts each conversation's shared messages and, every
    few, asks a cheap model to write down what's worth keeping, through the same keep as remember.

**Part 7: the team**

23. [East, South and West](build-compass/part-7-the-team/23-east-south-and-west.md): North gets a
    team: three more of the app's own agents, each with its own way of working and its own model
    alias, in every space, with the charter in each one's prompt.
24. [Asking in parallel](build-compass/part-7-the-team/24-asking-in-parallel.md): North brings
    teammates in with chat's send_message: questions that don't depend on each other go out in one
    step, the teammates work at the same time, and North resumes once, with every reply.
25. [Reading other conversations](build-compass/part-7-the-team/25-reading-other-conversations.md):
    Compass's coordination plugin, rebuilt for one person: two tools that let an agent list and read
    the other conversations of its space, through chat's own queries, storing nothing.

**Part 8: skills and routines**

26. [Skills](build-compass/part-8-skills-and-routines/26-skills.md): rebuild Copilotz's skills
    plugin for one person: know-how an agent reads only when a task calls for it, listed by name in
    the cached part of its prompt and read with one tool.
27. [Routines on a schedule](build-compass/part-8-skills-and-routines/27-routines-on-a-schedule.md):
    rebuild Copilotz's routines for one person: a message sent to an agent on a schedule, with time
    as one more caller of Actions, every run recorded, and tests that move time with a manual clock.
28. [Agents that schedule](build-compass/part-8-skills-and-routines/28-agents-that-schedule.md):
    "Remind me every Monday" from a chat: four tools that make, list and cancel routines as the
    person the agent works for, post back where they were asked, and let an agent name a run's chat
    for what it found.

**Part 9: the web for agents**

29. [Search, an adapter port](build-compass/part-9-the-web-for-agents/29-search-an-adapter-port.md):
    rebuild Copilotz's web tools for one person, starting with web_search: a tool that knows no
    search engine and asks an adapter port, so DuckDuckGo, Serper or an offline fake answers, all
    through the runtime's fetch.
30. [Reading a page safely](build-compass/part-9-the-web-for-agents/30-reading-a-page-safely.md):
    read_page fetches a page an agent chose and hands back its main text, marked as data: http(s)
    only, private and metadata addresses refused on every redirect, within a time, a size and a kind
    of content, and a few pages per turn.

**Part 10: testing**

31. [Fakes at the edges](build-compass/part-10-testing/31-fakes-at-the-edges.md): test Compass as a
    person uses it, offline and in milliseconds: the app as app.ts makes it, run for real, with
    fakes only where it meets the world: a scripted model, a manual clock, and a model provider
    served on your machine.
32. [Parity](build-compass/part-10-testing/32-parity.md): what every rebuilt plugin's parity test
    does, in one small helper: the same scenario on Copilotz's plugin and on yours, with ids and
    times taken out; and the parity test identity was missing, with testWho saying who each request
    is.

**Part 11: other ways in**

33. [The REST API](build-compass/part-11-other-ways-in/33-the-rest-api.md): other programs reach
    Compass: the runtime answers /api/ itself, as whoever identity's who says a request is, so a
    script on your machine reads your board and moves a card through the same Actions and rules as a
    click.
34. [The client](build-compass/part-11-other-ways-in/34-the-client.md): Copilotz's client, connect,
    reaches the running server as plugin code reaches the store, over the socket or over HTTP; its
    watch hears every commit, so a script prints your board again whenever a card moves.
35. [Your board over MCP](build-compass/part-11-other-ways-in/35-your-board-over-mcp.md): an
    assistant on your machine (Claude Code, any MCP client) calls the board's tools, the same ones
    North uses: Compass's own mcp plugin, with Copilotz's contract, for one person, each call
    written in a chat of yours.

**Part 12: shipping**

36. [PostgreSQL and blobs](build-compass/part-12-shipping/36-postgresql-and-blobs.md): run the same
    Compass on PostgreSQL when DATABASE_URL says so, and keep large values once, as files in a
    folder of their own, with Copilotz's postgresStore and fileBlobs.
37. [Watching it run](build-compass/part-12-shipping/37-watching-it-run.md): Copilotz measures
    itself: the runtime's jobs and commits, and every model call by OpenTelemetry's GenAI
    conventions. Give it a meter, read the numbers at /metrics as Prometheus text or in the
    terminal, and send them to an OpenTelemetry collector.
38. [A computer for your agents](build-compass/part-12-shipping/38-a-computer-for-your-agents.md):
    run Copilotz's computers plugin, unchanged, on Compass's spaces: a machine you connect with a
    one-time code, where North gets a terminal, jobs, files, a browser and web search, and asks
    before it runs anything. One change to spaces makes it fit: you are a member of your spaces, the
    way Copilotz's keep it.

**Part 13: from one person to many**

39. [Swapping in Copilotz's plugins](build-compass/part-13-from-one-person-to-many/39-swapping-in-copilotzs-plugins.md):
    every plugin you rebuilt kept Copilotz's contract, so one setting runs Compass on Copilotz's own
    plugins instead, the real Compass's. A test runs the same end-to-end scenario on both lists, and
    shows where they differ on purpose.
40. [Sign-in and people](build-compass/part-13-from-one-person-to-many/40-sign-in-and-people.md): on
    Copilotz's identity, a request is whoever its session proves, so people sign in: by email and a
    password, with codes written to the log on this machine, or by name. Then a space gets members:
    Ana invites Bruno to Launch, he accepts, and he reads its board.
41. [Many orgs and billing](build-compass/part-13-from-one-person-to-many/41-many-orgs-and-billing.md):
    one address, many orgs: a directory runtime signs people in and knows their orgs, and each org
    is a Compass of its own, opened when used and closed when idle. With Copilotz's usage ledger,
    what each org's agents use is recorded and priced in that org alone.
