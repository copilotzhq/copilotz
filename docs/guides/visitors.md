---
title: "Visitors: a chat on your site"
description: "A public site where anyone chats with the app's agent, signed in or not: site chats, what a visitor reaches, and the limits that keep it safe to open."
section: Guides
order: 3
---

# Visitors: a chat on your site

A site chat lets anyone with a browser talk to the app's agent, signed in or not. Each visitor gets
a chat of their own, and reaches nothing else.

## A site chat

Site chats are the web interface's `webLines` plugin, from `copilotz/plugins/interfaces`. Each site
is declared as `resources.web.<name>`, beside the app's secret, `links`:

```ts
resources: {
  agents: { guide: { instructions: "Answer questions about the timetable.", model: "main" } },
  spaces: { visitors: { name: "Website", agents: ["guide"] } },
  caller: { header: "cf-connecting-ip", front: env.FRONT_SECRET },
  web: { site: { in: "visitors", agent: "guide" } },
  links: { origin: "https://example.com", secret: env.LINKS_SECRET },
}
```

The page is the app's own shell for visitors, such as a chat window. It sends with `chat.send`,
naming no chat at first, and reads its chat's messages by `thread`:

```tsx
await web({ root, plugins: [siteShell, chatWeb], arrive: { name: "site" } });
```

## How a visitor comes in

A page that asks to come in by a site, `web({ arrive: { name } })`, and isn't anyone yet posts to
the site's route, `POST /web/<name>`, before it connects. It becomes a visitor.

Its browser keeps a signed secret in an `HttpOnly`, `SameSite=Strict` cookie, `__Host-visitor`
wherever it's Secure. The site chat's `who` reads it. It stays the same visitor for the site's
`days`, 30 unless the site says.

Coming in makes and keeps nothing. The visitor's first message (`chat.send`, naming no chat) makes
it a contact in the site's space, with a chat of its own, answered by the site's agent.

A visitor works in the site's space. Its actor says so (`in`), from its first request on, so its
calls and the record put it there.

Someone signed in comes in as themselves.

## What a visitor reaches

A visitor reaches what any contact does: their chat, and what's said and filed there, `/files/<id>`
included. They never see the agent's private steps: its tools' calls, what each returned, or a
step's words before they're known to be an answer.

Its page reads only what it names of its own: its chat's messages by `thread`, and its chats by its
memberships, `{ member: "contact:<id>" }`. A read that names none is refused, never watched.

A visitor writes as itself. `chat.send` and `chat.attach` let in people and contacts writing their
own words, never an agent, so the site's agent can't speak for the visitor.

The site's agent answers as an agent working for the visitor, a contact. An Action its tools call
asks its `allow` for the agent and for the visitor. So an Action that lets contacts in, such as one
saying `peopleOrContacts`, lets the agent in, and one that lets in only people refuses it.

## Its limits

Each limit is refused plainly, with a 429, and only for that caller.

| Limit                     | Default  | Counted                                                               |
| ------------------------- | -------- | --------------------------------------------------------------------- |
| `ipVisitorsPerHour`       | 20       | new visitors from one address, and as many first messages             |
| `perMinute`, `perDay`     | 10, 200  | one visitor's messages                                                |
| `ipPerMinute`, `ipPerDay` | 30, 1000 | messages from the visitors one address brought                        |
| `linePerMinute`           | 300      | the site's messages, all its visitors                                 |
| `newcomersPerMinute`      | 200      | of those, newcomers' (not spoken before the minute): the rest is kept |
| `visitorsPerHour`         | 600      | new visitors who speak (contacts made), on the site                   |

The limits by address hold for each network the address is in, counting as several callers:

- an IPv4 address, and its /24 as 8;
- an IPv6 /64, its /56 as 4, and its /48 as 8.

So one routed /48 is one site, not 65,536 callers.

## The caller's address

The caller's address is the one the app's front says, through the `caller` resource, the same way
MCP's servers take it. Otherwise it's the address the socket came from. `Deno.serve` and `listen`
give it, and a listener of your own says it with `setClientAddress`, from `copilotz`.

With neither, nobody is let in. When every visitor comes from one private address, such as a
proxy's, the runtime warns once.

## Budget and challenge

A site may have a `budget`: what its visitors' turns may be charged in a day, in the usage ledger's
prices. It needs the usage plugin. Past it, visitors wait for the next day.

Pricing a visitor's use is the site's own bookkeeping, not something the visitor may do. So the site
charges it under a named grant, `web.budget`, on the record and counted in
[`copilotz.elevated.ops`](../operations/metrics.md).

A site may also have a `challenge`: an Action of the app's that checks what the page answered coming
in, such as a CAPTCHA's token, before a newcomer is let in:

```ts
web({ arrive: { name: "site", challenge: token } });
```

## Messages, files and connections

- A message says 4,096 characters at most.
- Files go only to a site that takes them, `files: { count, bytes }`. That's 1 file of 5 MB unless
  the site says, and 10 files of 10 MB at most.
- The page uploads each file on its own first, with `chat.attach`, then sends it by id. The site
  lets each upload in as a message to nobody, so it counts against the visitor's limits.
- Audio is transcribed, which is a model call, only with `transcribe: true`.
- A visitor holds 2 connections, with 32 reads on each.
- A visitor is told a failure's words only when they're meant for anyone.

## Forgetting and collecting

Erasing the contact (`contact.forget`) ends its cookie and its connections at once. Removing its
site does the same.

What's past is collected every 10 minutes: counters, records, and a contact whose first message
never went in.

## Changing the app's secret

To change the app's secret, give the old one as `links.previous` for a while. Visitors and links it
signed stay good.

## Many orgs

With [many orgs](many-orgs.md), each org's runtime declares its own sites. A visitor's page is at
the org's address, `/o/<org>/`, and it comes in at `/o/<org>/web/<name>`. Its cookie is the org's,
`visitor_<org>`.
