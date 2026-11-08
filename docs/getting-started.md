---
title: "Getting Started: build Compass"
description: "Build Compass, a workspace where you and AI agents work together, on Copilotz 1.0: import the agentic core, then rebuild Copilotz's own plugins for one person, one primitive at a time."
section: Getting Started
order: 1
status: stable
---

# Getting Started: build Compass

Compass is a workspace where people and a team of AI agents work together: conversations, spaces, a
board, documents. It runs on Copilotz, and almost all of it is Copilotz's own plugins. In this guide
you build it yourself, for one person on their own machine:

- **You import the agentic core** as it is: `models` (talking to model providers) and `chat`
  (conversations, agents and their tools).
- **You rebuild the rest of Compass's plugins**: identity, spaces, the board… Each one keeps the
  contract of Copilotz's own plugin of the same name (its collections, Actions, events, Views,
  resources and tools), so Copilotz's chat and web front ends work with yours in its place. What you
  leave out is only what exists because several people share an app: invitations, roles, orgs,
  billing.

By the end you know how Copilotz's plugins are built, because you built them, and you have the
pattern for putting agents inside your own product: your product's features as plugins, on the same
primitives, beside the agents.

## How Copilotz works, in one minute

An app is a list of **plugins**. A plugin is a plain object made of six primitives, and the runtime
knows nothing else:

| Primitive      | What it is                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Collection** | documents with a JSON Schema, read and written with the MongoDB collection API; every write records an event in the same commit   |
| **Action**     | something that can be done, by name, with a JSON Schema input and an `allow` saying who may call it; every call is on the record  |
| **Processor**  | what happens when events happen: it hears the events it names, runs at least once per event, in order per key                     |
| **View**       | how data presents itself in one place: text for the model (the agent's prompt is a View), Ink for the terminal, React for the web |
| **Resource**   | configuration as named plain objects, by kind (`agents`, `tools`, `provider`…); a later plugin patches an earlier one's           |
| **Adapter**    | one implementation of a port, by name: a model provider's protocol, an embedder                                                   |

Plugins reach each other only through the runtime, by name: they call each other's Actions, plug
into each other's resource kinds, and hear each other's events. One owner writes everything to one
store (in memory, SQLite or PostgreSQL), so every change is on the record, and every screen follows
it live.

Three things people often get wrong, and the guide shows each one running:

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

The code at the end of each chapter is a tag of the course repository,
[copilotzhq/compass-course](https://github.com/copilotzhq/compass-course) (`lesson-1.1`,
`lesson-1.2`…), and each chapter is also a video lesson of the Copilotz course. Chapters show the
files that matter; each ends with what else changed, and `git diff lesson-a lesson-b` shows all of
it.

## The chapters

**Part 1: an agent of your own**

1. [One agent, one message](getting-started/part-1-an-agent-of-your-own/01-one-agent-one-message.md):
   compose a runtime from two of Copilotz's plugins and one of your own, send an agent a message,
   and read the events it leaves.
2. [North, in your terminal](getting-started/part-1-an-agent-of-your-own/02-north-in-your-terminal.md):
   move North into a plugin of your own, laid out by primitive; give the team a charter as a View in
   North's prompt; talk to North in Copilotz's terminal and see exactly what it's sent.
3. [Compass in the browser](getting-started/part-1-an-agent-of-your-own/03-compass-in-the-browser.md):
   rebuild Copilotz's identity plugin for one person on their own machine (a collection, an Action,
   a who, a route and a rule), then serve Compass's web page in its own look.

**Part 2: your own plugins**

4. [Today, every turn](getting-started/part-2-your-own-plugins/04-today-every-turn.md): tell every
   agent today's date with a turn context, and see why a prompt has a stable part and a part that
   changes: the provider's prompt cache.
5. [One store](getting-started/part-2-your-own-plugins/05-one-store.md): keep Compass in one SQLite
   file: what the store's tables hold, each collection as a SQL view, and why the store has one
   writer at a time.
6. [Chats that name themselves](getting-started/part-2-your-own-plugins/06-chats-that-name-themselves.md):
   write a Processor: it hears chat's message.created events and names new chats with a small model.
   Then test it with a scripted model, swapped in through resources and an adapter.
