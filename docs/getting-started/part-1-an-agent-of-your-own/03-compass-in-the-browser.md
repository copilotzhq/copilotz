---
title: "Chapter 3: Compass in the browser"
description: "Rebuild Copilotz's identity plugin for one person on their own machine (a collection, an Action, a who, a route and a rule), then serve Compass's web page in its own look."
section: Getting Started
order: 30
status: stable
---

# Chapter 3: Compass in the browser

> Part 1, an agent of your own · Requires: Chapter 2 · Code: `lesson-1.3`

## The pain

A terminal is fine for you; a web page is what most people use. But the moment the app answers HTTP,
it has to know who each request is. A page that answers anyone who finds the port isn't yours
anymore, and on the web, "anyone" includes pages on other sites that your browser happens to have
open.

## The problem

Copilotz's own `identity` plugin answers "who is this?" with sessions: a sign-in sets a cookie, and
identity's `who` reads it. That's right for an app many people share. Compass here is for one person
on their own machine, so the honest answer is simpler: a request from this machine, to this machine,
is you; anything else is nobody. You'll rebuild identity with that answer, keeping its contract, so
Copilotz's web front ends work with yours in its place.

## The solution

### Identity, for one person

Copilotz's identity plugin, and the one you write, have the same contract: a `person` collection
with a `profile` query, a `person.set` Action, a `who`, and the route `GET /me`. What yours leaves
out is everything about sessions and sign-in.

```text
plugins/identity/
  mod.ts
  contract.ts           Person, and You: who the app is for
  collections/person.ts
  actions/person.ts     person.set
  routes/me.ts          GET /me
  shared/here.ts        whether a request is this machine's
```

The collection is documents with a JSON Schema, plus a named query that reads them
(`collections/person.ts`):

```ts
import { defineCollection, type Infer } from "copilotz";

const personSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    email: { type: "string" },
    picture: { type: "string" },
    at: { type: "string" },
  },
  required: ["at"],
} as const;

export const person = defineCollection({
  schema: personSchema,
  queries: {
    /** What the app shows a person as (their name, email, picture), for the host: no `allow`. */
    profile: async (people, params: { person: string }) => {
      const found = await people.findOne({ _id: params.person });
      return found
        ? {
          ...(found.name ? { name: found.name } : {}),
          ...(found.email ? { email: found.email } : {}),
          ...(found.picture ? { picture: found.picture } : {}),
        }
        : null;
    },
  },
});

export type Person = Infer<typeof personSchema> & { _id: string };
```

