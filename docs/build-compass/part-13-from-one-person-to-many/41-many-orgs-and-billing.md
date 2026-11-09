---
title: "Chapter 41: Many orgs and billing"
description: "One address, many orgs: a directory runtime signs people in and knows their orgs, and each org is a Compass of its own, opened when used and closed when idle. With Copilotz's usage ledger, what each org's agents use is recorded and priced in that org alone."
section: Build Compass
order: 410
status: stable
---

# Chapter 41: Many orgs and billing

> Part 13, from one person to many · Requires: Chapter 40 · Code: `lesson-13.3`

## The pain

Ana and Bruno share a space now. But Bruno works for another company too, Globex, with a launch of
its own. Put both companies in one Compass and every space, board and conversation sits in one
store, kept apart only by who's a member of what. One wrong invitation and Globex reads Acme's
plans. And when the model bill comes, there's one bill, for everyone.

## The problem

Companies need more than spaces between them: they need **orgs**, each with its own data, its own
people and its own bill, behind the same address. That's how the real Compass works, and Copilotz
has the parts:

- **`directory`** (`copilotz/plugins/access`): a runtime of its own that signs people in and knows
  which orgs each belongs to. Its `fetch` is the whole app: its routes answer its own paths
  (`/orgs`, signing in) and hand everything else, untouched, to the org's runtime, by address
  (`/o/<org>/…`) or by the org the browser is in (`plugins/access/directory/mod.ts:134` and `:136`).
- **`runtimes`** (`copilotz`): a pool of runtimes, one per org, each opened on its first use and
  closed after 30 minutes nobody's used it (`runtime/runtimes.ts:42`).
- **`directory.member(dir, org)`**: what each org's runtime gets of the directory: which org it is,
  where it's served (`page: { base }`), and its cookies' names, so one org's session never reads
  another's (`plugins/access/directory/shared/member.ts:48`).
- **`usage`** (`copilotz/plugins/billing`): the usage ledger. It plugs into the models plugin's
  `modelUse` (`plugins/billing/usage/mod.ts:86`), so every model call is recorded in the job that
  made it: what it used, what it cost, what to charge, tagged with the agent and the person.

## The solution

### The ledger, in Copilotz's list

`app.ts` adds `usage` right after `models`, which it plugs into:

```ts
function copilotzPlugins(settings: Settings): Plugin[] {
  return [
    models,
    // What every model call used, cost and is charged: the usage ledger.
    usage,
    chat,
    // …
  ];
}
```

And an org has nobody in particular, so `you` becomes optional. The two things that need it, your
identity's `identity` resource and the MCP server for your assistant, come only with it:

```ts
/**
 * Who the app is for: you, on this machine. On Copilotz's plugins, an app
 * of many people (orgs.ts) has nobody in particular: people sign in.
 */
you?: You;
// …
...(settings.you ? { identity: settings.you } : {}),
// …
// Your board for an assistant on this machine (Claude Code, Codex): POST /mcp/compass.
...(settings.you
  ? {
    mcp: {
      compass: {
        in: `personal:${settings.you.person}`,
        // …
      },
    },
  }
  : {}),
```

### orgs.ts

`orgs.ts` serves many orgs from one process, in memory, the way Copilotz's
`examples/web-node/orgs.ts` does. Each org is Compass on Copilotz's plugins, with its own store:

```ts
// Each org's rows, while the process runs: one closed while idle opens again with them.
const stores = new Map<string, Store>();
const orgs = runtimes(async (id) => {
  const org = await dir.query<OrgInfo | null>("org.info", { org: id });
  if (!org) return undefined;
  if (!stores.has(id)) stores.set(id, memoryStore());
  return await createRuntime({
    store: stores.get(id)!,
    plugins: [
      ...plugins({ copilotz: true, openai: settings.openai }),
      ...settings.plugins ?? [],
      ...page,
      directory.member(dir, org),
    ],
  });
});
```

The directory is identity, the directory, and how people sign in there (here, by name, from this
machine), told where the orgs are, and where someone signed in nowhere goes (the lobby: the page,
which shows how to sign in). It starts with two orgs, each with its owner:

```ts
const dir: Runtime = await createRuntime({
  store: memoryStore(),
  plugins: [
    identity,
    directory,
    devSignIn,
    definePlugin({ name: "directory-settings", resources: { directory: { orgs, lobby } } }),
  ],
});
for (const { id, name, owner } of ORGS) {
  await dir.call("person.set", owner);
  await dir.call("org.create", { id, name, kind: "team", by: owner.person });
}
```

`ORGS` is Acme, Ana's, and Globex, Bruno's. `openOrgs` returns the app's `fetch` (the directory's),
an org's runtime by id, and `close`; run as a program (`npm run orgs`), it listens on
`127.0.0.1:8081`. People sign in once, at the directory (its session is the `dir` cookie), and going
into an org gives them a session there (`s_<org>`): the org's runtime lets them in with `org.join`,
as the directory's handoff says (`plugins/access/directory/routes/enter.ts:44`).

### Each org's board is its own

