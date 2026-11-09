---
title: "Chapter 7: Spaces"
description: "Rebuild Copilotz's spaces plugin for one person by its contract: what chat and other plugins ask of it, a rule that keeps shared documents in real spaces, and a parity test against Copilotz's own."
section: Build Compass
order: 70
status: stable
---

# Chapter 7: Spaces

> Part 2, your own plugins · Requires: Chapter 6 · Code: `lesson-2.4`

## The pain

Everything you and North make lands in one pile: the launch plan next to the dentist's appointment.
And North, answering in one conversation, has no idea which project it's in.

## The problem

Work needs places: a space for the course launch, another for the house, and your Personal space for
the rest. Conversations, and later boards and documents, live in one of them, and agents are told
which. In Copilotz, places are the `spaces` plugin, and other plugins depend on it: chat asks it who
answers in a space, and Copilotz's boards and documents keep their documents in its spaces. You're
rebuilding a plugin other code calls, so its contract is the specification: what they ask, by name,
and what they expect back.

## The solution

### What the others ask

Reading how Copilotz's plugins and front ends use spaces gives the contract to keep:

- the `space` collection, with `name` and `kind` (`"personal"` for your Personal space), and its
  `space.reached` query: each space with what you may do there;
- `space.personal`, `space.create`, `space.rename`, `space.archive`, `space.can` (may you `read`,
  `write` or `manage` it?), `space.agent` (which agent answers new chats) and `space.roster` (who
  works there), with the inputs and answers Copilotz's have;
- the `shared` resource kind: collections whose documents live `in` a space, and the rule that keeps
  them there;
- for chat, a `roster` resource that names the Action answering who works in a space, and a `where`
  context telling agents which space a conversation is in.

What a multi-person app adds on top (people as members, roles, invitations, requests to join,
sharing one document, orgs) stays out. In a Personal space and in every space you make, you can do
everything.

```text
plugins/spaces/
  mod.ts  contract.ts
  collections/space.ts  collections/member.ts
  actions/personal.ts  create.ts  rename.ts  archive.ts  can.ts  agent.ts  roster.ts
  shared/rules.ts  shared/agents.ts
  views/where.ts  views/elsewhere.ts  views/terminal/spaces.ts
  resources/commands.ts  terminal.ts
```

### Collections and Actions

The `space` collection and its query (`collections/space.ts`):

```ts
const spaceSchema = {
  type: "object",
  properties: {
    name: { type: "string" },
    kind: { type: "string" },
    owner: { type: "string" },
    archived: { type: "string" },
    agent: { type: "string" },
  },
  required: ["name", "kind"],
} as const;

export const space = defineCollection({
  schema: spaceSchema,
  queries: {
    reached: {
      allow: people,
      run: async (spaces): Promise<Reached[]> =>
        (await spaces.find({}, { sort: { name: 1 } })).map((space) => ({
          ...space,
          can: space.archived ? ["read", "manage"] : ["read", "write", "manage"],
        })),
    },
  },
});
```

A query that a browser or a script may run says who, with `allow` (`people`, from `copilotz`, is
`(actor) => actor.kind === "person"`). Without it, only the app's own code runs it.

`space.create` (`actions/create.ts`) writes the space and seats the app's agents in it, in one
transaction:

```ts
export const createAction = defineAction({
  description: "Makes a space for your work",
  input: {
    type: "object",
    properties: { id: { type: "string" }, name: { type: "string" }, kind: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  },
  allow: people,
  run: async (ctx, input) => {
    const id = input.id ?? crypto.randomUUID();
    const agents = agentsIn(ctx);
    await ctx.as().transaction(async (tx) => {
      await tx.db.collection("space").insertOne({
        _id: id,
        name: input.name,
        kind: input.kind ?? "shared",
        ...(agents[0] ? { agent: agents[0] } : {}),
      });
      await seat(tx, id, agents);
    });
    return { space: id };
  },
});
```

`space.can` and `space.roster` are what chat calls. They write nothing, so they say `record: false`:
an unrecorded Action runs inline, with no events of its own.

```ts
export const canAction = defineAction({
  description: "Whether you may read, write in or manage a space",
  input: {
    type: "object",
    properties: {
      space: { type: "string" },
      verb: { enum: ["read", "write", "manage"] },
    },
    required: ["space", "verb"],
    additionalProperties: false,
  },
  record: false,
  allow: (actor) => actor.kind === "person" || actor.kind === "agent",
  run: async (ctx, input) => {
    const found = await ctx.db.collection<Space>("space").findOne({ _id: input.space });
    return { can: !!found && (input.verb !== "write" || !found.archived) };
  },
});
```

### The rule

Identity already says everything is yours. What spaces adds is integrity (`shared/rules.ts`): a
document of a `shared` collection may only be written into a space that exists and isn't archived,
and spaces change only through their Actions.

```ts
export const rules: Guard = async (_, { collection, access, direct }, ctx) => {
  if (collection === "space" || collection === "member") {
    if (direct && access === "write") {
      throw failure("forbidden", "Spaces and their agents change through their Actions.", {
        public: true,
      });
    }
    return true;
  }
  const shared = (ctx.resources.shared ?? {}) as Shared;
  if (!Object.hasOwn(shared, collection)) return undefined;
  if (access === "read") return true;
  const spaces = await ctx.db.collection("space").find({ archived: { $exists: false } });
  // The runtime checks both inserts and what updates leave against this filter.
  return { [shared[collection].field ?? "in"]: { $in: spaces.map((space) => space._id) } };
};
```

