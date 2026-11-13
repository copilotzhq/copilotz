---
title: "Plugins"
description: "Every plugin Copilotz exports: what it keeps, who may call what, where it shows, what it needs."
section: "Reference"
order: 2
---

<!-- Made by scripts/describe.ts from the plugins themselves: run it again rather than edit this page. -->

# Plugins

Each page here is read from the plugin itself, so it says what the code does. `plugins.json` has the
same, as data.

## In `copilotz`

- [`api`](plugins/api.md): Developer keys: what code calls the app with, as someone, over the
  runtime's REST API (`/api/`) or its socket (see runtime/api.ts and runtime/client.ts):
  `Authorization: Bearer <key>`.
- [`api-web`](plugins/api-web.md): The developer API's web front end, for the browser.
- [`chat`](plugins/chat.md): Chat: threads where people and agents talk.
- [`chat-terminal`](plugins/chat-terminal.md): Chat's terminal front end, for the process that draws
  the terminal.
- [`chat-web`](plugins/chat-web.md): Chat's web front end, for the browser: home (a new chat), how a
  chat looks with what agents are writing right now, a message and its files, where you type, and at
  the top of the sidebar, starting one.
- [`contacts`](plugins/contacts.md): Contacts: people outside the org who talk to its agents, such
  as a WhatsApp customer writing to a business's number.
- [`contacts-web`](plugins/contacts-web.md): Contacts on the web: their names, wherever a page shows
  who wrote (spaces' `names` resource, for the browser): "Ana", not "someone".
- [`dev-sign-in`](plugins/dev-sign-in.md): Dev sign-in: people sign in by the name they type, from
  this machine only, for trying an app out (with the identity plugin).
- [`email`](plugins/email.md): Email: sending it, and signing in with it.
- [`email-sign-in`](plugins/email-sign-in.md): Email: sending it, and signing in with it.
- [`google-sign-in`](plugins/google-sign-in.md): Google sign-in: `google.sign-in` turns a Google ID
  token into a person and a session (with the identity plugin).
- [`history`](plugins/history.md): Summarizes each thread's older messages as they leave its tail,
  and sends agents the outline and the recent messages whole (it replaces chat's `history` View).
- [`identity`](plugins/identity.md): Identity: who people are and what proves it.
- [`maintenance`](plugins/maintenance.md): Maintenance: HTTP endpoints for an app's operators, for
  when they can't reach its database themselves (a client's network that keeps their database user
  out).
- [`mcp`](plugins/mcp.md): MCP: models outside the app (ChatGPT, Claude, any MCP client) call the
  app's tools.
- [`memory`](plugins/memory.md): Memory: what agents know across conversations.
- [`memory-extraction`](plugins/memory-extraction.md): Memories that arrive on their own: the
  extractor model reads every few messages, and what a conversation said before going quiet.
- [`memory-terminal`](plugins/memory-terminal.md): Memory's terminal front end: how a memory looks
  there, and `/memories`.
- [`memory-web`](plugins/memory-web.md): Memory's web front end, for the browser: what agents
  remember (the `memories` View, as the terminal's `/memories` lists it: ★ for core memories, always
  in mind).
- [`models`](plugins/models.md): Models: talking to models, one way for every kind.
- [`openapi`](plugins/openapi.md): OpenAPI: an HTTP API's operations as Actions and as tools for
  agents, made from its OpenAPI 3 spec.
- [`routines`](plugins/routines.md): Routines: a message sent to an agent on a schedule, in a space
  ("every weekday at 9:00, ask @researcher for the news on X").
- [`routines-web`](plugins/routines-web.md): Routines' web front end, for the browser.
- [`skills`](plugins/skills.md): Skills: know-how an agent reads only when it needs it.
- [`skills-web`](plugins/skills-web.md): Skills' web front end, for the browser.
- [`spaces`](plugins/spaces.md): Spaces: who reaches what, for every collection that shares its
  documents.
- [`spaces-terminal`](plugins/spaces-terminal.md): Access's terminal front end: how spaces look
  there, and `/spaces`, `/space`, `/work`, `/invite`, `/invitations`, `/accept`, `/decline`, and
  requests to join.
- [`spaces-web`](plugins/spaces-web.md): Spaces' web front end.
- [`terminal`](plugins/terminal.md): The terminal plugin: a command line's data, built from the same
  primitives as everything else, which every process has.
- [`terminal-shell`](plugins/terminal-shell.md): The terminal's front end, for the process that
  draws: the `shell` View (what's open, the scrollback, where you type), where you type's prompt,
  and the View any kind without its own falls back to.
- [`usage`](plugins/usage.md): Usage: what was used, what it cost, and what to charge for it, as a
  ledger.
- [`usage-terminal`](plugins/usage-terminal.md): Usage's terminal front end: how totals look there,
  and `/usage`.
- [`usage-web`](plugins/usage-web.md): Usage's web front end: where the app serves many orgs, the
  org page's Usage section (the web shell's `orgSettings`).
- [`voice`](plugins/voice.md): Voice: people call the app's phone number and talk to its agents,
  through Twilio's ConversationRelay (Twilio hears them and speaks for the agent; the app gets and
  sends text).