`tests/orgs.test.ts` goes through the directory's `fetch` as a browser on this machine does, keeping
the cookies each response sets. Each person signs in, lists their orgs, goes into one, and makes a
board there at its address, through the REST API:

```ts
async function boardIn(app: App, name: string, org: string, board: string) {
  const as = browser(app);
  await as("POST", "/signin/dev", { name });
  const mine = await as<{ orgs: { name: string }[] }>("GET", "/orgs");
  assert.equal((await as("POST", "/orgs/enter", { org })).status, 200);
  const { body: { space } } = await as<{ space: string }>(
    "POST",
    `/o/${org}/api/actions/space.create`,
    { name: "Launch" },
  );
  await as("POST", `/o/${org}/api/actions/board.create`, { in: space, name: board });
  return { as, space, orgs: mine.body.orgs.map((o) => o.name) };
}
```

Ana finds Acme and only Acme; Bruno, Globex. Each reads their own board. Ana can't go into Globex (a
403), and at Globex's address she has no session, so she reads nothing:

```ts
assert.deepEqual(ana.orgs, ["Acme"]);
assert.deepEqual(bruno.orgs, ["Globex"]);
assert.deepEqual(await boards(ana.as, "acme"), ["Acme launch"]);
assert.deepEqual(await boards(bruno.as, "globex"), ["Globex launch"]);
assert.equal((await ana.as("POST", "/orgs/enter", { org: "globex" })).status, 403);
assert.deepEqual(await boards(ana.as, "globex"), []);
```

### Each org's ledger

The second test gives the orgs a model that says what it used: OpenAI, played by a server on this
machine, answering every call with 900 tokens in and 100 out. Ana says hi to North in Acme; Acme's
ledger has North's call, priced from the catalog's prices for `gpt-6-luna`; Globex's has no model
call at all:

```ts
const spent = await acme.query<Total[]>("usage.totals", by);
assert.deepEqual(llm(spent).find((t) => t["tags.agent"] === "north"), {
  meter: "llm",
  "tags.agent": "north",
  input: 900,
  output: 100,
  // Priced from the catalog, gpt-6-luna's: its cost, with no margin unless the app sets one.
  price: 0.00014,
});
assert.deepEqual(llm(await globex.query<Total[]>("usage.totals", by)), []);
```

That's what billing is built on: the price is the cost unless the app's `price` resource sets a
margin, and the real Compass adds plans and credits on top (`credits`, `stripe`), org by org.

## Run it

```sh
PORT=8091 OPENAI_API_KEY= node --disable-warning=ExperimentalWarning orgs.ts
```

```text
Compass, for many orgs, on http://127.0.0.1:8091/
```

Then, in another terminal, Ana and Bruno with `curl`, each with a cookie jar of their own (`post`
and `get` are `curl -s -b <jar> -c <jar>`, with JSON):

```text
$ post ana.jar /signin/dev '{"name":"ana"}'
{"person":"ana"}
$ get ana.jar /orgs
{"person":"ana","email":"ana@example.com","current":null,"orgs":[{"id":"acme","name":"Acme","kind":"team"}],"invites":[],"staff":false,"asStaff":false}
$ post ana.jar /orgs/enter '{"org":"acme"}'
{"org":{"id":"acme","name":"Acme","kind":"team"}}
$ post ana.jar /o/acme/api/actions/board.create '{"in":"58892b57-8668-4f9e-913a-7c87e782e7fd","name":"Acme launch"}'
$ get ana.jar /o/acme/api/collections/board
[{"in":"58892b57-8668-4f9e-913a-7c87e782e7fd","name":"Acme launch","columns":[{"id":"backlog","name":"Backlog"},{"id":"todo","name":"To do"},{"id":"doing","name":"Doing"},{"id":"blocked","name":"Blocked"},{"id":"review","name":"In review"},{"id":"done","name":"Done"}],"by":"person:ana","at":"2026-11-08T11:31:06.654Z","_id":"b6d2887388b9"}]
$ post bruno.jar /signin/dev '{"name":"bruno"}'
{"person":"bruno"}
$ post bruno.jar /orgs/enter '{"org":"globex"}'
{"org":{"id":"globex","name":"Globex","kind":"team"}}
$ get bruno.jar /o/globex/api/collections/board
[]
$ post bruno.jar /orgs/enter '{"org":"acme"}'
{"error":"No such org, or not one you belong to."}
```

(Ana's space came from `space.create` at `/o/acme/api/actions/space.create`, just before.)

## Check it

`tests/orgs.test.ts`: through the directory, each person finds only their own org, makes a board
there, and reads only that org's boards; going into someone else's org is refused. And what North's
turn used is in its org's ledger, priced, and in no other.

## Also in this chapter

- `package.json`: `npm run orgs`.
- `orgs.ts` takes more plugins for every org (`plugins`): the test's OpenAI address.

`git diff lesson-13.2 lesson-13.3` shows every change.

## What you have now

The whole arc: a harness for one person on their own machine, rebuilt plugin by plugin to Copilotz's
contracts, and the same app, on Copilotz's own plugins, serving many people in many orgs, each with
its own data and its own bill. `npm run dev` is still Compass for you alone.