A rule returns a filter, and the runtime does the rest: an insert, and whatever an update leaves,
must match it. Chat declares its own collections as `shared`, so from now on every chat lives in a
space: a person's `chat.send` without one is refused
(`That "thread" document would be out of your reach.`), exactly as with Copilotz's spaces. The
terminal and the page start in your Personal space, so you never see it.

### Telling agents where they are

The `where` context (`views/where.ts`) goes in the stable part of the prompt:

```ts
export const whereView = (thread: { in?: string }, ctx: ViewContext<string>) => {
  if (!thread.in) return undefined;
  const space = ctx.db.collection<Space>("space").findOne({ _id: thread.in }).value;
  if (!space) return undefined;
  const you = ctx.resources.identity as You;
  const person = ctx.db.collection<Person>("person").findOne({ _id: you.person }).value;
  const name = person?.name ?? you.name ?? you.person;
  if (space.kind === "personal") {
    return `This conversation is in ${name}'s Personal space: only ${name} sees what's here.`;
  }
  const agents = agentsIn(ctx, space.agent);
  return [
    `This conversation is in ${space.name} [in: ${space._id}]. Only ${name} sees what's here.`,
    agents.length ? `Its agents: ${agents.join(", ")}.` : "",
  ].filter(Boolean).join("\n");
};
```

Notice the reads: `findOne(…).value`. Inside a View, reads return at once with a `status`, and the
runtime runs the View again when pending reads arrive. Observed, it runs again whenever what it read
changes. One way of writing serves the prompt, the terminal and the web.

### The plugin, and the terminal

```ts
export const spaces: Plugin = definePlugin({
  name: "spaces",
  requires: ["identity"],
  collections: { space, member },
  actions: {
    "space.personal": personalAction,
    "space.create": createAction,
    "space.rename": renameAction,
    "space.archive": archiveAction,
    "space.can": canAction,
    "space.agent": agentAction,
    "space.roster": rosterAction,
  },
  guard: rules,
  views: { "context:where": whereView, "context:elsewhere": elsewhereView },
  resources: {
    context: { where: { place: "system" }, elsewhere: { place: "turn" } },
    roster: { spaces: { action: "space.roster" } },
    names: { people: { collection: "person" } },
  },
});
```

The `names` resource says where people's names are: identity's `person` collection. Copilotz's
spaces keeps profiles for that; here identity already knows your name.

`spacesTerminal` (`terminal.ts`) adds three commands, a `commands` resource the terminal shell
reads: `/spaces` lists them, `/space <name>` makes one and works in it, `/work <n>` works in
another. `terminal.ts` adds it, and starts you in your Personal space:

```ts
const actor = { kind: "person", id: me.person };
const { space } = await runtime.call<{ space: string }>("space.personal", {}, { actor });
await terminal({ runtime, me: me.person, actor, space, banner: "Compass" });
```

And the page starts there too: the web host takes a `start` function, which says where you work
first (`front.ts`, passed to `web()` in `browser.tsx`):

```ts
/** Where you work first: your Personal space. */
export const start = async (client: Client) => ({
  space: (await client.call<{ space: string }>("space.personal", {})).space,
});
```

```ts
// browser.tsx
await web({ root: document.getElementById("app")!, plugins: front, start });
```

## Run it

```text
ana › /space Course launch
You work in Course launch now.
ana › /spaces
[1] Course launch · shared · 690de15d-… ●
[2] Personal · personal · personal:ana
ana › Hi North.
ana › /prompt
…
<context name="where">
This conversation is in Course launch [in: 690de15d-…]. Only Ana sees what's here.
Its agents: north.
</context>
```

## Check it

Two kinds of tests. The plugin's own (`tests/spaces.test.ts`): your Personal space is made once; a
chat sent in a space lands there; a document can't be written into a space that doesn't exist; and
even you can't write spaces through the REST API. And a **parity test** (`tests/parity.test.ts`):
the same scenario runs on Copilotz's `spaces` and `identity` and on yours, and the answers must be
the same. Another test runs Copilotz's own boards and documents on your spaces, unchanged. That's
what "same contract" means in practice: code written for Copilotz's plugin works with yours.

## Also in this chapter

- `plugins/identity/collections/person.ts`: two queries the `names` resource needs, `names` and
  `pictures` (ids in, names or pictures out), which Copilotz's front ends and plugins ask when they
  show a person.
- `tests/store.test.ts`: it sends in Ana's Personal space (`in: space`), since a person's chat now
  lives in a space.
- The rest of spaces: `actions/personal.ts`, `rename.ts`, `archive.ts`, `agent.ts`, `roster.ts`,
  `collections/member.ts` (which agents work in a space), `shared/agents.ts`, `views/elsewhere.ts`.

`git diff lesson-2.3 lesson-2.4` shows every change.

## What you have now

A plugin that others depend on, rebuilt from its contract. Next, spaces get a front end: the
sidebar, a page for each space, and tabs other plugins can add to.
