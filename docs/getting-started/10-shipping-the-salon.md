---
title: "Chapter 10: Shipping the salon"
description: "The salon, kept and online: SQLite on your machine, PostgreSQL with a lease for deploys, a secret that keeps conversations themselves, a public origin without dev sign-in, staff invited by email, and the desk made once."
section: Getting Started
order: 100
status: stable
---

# Chapter 10: Shipping the salon

> Part 3, online · Requires: Chapter 9 · Code: `chapter-10`

## The pain

Until now the salon has lived in memory. Stop the server and every booking is gone. Start it again
and each assistant's conversation is a stranger, because its id came from a secret made at start.
Put it online and dev sign-in can't come along. Deploy a new version and, for a moment, two
processes write the same database.

## The problem

Keep everything, with the same code on a laptop and a server. Keep conversations themselves across
restarts. Go public without opening the desk to anyone, and still let Sam in. And hand over from one
process to the next without two writers.

## The solution

A store from the environment, a few changes to `server.ts`, and `openDesk` made safe to run twice.

### Kept

`store.ts` opens the store the environment says. On this machine, one SQLite file. With
`DATABASE_URL`, PostgreSQL: the same documents and events, and nothing else in the app changes.

```ts
if (env.DATABASE_URL) {
  // Loaded only when asked for: PostgreSQL's client is more to load than SQLite's.
  const { lease, postgresPool, postgresStore } = await import("copilotz/stores/postgres");
  const pool = await postgresPool({ url: env.DATABASE_URL });
  return {
    store: await postgresStore({ pool }),
    // Each deploy's number (`SALON_REVISION`): a newer one asks the one before to hand over.
    hold: (on) => lease(pool, { revision: Number(env.SALON_REVISION ?? 0), ...on }),
    close: () => pool.close(),
  };
}
const path = env.SALON_DATA || ".data/salon.sqlite";
await mkdir(dirname(path), { recursive: true });
return { store: await sqliteStore({ path }), close: async () => {} };
```

On PostgreSQL there's also a **lease**: one process at a time writes the database. A new process
waits for it and asks for it. The one holding it stops listening, finishes what's running, and lets
go.

### Made once

A kept desk is there the next time, and making it again fails with `duplicate_key`. `openDesk` lets
that one through:

```ts
export async function openDesk(runtime: Runtime, staff?: { email: string }): Promise<void> {
  const sam: Actor = { kind: "person", id: "sam" };
  await runtime.call("person.set", { person: "sam", name: "Sam" });
  await runtime.call("space.create", { id: DESK, name: "Front desk" }, { actor: sam })
    .catch((error) => {
      if (error.code !== "duplicate_key") throw error;
    });
  if (staff) await runtime.call("email.invite", { email: staff.email, person: "sam", name: "Sam" });
}
```

### Served

`server.ts` opens the salon through Copilotz's `serve` instead of `listen`. It listens first, so the
platform sees it's up, takes the lease if there is one, then opens the runtime:

```ts
// It listens first, takes the store's lease (PostgreSQL's), then opens the salon.
const { server } = await serve(async () => {
  const runtime = await createRuntime({
    store: storage.store,
```

```ts
  await openDesk(runtime, staff);
  return runtime;
}, {
  hostname: local ? "127.0.0.1" : "0.0.0.0",
  port,
  signal: stopping.signal,
  ...(storage.hold ? { hold: storage.hold } : {}),
  stopped: (code) => void storage.close().finally(() => process.exit(code)),
});
```

### A secret that stays

MCP's conversations and the site's visitors get their ids from the `links` secret. A new secret each
start makes every one of them someone new. `SALON_SECRET` keeps it, and the server says when it's
missing:

```ts
const secret = env.SALON_SECRET || randomBytes(32).toString("hex");
if (!env.SALON_SECRET) console.warn("No SALON_SECRET: assistants' and visitors' chats start over.");
```

`openssl rand -hex 32` makes one. Put it in `.env`.

### Public

ChatGPT, Claude and Meta need a public `https` address: `SALON_ORIGIN`. Then three things change:

- **Dev sign-in is out.** Copilotz won't start it with a public origin.
- **Staff sign in by email.** With `SALON_STAFF` (Sam's address), `RESEND_API_KEY` and `SALON_FROM`,
  the app adds Copilotz's `email` and `emailSignIn`, sending through Resend. Nobody signs up
  (`signUp: false`). `openDesk` invites Sam instead: a link, where he chooses a password and arrives
  signed in as `sam`, manager of the desk.
- **Callers are counted by the proxy's word.** Behind the platform's proxy, every request comes from
  the proxy. The `caller` setting says where the caller's own address is: the last entry the proxy
  appended to `x-forwarded-for`. The site's and MCP's limits by address count with it.

```ts
// Online, staff sign in by email: Sam's address, and Resend's key and sender.
const staff = !local && env.SALON_STAFF && env.RESEND_API_KEY && env.SALON_FROM
  ? { email: env.SALON_STAFF, apiKey: env.RESEND_API_KEY, from: env.SALON_FROM }
  : undefined;
```

```ts
...(staff ? { email: { apiKey: staff.apiKey, from: staff.from } } : {}),
// Behind the platform's proxy, a caller is the address it appended last.
...(local
  ? {}
  : { caller: { header: "x-forwarded-for", hops: Number(env.SALON_HOPS ?? 1) } }),
```

In `app.ts`, the email setting becomes two plugins and their resources:

```ts
...(settings.email
  ? {
    email: { adapter: "resend", ...settings.email },
    emailSignIn: { app: "The salon", signUp: false },
  }
  : {}),
```

`.env.example` lists every variable, each with what happens without it.

### Tested

`tests/kept.test.ts` opens the salon as the server does, on a SQLite file in a temporary folder,
three times:

```ts
// Started again: the same bookings, and the desk wasn't made twice.
const second = await start(env);
try {
  assert.equal(
    await seen(second, "bookings", sam),
    "Tue 10:00 (tue-10), for Rui\nWed 15:00 (wed-15), for Assistant",
  );
  const asked = await assistant(second, "conversation-1").call("my_bookings");
  assert.equal(asked.text, "Wed 15:00 (wed-15), for Assistant");
} finally {
  await second.close();
}
// With another secret, the same conversation is someone new.
const third = await start(env, "another-secret-for-the-salon-0123456789");
```

## Run it

With `SALON_SECRET` in `.env`, start the salon, book from an assistant, stop it with Ctrl+C, and
start it again. The same handle reads the same booking:

```text
$ tools/call book {"slot":"wed-15"}
Booked Wed 15:00.

Bookings:
Wed 15:00 (wed-15), for Assistant

chat: kix0gO-FRvfOEdTcl-A1Nw
(stopped, started again)
$ tools/call my_bookings {"chat":"kix0gO-FRvfOEdTcl-A1Nw"}
Wed 15:00 (wed-15), for Assistant
```

Now PostgreSQL, and a deploy. Start the salon with `DATABASE_URL`, book from an assistant, and then
start a second one on another port, as a new deploy would. The first hands over:

```text
The salon's site on http://127.0.0.1:8098/, the desk at /space/desk, MCP at http://127.0.0.1:8098/mcp/salon
A newer process asks for the store: handing over
```

```text
Waiting for the previous process to let go of the store…
The salon's site on http://127.0.0.1:8099/, the desk at /space/desk, MCP at http://127.0.0.1:8099/mcp/salon
web: visitors come from 127.0.0.1, a private address: a proxy or a load balancer's before the app, not theirs. Every visitor is then counted as one caller, so the limits by address hold for everyone together. Say how the app's front names callers (the caller resource), unless this is a machine of your own.
```

The same handle reads the same booking through the second process. When a visitor opened the site
there, the salon said what the `caller` setting is for. And `npm test`:

```text
✔ kept: the bookings outlive the process, and a conversation stays itself (143.603375ms)
```

## What this unlocks

- **The same salon, laptop to server.** SQLite or PostgreSQL by one variable, and no change in the
  app.
- **Deploys without two writers.** `serve` and the lease hand over from one process to the next.
- **Online, honestly.** Customers come in from anywhere. Staff come in by invitation only.

## Your challenge

Deploy the salon to a host with PostgreSQL, behind a tunnel or the host's own `https` address. Add
it to ChatGPT in developer mode, and book from there while Sam watches the desk.

## What's next

You built one app, and opened it to its staff, its own agent, ChatGPT, Claude and Gemini, a site's
visitors and WhatsApp, with one set of Actions, rules and record.

- **Chapter 11, signed in from ChatGPT and Claude,** is coming with MCP sign-in. The assistant will
  book for Bia herself, not for "Assistant", and the record will say so.
- **[Build Compass](../build-compass.md)** is the deep track. You build a workspace for people and
  agents, and rebuild Copilotz's own plugins to its contract, one primitive at a time.