`person.set` writes it (`actions/person.ts`). An Action has a JSON Schema `input`, checked before it
runs, and a `run` that gets a context (`ctx.db.collection(…)` with MongoDB's API) and the input:

```ts
export const setPerson = defineAction({
  description: "Keeps what the app knows about a person: their name, email, picture",
  input: {
    type: "object",
    properties: {
      person: { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
      picture: { type: "string" },
    },
    required: ["person"],
    additionalProperties: false,
  },
  run: async (ctx, input) => {
    const people = ctx.db.collection<Person>("person");
    const known = await people.findOne({ _id: input.person });
    await people.updateOne({ _id: input.person }, {
      $set: {
        ...(input.email ? { email: input.email.trim().toLowerCase() } : {}),
        ...(input.name ? { name: input.name } : {}),
        ...(input.picture ? { picture: input.picture } : {}),
        at: known?.at ?? new Date().toISOString(),
      },
    }, { upsert: true });
    return { new: !known };
  },
});
```

It has no `allow`, so only the system (the app's own code) may call it. An Action that people may
call from outside says who: `allow: (actor) => actor.kind === "person"`.

Whether a request is from here (`shared/here.ts`): the socket it came on is loopback, the host it
asked for is loopback, and no header says a proxy forwarded it. No header can make it so: a page
another site served, whose name now points here, still asked for another host.

```ts
import { clientAddress, loopback, loopbackAddress } from "copilotz";

/** Headers a proxy adds to say whom it forwards for, or that it did. */
const FORWARDING =
  /^(?:forwarded|via|x-forwarded-.+|x-real-ip|x-client-ip|cf-connecting-ip|true-client-ip)$/;

export function fromHere(request: Request): boolean {
  if (!loopbackAddress(clientAddress(request))) return false;
  if ([...request.headers.keys()].some((name) => FORWARDING.test(name.toLowerCase()))) return false;
  return loopback(new URL(request.url).hostname);
}
```

Then the plugin (`mod.ts`):

```ts
export const identity: Plugin = definePlugin({
  name: "identity",
  collections: { person },
  actions: { "person.set": setPerson },
  // A request from this machine is you; any other is nobody (anonymous).
  who: (request, { resources }) => {
    const you = resources.identity as You | undefined;
    return you && fromHere(request) ? { kind: "person", id: you.person } satisfies Actor : null;
  },
  routes: { "/me": me },
  guard: (actor, { collection, access, direct }) => {
    // People change only through their Actions, never directly from outside.
    if (collection === "person" && direct && access === "write") {
      throw failure("forbidden", "People change through their Actions.", { public: true });
    }
    // Everything here is yours; nobody else reaches anything. Code acting for you isn't checked.
    if (actor.kind === "person") return true;
    return direct ? { _id: { $in: [] } } : undefined;
  },
  check(merged) {
    const you = merged.resources.identity as You | undefined;
    if (!you?.person) {
      throw new Error("identity needs to know who you are: resources.identity.person");
    }
  },
});
```

Four hooks besides the primitives:

- **`who`** says which actor a request is. The runtime asks each plugin's `who` in order, once per
  request; if none answers, the request is anonymous. Here: you, or nobody.
- **`routes`** are plain functions on HTTP, by URL pattern: a web-standard `Request` in, a
  `Response` out. `GET /me` tells the page whom it's showing. Routes deal with HTTP; Actions do the
  work.
- **`guard`** is the rule: for an actor and an operation on a collection, a filter its documents
  must match, `true` for "nothing to restrict", or `undefined` for "this rule has nothing to say". A
  collection no rule speaks for never reaches the outside (a browser, the REST API). Each plugin
  guards its own collections from direct writes (chat refuses them for messages, too); this one adds
  who reaches anything at all.
- **`check`** runs once all plugins are merged, so a missing setting stops the app from starting.

Who "you" are is a setting. `you.ts` reads it (your user name on this machine, or `COMPASS_ME` and
`COMPASS_NAME`), and `app.ts` puts it in the `identity` resource and adds `identity` to the list,
after chat.

### The page

The page is a plugin too. Copilotz's `webPage` serves the browser's code, the app's files and the
page itself, from a `page` resource. `server.ts`:

```ts
import process from "node:process";
import { createRuntime, definePlugin } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { webPage } from "copilotz/web/server";
import { themeOf } from "copilotz/web/theme";
import { bundle, listen } from "copilotz/web/node";
import { plugins } from "./app.ts";
import { compassTheme } from "./plugins/compass/theme.ts";
import { you } from "./you.ts";

const me = you();
const runtime = await createRuntime({
  store: memoryStore(),
  plugins: [
    ...plugins({ you: me, openai: process.env.OPENAI_API_KEY }),
    webPage,
    definePlugin({
      name: "page",
      resources: {
        // The browser's code, bundled once, on the page's first request.
        page: { title: "Compass", code: () => bundle(new URL("./browser.tsx", import.meta.url)) },
        // Compass's look, in the page for its first paint.
        theme: themeOf([compassTheme]),
      },
    }),
  ],
});
await runtime.call("person.set", me);

const server = await listen(runtime.fetch, {
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8080),
});
console.log(`Compass on ${server.url}`);
```

`runtime.fetch` is a fetch handler: a `Request` in, a `Response` out. `listen` serves it on Node,
sockets included; on Deno, `Deno.serve(runtime.fetch)` does the same. It listens on 127.0.0.1 only.

The browser runs Copilotz's web host with the app's front ends (`browser.tsx` and `front.ts`):

```ts
// browser.tsx
import { web } from "copilotz/web";
import { front } from "./front.ts";

await web({ root: document.getElementById("app")!, plugins: front });
```

```ts
// front.ts
import type { Plugin } from "copilotz";
import { webShell } from "copilotz/plugins/interfaces/web";
import { chatWeb } from "copilotz/plugins/agents/web";
import { compassWeb } from "./plugins/compass/web.tsx";
import { compassTheme } from "./plugins/compass/theme.ts";

export const front: Plugin[] = [webShell, chatWeb, compassWeb, compassTheme];
```

The web shell is the frame (the sidebar, the main area by address, the command palette); chat's
front end fills it with conversations. Compass adds its own: its theme (`theme.ts`: the mark and
colours, a `theme` resource) and its home's suggestions (`web.tsx`: chat's `suggestions` resource,
with chat's defaults set to `null` and Compass's in their place). That's how an app changes a plugin
it didn't write: it patches the plugin's resources.

The page connects to the runtime over a socket, as you: it trades its request for a one-time ticket
at `POST /connect` (where `who` says it's you), and from then on every read and call it makes is
yours, under the rules.

## Run it

```sh
node --env-file-if-exists=.env server.ts
```

Open http://127.0.0.1:8080: Compass greets you by name, in its own look, and North answers in the
browser.

## Check it

`plugins/identity/tests/identity.test.ts` needs no listener: `runtime.fetch` takes a `Request`, and
`setClientAddress` says where it came from, as a listener would.

```ts
test("a request from this machine is you, and /me says your name", async () => {
  const runtime = await app();
  try {
    const response = await runtime.fetch(from("127.0.0.1", "http://127.0.0.1:8080/me"));
    assert.deepEqual(await response.json(), { person: "ana", name: "Ana" });
  } finally {
    await runtime.close();
  }
});

test("from another machine, or through a proxy, it's nobody", async () => {
  const runtime = await app();
  try {
    const elsewhere = await runtime.fetch(from("192.168.1.20", "http://192.168.1.20:8080/me"));
    assert.equal(elsewhere.status, 401);
    const proxied = await runtime.fetch(
      from("127.0.0.1", "http://127.0.0.1:8080/me", { "x-forwarded-for": "203.0.113.7" }),
    );
    assert.equal(proxied.status, 401);
  } finally {
    await runtime.close();
  }
});
```

## What you have now

Your first rebuilt plugin: identity, the same contract as Copilotz's, for one person. Compass runs
in the terminal and in the browser, in its own look, and only for you. Part 2 makes the plugins your
own: what the agents know each turn, where everything is kept, and what happens when events happen.