7. [Spaces](getting-started/part-2-your-own-plugins/07-spaces.md): rebuild Copilotz's spaces plugin
   for one person by its contract: what chat and other plugins ask of it, a rule that keeps shared
   documents in real spaces, and a parity test against Copilotz's own.
8. [Spaces on the web](getting-started/part-2-your-own-plugins/08-spaces-on-the-web.md): give spaces
   a web front end: React Views the web shell places by name, a page for each space, and resource
   kinds that let other plugins add tabs without knowing your code.

**Part 3: the board**

9. [The board's data and Actions](getting-started/part-3-the-board/09-the-boards-data-and-actions.md):
   rebuild Copilotz's boards: two collections that must always agree, seven Actions that are the
   only way to change them, and transactions that commit what several documents must agree on
   together.
10. [The board on screen](getting-started/part-3-the-board/10-the-board-on-screen.md): show the same
    board in two places with Views: a Board tab on every space's page, plugged in through a resource
    kind, and a terminal View printed by a command. Both stay live.
11. [The board for North](getting-started/part-3-the-board/11-the-board-for-north.md): the third
    place the board shows is the model's prompt: six tools, offered wherever a conversation is in a
    space, that call the same Actions people use, and read back as plain text.

**Part 4: documents**

12. [Documents and their versions](getting-started/part-4-documents/12-documents-and-their-versions.md):
    rebuild Copilotz's documents plugin for one person by its contract: Markdown in a space, every
    save a version that says who, what and when, an old version brought back as a new one, and a
    stale save refused.
13. [Saves that merge, or refuse](getting-started/part-4-documents/13-saves-that-merge-or-refuse.md):
    two saves from the same version merge line by line, a three-way merge against the version both
    started from, and are refused only where they touch the same lines; and who has a document open
    is live, in a collection kept in memory.
14. [Documents on the web and in the terminal](getting-started/part-4-documents/14-documents-on-the-web-and-in-the-terminal.md):
    the same documents shown by Views in two places: a Documents tab on every space, a page to write
    and save each version, live as others save, and /doc in the terminal.
15. [Documents for North](getting-started/part-4-documents/15-documents-for-north.md): documents'
    third reader is the model: five tools, offered wherever a conversation is in a space, that read
    and write through the same commit as your saves, each change a version by the agent, for you.

**Part 5: long conversations**

16. [A line for every message](getting-started/part-5-long-conversations/16-a-line-for-every-message.md):
    rebuild Copilotz's history plugin, starting with its Processor: as messages leave the recent
    tail, each gets a line, and pairs of lines merge up a binary tree, with a cheap model only for
    what's long.
17. [The outline in North's prompt](getting-started/part-5-long-conversations/17-the-outline-in-norths-prompt.md):
    replace chat's history View: an agent is sent the summary lines first, then the recent messages
    whole, and chat reads only those, from where the history plugin says they start.
18. [Zoom](getting-started/part-5-long-conversations/18-zoom.md): a summary line never replaces its
    messages: the zoom tool, offered once a thread is summarized, opens a line into the two it was
    made from, down to the message itself, whole.

**Part 6: memory**

19. [Memories found by meaning](getting-started/part-6-memory/19-memories-found-by-meaning.md):
    rebuild the store half of Copilotz's memory plugin: statements about a person, an agent, a
    conversation or everyone, kept with an embedding, found by meaning and by words, and updated
    instead of repeated.
20. [Recall in the prompt](getting-started/part-6-memory/20-recall-in-the-prompt.md): memory reaches
    agents as three of chat's contexts: how to use it in the cached system part, the core memories
    when a conversation begins, and each turn the memories relevant to what was last said.
21. [Remember, recall, forget](getting-started/part-6-memory/21-remember-recall-forget.md): three
    tools with Copilotz's names and inputs let agents keep, search and drop memories; the charter
    says what's worth keeping, and the terminal and the web show what's kept.
22. [Memories on their own](getting-started/part-6-memory/22-memories-on-their-own.md): rebuild
    Copilotz's memoryExtraction: a Processor counts each conversation's shared messages and, every
    few, asks a cheap model to write down what's worth keeping, through the same keep as remember.

**Part 7: the team**

23. [East, South and West](getting-started/part-7-the-team/23-east-south-and-west.md): north gets a
    team: three more of the app's own agents, each with its own way of working and its own model
    alias, in every space, with the charter in each one's prompt.
24. [Asking in parallel](getting-started/part-7-the-team/24-asking-in-parallel.md): north brings
    teammates in with chat's send_message: questions that don't depend on each other go out in one
    step, the teammates work at the same time, and North resumes once, with every reply.
25. [Reading other conversations](getting-started/part-7-the-team/25-reading-other-conversations.md):
    compass's coordination plugin, rebuilt for one person: two tools that let an agent list and read
    the other conversations of its space, through chat's own queries, storing nothing.

**Part 8: skills and routines**

26. [Skills](getting-started/part-8-skills-and-routines/26-skills.md): rebuild Copilotz's skills
    plugin for one person: know-how an agent reads only when a task calls for it, listed by name in
    the cached part of its prompt and read with one tool.
27. [Routines on a schedule](getting-started/part-8-skills-and-routines/27-routines-on-a-schedule.md):
    rebuild Copilotz's routines for one person: a message sent to an agent on a schedule, with time
    as one more caller of Actions, every run recorded, and tests that move time with a manual clock.
28. [Agents that schedule](getting-started/part-8-skills-and-routines/28-agents-that-schedule.md):
    \"Remind me every Monday\" from a chat: four tools that make, list and cancel routines as the
    person the agent works for, post back where they were asked, and let an agent name a run's chat
    for what it found.

**Part 9: the web for agents**

29. [Search, an adapter port](getting-started/part-9-the-web-for-agents/29-search-an-adapter-port.md):
    rebuild Copilotz's web tools for one person, starting with web_search: a tool that knows no
    search engine and asks an adapter port, so DuckDuckGo, Serper or an offline fake answers, all
    through the runtime's fetch.
30. [Reading a page safely](getting-started/part-9-the-web-for-agents/30-reading-a-page-safely.md):
    read_page fetches a page an agent chose and hands back its main text, marked as data: http(s)
    only, private and metadata addresses refused on every redirect, within a time, a size and a kind
    of content, and a few pages per turn.

**Part 10: testing**

31. [Fakes at the edges](getting-started/part-10-testing/31-fakes-at-the-edges.md): test Compass as
    a person uses it, offline and in milliseconds: the app as app.ts makes it, run for real, with
    fakes only where it meets the world: a scripted model, a manual clock, and a model provider
    served on your machine.
32. [Parity](getting-started/part-10-testing/32-parity.md): what every rebuilt plugin's parity test
    does, in one small helper: the same scenario on Copilotz's plugin and on yours, with ids and
    times taken out; and the parity test identity was missing, with testWho saying who each request
    is.

**Part 11: other ways in**

33. [The REST API](getting-started/part-11-other-ways-in/33-the-rest-api.md): other programs reach
    Compass: the runtime answers /api/ itself, as whoever identity's who says a request is, so a
    script on your machine reads your board and moves a card through the same Actions and rules as a
    click.
34. [The client](getting-started/part-11-other-ways-in/34-the-client.md): copilotz's client,
    connect, reaches the running server as plugin code reaches the store, over the socket or over
    HTTP; its watch hears every commit, so a script prints your board again whenever a card moves.
35. [Your board over MCP](getting-started/part-11-other-ways-in/35-your-board-over-mcp.md): an
    assistant on your machine (Claude Code, any MCP client) calls the board's tools, the same ones
    North uses: Compass's own mcp plugin, with Copilotz's contract, for one person, each call
    written in a chat of yours.

**Part 12: shipping**

36. [PostgreSQL and blobs](getting-started/part-12-shipping/36-postgresql-and-blobs.md): run the
    same Compass on PostgreSQL when DATABASE_URL says so, and keep large values once, as files in a
    folder of their own, with Copilotz's postgresStore and fileBlobs.
37. [Watching it run](getting-started/part-12-shipping/37-watching-it-run.md): copilotz measures
    itself: the runtime's jobs and commits, and every model call by OpenTelemetry's GenAI
    conventions. Give it a meter, read the numbers at /metrics as Prometheus text or in the
    terminal, and send them to an OpenTelemetry collector.
38. [A computer for your agents](getting-started/part-12-shipping/38-a-computer-for-your-agents.md):
    run Copilotz's computers plugin, unchanged, on Compass's spaces: a machine you connect with a
    one-time code, where North gets a terminal, jobs, files, a browser and web search, and asks
    before it runs anything. One change to spaces makes it fit: you are a member of your spaces, the
    way Copilotz's keep it.
