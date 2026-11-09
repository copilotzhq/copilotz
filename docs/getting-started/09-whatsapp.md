---
title: "Chapter 9: WhatsApp"
description: "A WhatsApp number open to anyone: Meta's webhook comes in signed, the concierge answers through the Graph API, and each customer is a contact with a chat of their own. Offline, the Graph API is a fake."
section: Getting Started
order: 90
status: stable
---

# Chapter 9: WhatsApp

> Part 2, the ways in · Requires: Chapter 8 · Code: `chapter-9`

## The pain

In much of the world, customers book on WhatsApp. That usually means a separate bot: a webhook
server, a Graph API client, a session store, and the booking logic again, in whatever shape the
bot's framework likes. It's also the hardest one to test, because Meta is on both ends.

## The problem

Anyone who writes to the salon's number should be a customer, with a chat of their own, answered by
the concierge, under the same rules. Meta's deliveries must be checked as Meta's. And the tests must
run with no network: Meta's webhook in, Meta's API out, both played locally.

## The solution

Copilotz's `whatsapp` plugin, a few settings, and the runtime's `fetch` as the test's edge.

### The number

`app.ts` takes a new setting, the number's: Meta's ids, the access token, the Meta app's secret
(deliveries are signed with it), and the token Meta's webhook check is answered with.

```ts
whatsapp?: { phoneId: string; token: string; secret: string; verify: string; quiet?: number };
```

With it, the app adds the `whatsapp` plugin, and declares the number, open to anyone:

```ts
// A customer who writes to the number is a contact, in a chat of their own at the desk.
...(settings.whatsapp
  ? { whatsapp: { salon: { in: DESK, agent: "concierge", ...settings.whatsapp } } }
  : {}),
```

- **Its webhook** is `/hooks/whatsapp/salon`, for Meta's dashboard. Each delivery's signature is
  checked before anything else runs.
- **A stranger who writes** is a contact, named by their WhatsApp profile, in a chat of their own at
  the desk, answered by the concierge. They reach that chat and nothing else.
- **What the concierge says** goes back through Meta's Graph API, as WhatsApp formats it.
- **`quiet`** is how many seconds a burst of messages may go on before the concierge answers them
  together, 4 unless said. The tests say 0.

`server.ts` passes the number when all four of Meta's settings are in the environment:

```ts
// A WhatsApp number, when all four of Meta's settings are there.
const number =
  env.WHATSAPP_PHONE_ID && env.WHATSAPP_TOKEN && env.WHATSAPP_SECRET && env.WHATSAPP_VERIFY
    ? {
      phoneId: env.WHATSAPP_PHONE_ID,
      token: env.WHATSAPP_TOKEN,
      secret: env.WHATSAPP_SECRET,
      verify: env.WHATSAPP_VERIFY,
    }
    : undefined;
```

That's the whole change to the app. The bookings plugin doesn't know WhatsApp exists.

### Meta, played locally

Meta is on both ends, so the test plays both. `tests/ways.ts` gets its third way in, `whatsapp()`,
which posts a customer's message as Meta delivers it, signed with the number's secret. And `graph()`
is Meta's Graph API: a `fetch` that keeps every message the app sends, and answers each with an id.
`createRuntime({ fetch })` hands it to the app, which calls out only through the runtime's `fetch`:

```ts
const meta = graph();
const { runtime, store } = await salon({
  fetch: meta.fetch,
  settings: { whatsapp: NUMBER },
  moves: [{ tool: "book", input: { slot: "thu-09" } }, "Booked: Thursday at 9:00."],
});
try {
  assert.equal(await whatsapp(runtime, dora, "Thursday 9 please"), 200);
  assert.deepEqual(meta.texts(dora.phone), ["Booked: Thursday at 9:00."]);
  assert.equal(await seen(runtime, "bookings", sam), "Thu 09:00 (thu-09), for Dora");
  assert.equal((await bookedBy(store))["Thu 09:00"], "agent concierge for contact Dora");
```

The same test posts a delivery with a forged signature, and it's refused.

The payoff test gains its fifth way in: Dora books Saturday from WhatsApp, the desk's tab shows
every slot booked, and the record says `agent concierge for contact Dora`. Its rules test has Dora's
concierge told to cancel Bia's booking, and refused. The tour gains WhatsApp too, with Meta's API
played by the same fake and the model by the real one.

## Run it

The whole tour, with a key:

```sh
npm run tour
```

```text
desk      › booked Tue 10:00 for Rui
bia       › Tuesday at 11:00 is booked for you.
assistant › Booked Wed 15:00.
site      › Booked Friday at 14:00.
whatsapp  › You’re booked for Saturday at 10:00.

The desk sees:
Tue 10:00 (tue-10), for Rui
Tue 11:00 (tue-11), for Bia
Wed 15:00 (wed-15), for Assistant
Fri 14:00 (fri-14), for Site visitor
Sat 10:00 (sat-10), for Dora

The record:
  Tue 10:00  person sam
  Tue 11:00  agent concierge for contact Bia
  Wed 15:00  contact by mcp
  Fri 14:00  agent concierge for contact by web
  Sat 10:00  agent concierge for contact Dora
```

Five ways in, one desk, one record. With a number's settings, the server answers Meta's webhook
check, and refuses what Meta didn't sign:

```sh
PORT=8099 WHATSAPP_PHONE_ID=1000200030004 WHATSAPP_TOKEN=a-graph-token \
  WHATSAPP_SECRET=the-meta-app-secret WHATSAPP_VERIFY=a-verify-token npm run dev
curl -s -w ' [%{http_code}]\n' 'http://127.0.0.1:8099/hooks/whatsapp/salon?hub.mode=subscribe&hub.verify_token=a-verify-token&hub.challenge=1158201444'
curl -s -w ' [%{http_code}]\n' -X POST http://127.0.0.1:8099/hooks/whatsapp/salon \
  -H 'content-type: application/json' -d '{}'
```

```text
1158201444 [200]
Bad signature [401]
```

And `npm test`:

```text
✔ a customer books from WhatsApp, and the desk sees it with everyone else's (110.152ms)
```

## What this unlocks

- **WhatsApp, with no booking code of its own.** A setting and a plugin. The concierge, its tools
  and the rules are the ones the site and the desk use.
- **The hardest way in, tested offline.** Meta's webhook and API are a few lines of fake, at the
  app's one edge, the runtime's `fetch`.
- **Every customer, one desk.** Five ways in, and the desk sees them as one list.

## Your challenge

Send Dora's message twice with the same message id, as Meta sometimes does. Does she get two
answers, or two bookings? Write the test that says.

Next, the salon goes online, and keeps what it's booked.
