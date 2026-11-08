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

The code at the end of each chapter is a tag of the course repository,
[copilotzhq/compass-course](https://github.com/copilotzhq/compass-course) (`lesson-1.1`,
`lesson-1.2`…), and each chapter is also a video lesson of the Copilotz course.

## The chapters

**Part 1: an agent of your own**

1. [One agent, one message](getting-started/part-1-an-agent-of-your-own/01-one-agent-one-message.md):
   a runtime, two of Copilotz's plugins and one of yours; the events a message leaves.
2. [North, in your terminal](getting-started/part-1-an-agent-of-your-own/02-north-in-your-terminal.md):
   a plugin of your own, laid out by primitive; the prompt is a View.
3. [Compass in the browser](getting-started/part-1-an-agent-of-your-own/03-compass-in-the-browser.md):
   identity, rebuilt for one person; the web page and Compass's look.

**Part 2: your own plugins**

4. [Today, every turn](getting-started/part-2-your-own-plugins/04-today-every-turn.md): the prompt's
   two parts, and the cache.
5. [One store](getting-started/part-2-your-own-plugins/05-one-store.md): SQLite, the store's tables,
   one writer.
6. [Chats that name themselves](getting-started/part-2-your-own-plugins/06-chats-that-name-themselves.md):
   a Processor, and a scripted model in its test.
7. [Spaces](getting-started/part-2-your-own-plugins/07-spaces.md): rebuilding a plugin other plugins
   depend on, by its contract.
8. [Spaces on the web](getting-started/part-2-your-own-plugins/08-spaces-on-the-web.md): web Views,
   and resource kinds as places to plug in.

**Part 3: the board**

9. [The board's data and Actions](getting-started/part-3-the-board/09-the-boards-data-and-actions.md):
   what must agree commits together; writes only through Actions.
10. [The board on screen](getting-started/part-3-the-board/10-the-board-on-screen.md): the same
    board as a web View and a terminal View, both live.
11. [The board for North](getting-started/part-3-the-board/11-the-board-for-north.md): the third
    place, the model's prompt: tools, and the Actions behind them.
