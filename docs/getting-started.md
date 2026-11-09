---
title: "Getting Started: one app, for people and for AI"
description: "Build a salon's booking app on Copilotz 1.0, then open the same app to its own agent, to ChatGPT, Claude and Gemini over MCP, to a chat on its site and to WhatsApp, under the same Actions, rules and record."
section: Getting Started
order: 1
status: stable
---

# Getting Started: one app, for people and for AI

In this guide you build one app: a hair salon's bookings. Its staff book on a web page. Its own
agent books in a chat. ChatGPT, Claude and Gemini book over MCP, a widget draws the bookings inside
the assistant, visitors book from a chat on the salon's site, and customers book on WhatsApp.

You never write the booking twice. Every way in calls the same Actions, under the same rules, and
the record says who did what, for whom. By chapter 6, one test drives the page, the agent and an
assistant at once, and proves it.

## How Copilotz works, in one minute

An app is a **runtime** made of **plugins**. A plugin is plain objects, made of six primitives:

| Primitive      | What it is                                                                       |
| -------------- | -------------------------------------------------------------------------------- |
| **Collection** | documents with a JSON Schema; every write records an event in the same commit    |
| **Action**     | something that can be done, by name, with an input schema and who may call it    |
| **Processor**  | what happens when events happen                                                  |
| **View**       | how data shows in one place: text for a model or the terminal, React for the web |
| **Resource**   | settings as named plain objects; a later plugin patches an earlier one's         |
| **Adapter**    | one implementation of a port: a model provider, an email service                 |

Around them, the runtime keeps one contract for every caller:

- **Who is asking, and where.** Every call carries an actor: a person, a contact from outside, or an
  agent acting for one of them. In an app with spaces, it also says where the work is.
- **The rules, at the data.** Reads come back filtered by what the actor reaches, and writes are
  checked, whichever way the call came in.
- **The record.** Every write is an event with its actor, so "who booked Tuesday, for whom?" always
  has an answer.

Every way in is a thin plugin over that contract: the web, the terminal, MCP, a site's chat,
WhatsApp. The salon's own agent is one more caller of the app, not its center.

## What you need

- Node 24 or newer.
- An OpenAI API key is optional. Without one, agents answer with Copilotz's offline fake model, and
  every test runs without a key: a scripted model plays the agent's part.

The code at the end of each chapter is a tag of the course repository, `copilotzhq/salon-course`
(`chapter-1`, `chapter-2`…), and each chapter is also a video. To start where a chapter ends:

```sh
git clone https://github.com/copilotzhq/salon-course && cd salon-course
git switch -c my-salon chapter-1
npm ci
```

`chapter-0` is the empty start: `package.json` with `copilotz@1.0.0-rc.32`, React and the TypeScript
toolchain, and `tsconfig.json`. Node runs TypeScript files as they are, so there's no build step.
Each chapter says which scripts it adds: `npm run hello`, `dev`, `terminal`, `tour`, and always
`npm test` and `npm run check`. A `.env` beside them may hold your `OPENAI_API_KEY`.

## The chapters

**Part 1: one app**

1. [One booking](getting-started/01-one-booking.md): a salon's bookings as a Copilotz plugin: a
   collection, an Action, a View and a resource. Sam books a slot, and the record says he did.
2. [Who sees what](getting-started/02-who-sees-what.md): staff and customers: people and contacts, a
   space for the desk, and one rule at the data that filters every read and checks every write,
   whoever calls. Then the first tests.

**Part 2: the ways in**

3. [Its own web page](getting-started/03-its-own-web-page.md): the desk on the web: Copilotz's web
   shell with a Bookings tab, drawn by a React View that reads two named queries, as the reader,
   live. Its buttons are the same Actions.
4. [Its own agent](getting-started/04-its-own-agent.md): the concierge: the salon's agent, with four
   tools that call the same Actions, a text View for each that the model reads, acting for whoever
   it talks with.
5. [ChatGPT, Claude and Gemini, over MCP](getting-started/05-chatgpt-claude-and-gemini-over-mcp.md):
   the concierge's tools, opened to assistants outside. Each conversation is a contact with a chat
   of its own, under the same rules.
6. [The same bookings, every way in](getting-started/06-the-same-bookings-every-way-in.md): the
   payoff: one test drives the page, the agent and an assistant at once, reads the record of who
   acted for whom, and proves the rules held at each.
7. [A widget in the assistant](getting-started/07-a-widget-in-the-assistant.md): the desk's Bookings
   View, drawn inside ChatGPT and Claude, with its buttons as the same Actions.
8. [A chat on your site](getting-started/08-a-chat-on-your-site.md): anyone who opens the salon's
   site can chat with the concierge, and book from a panel beside the chat.
9. [WhatsApp](getting-started/09-whatsapp.md): a number open to anyone, with Meta's webhook and API
   played locally in the tests.

**Part 3: online**

10. [Shipping the salon](getting-started/10-shipping-the-salon.md): SQLite, then PostgreSQL with a
    lease for deploys, a secret that keeps conversations themselves, and a public origin with staff
    invited by email.

Coming: **11. Signed in from ChatGPT and Claude**, once MCP has sign-in. The assistant books for the
customer by name, and the record says so.