- [`web-lines`](plugins/web-lines.md): Web sites (`resources.web.<name>`, declared in the app's
  settings, with the app's secret, `links`).
- [`web-page`](plugins/web-page.md): The page: the app's code, its files, its manifest and worker,
  and the page itself.
- [`web-shell`](plugins/web-shell.md): The web shell: the web's root View, which the web host
  observes for the address it's at (`hosts/web`).
- [`webTools`](plugins/webTools.md): Web tools: agents that search the web and read a page, without
  a computer.
- [`whatsapp`](plugins/whatsapp.md): WhatsApp: people talk to their agents from WhatsApp, through
  Meta's Cloud API.
- [`whatsapp-web`](plugins/whatsapp-web.md): WhatsApp's web front end, for the browser.

## In packages of their own

- [`boards`](plugins/boards.md): Boards: kanban boards in a space, for people and agents, the team's
  operational source of truth: one real outcome per card, with its owner, what done looks like, an
  honest column, and any blocker. In `@copilotz/work`.
- [`boards-web`](plugins/boards-web.md): Boards' web front end, for the browser. In
  `@copilotz/work`.
- [`credits`](plugins/credits.md): Credits: what an org has to spend, and the check that stops it at
  its limit. In `@copilotz/billing`.
- [`credits-web`](plugins/credits-web.md): Credits' web front end: the org page's Billing section
  (the web shell's `orgSettings`). In `@copilotz/billing`.
- [`directory`](plugins/directory.md): The directory plugin, and what each org's runtime gets of it:
  `directory.member(dir, org)` (see shared/member.ts), with the org as `org.info` says it. In
  `@copilotz/directory`.
- [`directory-member`](plugins/directory-member.md): `member(dir, org)`: the plugin each org's
  runtime gets from the directory (`dir`, its runtime) that serves it, beside the app's own plugins.
  In `@copilotz/directory`.
- [`directory-web`](plugins/directory-web.md): The directory's web front end, for apps that serve
  many orgs behind one address: it fills the web shell's `orgs` slot, and draws the org's pages. In
  `@copilotz/directory`.
- [`documents`](plugins/documents.md): Documents: shared Markdown in a space, for people and agents
  — the canonical artifact of the thing being made, and its working memory. In `@copilotz/work`.
- [`documents-web`](plugins/documents-web.md): Documents' web front end, for the browser. In
  `@copilotz/work`.
- [`stripe`](plugins/stripe.md): Stripe: one way an org pays, for `credits`, which never asks it
  anything. In `@copilotz/billing`.
- [`stripe-webhook`](plugins/stripe-webhook.md): Stripe's webhook, `POST /__stripe/<seller>`, where
  the app's accounts send their events (see routes/webhook.ts). In `@copilotz/billing`.
- [`team`](plugins/team.md): Team: agents people make, beside those the app declares in code. In
  `@copilotz/team`.
- [`team-web`](plugins/team-web.md): Team's web front end, for the browser: making and changing
  agents. In `@copilotz/team`.
- [`tiers`](plugins/tiers.md): Tiers: which models the app's agents think with, chosen by what the
  work needs rather than model by model. In `@copilotz/team`.
- [`tiers-web`](plugins/tiers-web.md): Tiers' web front end, for the browser. In `@copilotz/team`.
