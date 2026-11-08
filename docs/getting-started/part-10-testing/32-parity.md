---
title: "Chapter 32: Parity"
description: "What every rebuilt plugin's parity test does, in one small helper: the same scenario on Copilotz's plugin and on yours, with ids and times taken out; and the parity test identity was missing, with testWho saying who each request is."
section: Getting Started
order: 320
status: stable
---

# Chapter 32: Parity

> Part 10, testing · Requires: Chapter 31 · Code: `lesson-10.2`

## The pain

"Same contract as Copilotz's" is a promise every rebuilt plugin makes, and a parity test is how it
keeps it. But each one keeps it its own way: spaces' builds the reference stack with an inline
`map`, boards' has its own `normalize` for ids and times. And identity, the first plugin you
rebuilt, has no parity test at all. Nothing says `/me` answers what Copilotz's does.

## The problem

A parity test runs one scenario twice, on Copilotz's plugin and on yours, and asserts both saw the
same. Two things always differ between the runs and have to come out first: the **ids** each run
made (a board's, a card's) and **clock times**. Everything else must match. Some differences are on
purpose, too: Copilotz's identity proves who a request is with a session cookie, and yours with
"this machine, to this machine". A parity test compares what's kept and leaves out what was dropped
on purpose.

## The solution

### What they share

`tests/parity.ts`:

```ts
/** The same plugins, with Copilotz's own in place of Compass's of the same name. */
export const withCopilotz = (stack: Plugin[], ...theirs: Plugin[]): Plugin[] =>
  stack.map((plugin) => theirs.find((their) => their.name === plugin.name) ?? plugin);

/** A time as plugins keep it: `2026-11-08T10:35:56.041Z`. */
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/** What a run saw, ready to compare with another's: each id it made by name, each time `<time>`. */
export function stable(value: unknown, ids = new Map<string, string>()): unknown {
  if (typeof value === "string") {
    if (TIME.test(value)) return "<time>";
    let text = value;
    for (const [id, name] of ids) text = text.replaceAll(id, `<${name}>`);
    return text;
  }
  if (Array.isArray(value)) return value.map((entry) => stable(entry, ids));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, stable(entry, ids)]),
    );
  }
  return value;
}
```

`withCopilotz` works because plugins are found by name: Copilotz's `spaces` takes the place of yours
in the same list, and every other plugin calls it exactly as before. That swap is the claim being
tested.

`stable` turns a time into `<time>` instead of dropping it, so a field one plugin sets and the other
doesn't still shows up as a difference. Ids get the names a test gives them (`<board>`, `<first>`)
wherever they appear, inside a tool's text answer too.

Spaces' parity test now builds its reference with the first:

```ts
const local = plugins({ you: { person: "ana", name: "Ana" } });
const reference = withCopilotz(local, copilotzIdentity, copilotzSpaces);
```

And boards' compares through the second, in place of its own `normalize`:

```ts
keepId(seen.boards[0]._id, "agent-board");
keepId(seen.cards[0]._id, "agent-card");
await snapshot(space);
return stable(results, ids);
```

### Identity's

What identity keeps of Copilotz's: the `person` collection, `person.set`, the `person.profile`
query, and `GET /me`. How a request proves who it is was left out on purpose, so the test needs a
way to say who a request is that works the same on both. That's `testWho`, from `copilotz/testing`:
a plugin whose `who` believes the `x-test-actor` header (an actor, as JSON). The runtime asks each
plugin's `who` in order and takes the first that answers. With `testWho` last, neither identity
recognizes the test's requests (no session cookie there, no loopback address here), so `testWho`
answers for both.

`plugins/identity/tests/parity.test.ts`:

```ts
async function scenario(stack: Plugin[]) {
  const store = memoryStore();
  const runtime = await createRuntime({ store, plugins: [...stack, testWho] });
  /** A request as the page sends it: from a person, or from nobody. */
  const request = async (method: string, path: string, person?: string, body?: unknown) => {
    const response = await runtime.fetch(
      new Request(`http://localhost${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(person ? { [TEST_ACTOR]: JSON.stringify({ kind: "person", id: person }) } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    return { status: response.status, body: await response.json() };
  };
  try {
    // The host keeps what it knows of a person, as the app's code (no actor).
    const first = await runtime.call("person.set", {
      person: "ana",
      name: "Ana",
      email: "  Ana@Example.com ",
    });
    const again = await runtime.call("person.set", { person: "ana", picture: "/ana.png" });
    const profile = await runtime.query("person.profile", { person: "ana" });
    const unknown = await runtime.query("person.profile", { person: "bob" });
    const me = await request("GET", "/me", "ana");
    const nobody = await request("GET", "/me");
    const posted = await request("POST", "/me", "ana");
    const read = await request("GET", "/api/collections/person/ana", "ana");
    const written = await request("PATCH", "/api/collections/person/ana", "ana", { name: "Eve" });
    return stable({
      first,
      again,
      profile,
      unknown,
      me,
      nobody,
      posted,
      read,
      // Refused alike; each says why in its own words.
      written: { status: written.status, code: written.body.error?.code },
      kept: await store.findOne("person", { _id: "ana" }),
    });
  } finally {
    await runtime.close();
  }
}

test("our identity and Copilotz's keep a person, their profile and /me alike", async () => {
  const ours = plugins({ you: { person: "ana", name: "Ana" } });
  const expected = await scenario(withCopilotz(ours, copilotzIdentity, copilotzSpaces));
  assert.deepEqual((expected as { me: unknown }).me, {
    status: 200,
    body: { person: "ana", name: "Ana", email: "ana@example.com" },
  });
  assert.deepEqual(await scenario(ours), expected);
});
```

The reference swaps spaces too, as spaces' own parity test does: your spaces read names from your
identity's `person` queries, so Copilotz's identity comes with Copilotz's spaces. The scenario
covers what a page and a host do with identity: keep a person twice (the first time is `new`), read
their profile (an email comes back trimmed and lowercased), ask `/me` as Ana, as nobody (401) and
with the wrong method (405), read her document through the REST API, and try to write it there,
which both refuse with `forbidden`. One check runs on Copilotz's answer alone, so the scenario can't
pass by being empty on both.

## Run it

```text
$ node --disable-warning=ExperimentalWarning --test --test-concurrency=1 plugins/*/tests/parity.test.ts
✔ kept Actions, document fields, ordering and tool answers match Copilotz's boards (436.774708ms)
✔ our identity and Copilotz's keep a person, their profile and /me alike (56.044875ms)
✔ our spaces and Copilotz's spaces keep the same single-person contract (326.658917ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1289.099334
```

And when they differ: take `.toLowerCase()` out of `person.set`'s email in
`plugins/identity/actions/person.ts`, and the diff shows every place it shows:

```text
✖ our identity and Copilotz's keep a person, their profile and /me alike (57.323042ms)
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:
  + actual - expected
  …
      me: {
        body: {
  +       email: 'Ana@Example.com',
  -       email: 'ana@example.com',
          name: 'Ana',
          person: 'ana'
        },
        status: 200
      },
  …
```

## Check it

`npm test`: 35 tests, the boards and spaces parity tests among them, unchanged in what they check.

## Also in this chapter

- `plugins/spaces/tests/parity.test.ts` and `plugins/boards/tests/parity.test.ts`, on the helper.

`git diff lesson-10.1 lesson-10.2` shows every change.

## What you have now

Two kinds of tests, and what each is for. The app's (Chapter 31) say Compass works the way a person
uses it. The parity tests say each plugin you rebuilt answers the way Copilotz's does, so the day
Compass has many people, you can swap one for the other.
