---
title: "Many orgs behind one address"
description: "One app, many orgs: a directory runtime signs people in and knows their orgs, and each org is a runtime of its own, opened when used and closed when idle."
section: Guides
order: 2
---

# Many orgs behind one address

An app that serves many orgs runs a directory in front of them. Each org is a runtime of its own,
with its own store.

## The directory and its orgs

The directory (`directory`) is a runtime of its own. It signs people in and knows their orgs. The
decisions behind it are in [the tenancy design](../../design/tenancy.md).

Each org is a runtime too. A pool of runtimes (`runtimes`, from `copilotz`) opens one when it's
first used. It closes one after 30 minutes with no browsers connected and nothing pending, and opens
it again on its next use. Two runtimes of one org never run at once, so its store has one writer.

The directory's `fetch` is the whole app. Its routes answer its own paths: `/orgs`, signing in and
out, and staff's console. Everything else goes, untouched and sockets included, to the org's
`runtime.fetch`. The directory finds the org 3 ways:

- by address, `/o/<org>/…`;
- by the browser's `org` cookie;
- by a host the org claimed.

URLs and cookie names are the same as with one runtime. `directory.member` keeps them apart per org.

## The code

```ts
import { createRuntime, definePlugin, type Runtime, runtimes } from "copilotz";
import { memoryStore } from "copilotz/stores/memory";
import { devSignIn, directory, identity, type OrgInfo } from "copilotz/plugins/access";
import { webPage } from "copilotz/web/server";
import { themeOf } from "copilotz/web/theme";
import { bundle, listen } from "copilotz/web/node";
import { plugins, storeOf } from "./app.ts"; // the app's plugins, and where an org's rows live

// The page, the same for the lobby and every org (each at its own address).
const code = await bundle(new URL("./browser.tsx", import.meta.url));
const page = [
  webPage,
  definePlugin({ name: "page", resources: { page: { code }, theme: themeOf([]) } }),
];

// Each org's runtime, opened on its first use, closed after 30 minutes nobody used it.
const orgs = runtimes(async (id) => {
  const org = await dir.query<OrgInfo | null>("org.info", { org: id });
  if (!org) return undefined;
  return await createRuntime({
    store: await storeOf(org),
    plugins: [...plugins, ...page, directory.member(dir, org)],
  });
});

// What someone signed in nowhere gets: the sign-in page.
const lobby = await createRuntime({ store: memoryStore(), plugins: page });

const dir: Runtime = await createRuntime({
  store: memoryStore(),
  plugins: [
    identity,
    directory,
    devSignIn,
    definePlugin({
      name: "directory-settings",
      resources: { directory: { orgs, lobby, staff: ["you@example.com"] } },
    }),
  ],
});
const server = await listen(dir.fetch, { port: 8080 }); // or Deno.serve(dir.fetch)
```

## What each org's runtime gets

`directory.member(dir, org)` gives each org's runtime 4 things:

- which org it is, as `resources.org`;
- where it's served, as `page.base`: `/o/<org>`;
- its cookies' names: `s_<org>` for its session, and `<name>_<org>` for the rest;
- the directory's hooks for invitations, leaving and renaming.

## Hosts

Name the app's own hosts with the `hosts` resource, such as `{ "app.example.com": true }`. Any other
host is then an org's claimed one, answered by that org's host routes alone.

## What stays in the directory

Whatever has one address for every org lives in the directory's runtime. Stripe's webhook is one
(`stripeWebhook`, with the `stripe` resource's `orgs`). The cloud pool's socket is another.

## Examples

- `examples/web-node/orgs.ts` runs it in memory, on Node.
- `examples/terminal-agent/orgs.ts` runs it on Deno, with each org a tenant of one PostgreSQL schema,
  and staff's operations.

[Build Compass, Chapter 41](../build-compass/part-13-from-one-person-to-many/41-many-orgs-and-billing.md)
builds it step by step, with each org's usage priced in that org alone.
