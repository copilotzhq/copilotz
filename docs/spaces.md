---
title: "Spaces"
description: "Group threads and other records under an owned Space with members, move them atomically, and understand what Space membership does and does not authorize."
section: Agent Harness
order: 80
status: stable
---

# Spaces

## The pain

Your team runs several conversations about one project: a research thread, a
planning thread, a review thread. You want them to share context, for example so
that what the assistant remembered in one thread can inform another, and you
want to show "everything in the Launch project" in your UI. Tagging each thread
with `metadata.project = "launch"` gets you a filter, but nothing more: nobody
owns the tag, two records can disagree about it, moving a thread is a loose
string edit, and archiving the project changes nothing.

## The problem

Shared work context needs a contract, not a label:

- **Ownership:** which single place a record belongs to, stored once, so a
  record is never in two projects at the same time.
- **Lifecycle:** what happens to the records when the project is archived,
  restored or removed, and when a record moves between projects concurrently.
- **Membership:** which Participants the project is about, kept apart from who
  is _allowed_ to change it.
- **Context:** which features, such as Memory, read across records because they
  share a project, and when that sharing stops.

## The solution

Core (`corePlugin` from `@copilotz/copilotz/core`) contributes a `space`
Collection and one Action, `copilotz.core.spaces`, available to Processors and
Actions as `context.actions.spaces`. Spaces are ordinary Collections and
Actions; the runtime itself has no Space behavior.

A **Space** record has an `ownerId` (an existing Participant), `memberIds`
(always including the owner), a `name`, an optional `description` and a `status`
of `active` or `archived`. Its `active` named query lists only active Spaces.

A collection **opts in** by declaring the exact relation
`space: relation.belongsTo("space", "spaceId")`. Core's `thread` Collection
does; your own Collections can too. The record's `spaceId` field is the single
source of truth: there is no separate attachment row to keep in sync, and the
derived Space-to-record relation is a projection of that field. Whether
`spaceId` is optional or required is decided by that record's schema.

The Action's `operation` field selects one of:

| Operation                    | Needs                               | Effect                                                                  |
| ---------------------------- | ----------------------------------- | ----------------------------------------------------------------------- |
| `create`                     | `spaceId`, existing `ownerId`       | Creates an active Space whose only member is the owner.                 |
| `update`                     | `spaceId`, `name`/`description`     | Renames or describes an active Space.                                   |
| `addMember` / `removeMember` | `spaceId`, `participantId`          | Changes membership. The owner cannot be removed.                        |
| `attach`                     | `spaceId`, `collection`, `recordId` | Sets the record's `spaceId`; from another Space this is an atomic move. |
| `detach`                     | `spaceId`, `collection`, `recordId` | Clears an optional `spaceId` only if it still points at this Space.     |
| `archive` / `restore`        | `spaceId`                           | Hides from `active` and stops derived Memory sharing / resumes it.      |
| `remove`                     | `spaceId`, optional `requireEmpty`  | Deletes the Space after clearing optional `spaceId` fields.             |

`collection` is the registered Collection alias, such as `thread`. Both the
Participant and the target record must already exist in the current namespace.

### A complete check without a model

`spaces-check.ts` composes Core with one Processor. The Processor plays the role
of trusted host code: it creates a Participant, a Space and a thread, attaches
the thread, then reads the result back. No agent, provider or credential is
involved.

Prerequisites: Deno 2.9+ or Node 24+, set up as in the
[Quickstart](quickstart.md):

```sh
# Deno
deno add jsr:@copilotz/copilotz@^0.86.3
# Node: ES modules, Copilotz from JSR, and PGlite, the database the runtime opens.
npm init -y
npm pkg set type=module
npx jsr add @copilotz/copilotz@^0.86.3
npm i @electric-sql/pglite
```

```ts
// Runtime factory, Processor/Plugin helpers and the typed caller map.
import {
  type ActionCallers,
  createCopilotz,
  definePlugin,
  defineProcessor,
  isStreamOutput,
  type ProcessorContext,
} from "@copilotz/copilotz";
// Core contributes the space/thread/participant Collections and the spaces Action.
import { corePlugin, spacesAction } from "@copilotz/copilotz/core";

// The one Action this Processor calls, typed as the third generic.
type SpacesContext = ProcessorContext<
  ProcessorContext["resources"],
  ProcessorContext["adapters"],
  ActionCallers<{ spaces: typeof spacesAction }>
>;

// Trusted host code: it has already decided this caller may manage the Space.
const organize = defineProcessor<SpacesContext>({
  id: "spaces-check.organize",
  on: [{ eventType: "spaces-check.requested" }],
  async handle(event, context) {
    // Act only on stored requests, so every write traces to a recorded Event.
    if (!event.durable) return;
    const { collections, actions } = context;

    // The owner must exist before the Space can be created.
    await collections.participant.create({
      id: "you",
      externalId: "you",
      participantType: "human",
    }, { operationKey: "create-owner" });
    // Create the Space first: attachment reads the committed Space and record.
    await actions.spaces(
      {
        operation: "create",
        spaceId: "launch",
        name: "Launch",
        ownerId: "you",
      },
      { operationKey: "create-space" },
    );
    await collections.thread.create({ id: "launch-research" }, {
      operationKey: "create-thread",
    });
    // Writes thread.spaceId; the thread Collection declares the relation.
    await actions.spaces(
      {
        operation: "attach",
        spaceId: "launch",
        collection: "thread",
        recordId: "launch-research",
      },
      { operationKey: "attach-thread" },
    );

    // Discovery uses the active query; members are read from the Space record.
    const spaces = await collections.space.queries.active();
    const threads = await collections.thread.list({
      where: { spaceId: "launch" },
    });
    console.log(JSON.stringify({
      spaces: spaces.map((s) => ({ id: s.id, memberIds: s.memberIds })),
      threads: threads.map((t) => t.id),
    }));
  },
});

const app = await createCopilotz({
  namespace: "spaces-check",
  database: { url: ":memory:" },
  plugins: [
    corePlugin,
    definePlugin({
      id: "spaces-check",
      version: "1.0.0",
      processors: { organize },
    }),
  ],
});

try {
  const handle = await app.send({
    type: "spaces-check.requested",
    payload: {},
  });
  // Drain outputs and wait for settlement together; report failures after both.
  const read = (async () => {
    for await (const output of handle.outputs) {
      if (isStreamOutput(output)) await output.payload.cancel();
    }
  })();
  const [reader, done] = await Promise.allSettled([read, handle.done]);
  if (done.status === "rejected") throw done.reason;
  if (reader.status === "rejected") throw reader.reason;
} finally {
  await app.close();
}
```

Run it with `deno run -A spaces-check.ts` or `node spaces-check.ts`.

### Check it works

The program prints one line: the `launch` Space with `memberIds` `["you"]`, and
`threads` `["launch-research"]`. Creating the Space with an `ownerId` that has
no Participant fails the delivery, so `done` rejects and the program exits with
the error. To see a move, create a second Space and attach the same thread to
it: the thread then lists under the new Space only.

## Reference

### Moves, detachment and lifecycle

- **Attach is a move.** Attaching to another active Space changes `spaceId` in
  one optimistic transaction that touches both Spaces. A failed move keeps the
  old association; attaching to the current Space keeps the same association.
- **Detach** clears an optional `spaceId` only while it still points at the
  named Space, so a record that was already moved is left alone. A record whose
  schema requires `spaceId` cannot be detached.
- **Archive** removes the Space from `queries.active()` and stops derived Memory
  sharing; ownership and membership stay. **Restore** brings back the records
  that are still attached; one moved away meanwhile is not reclaimed.
- **Remove** deletes the Space. With `requireEmpty: true` it refuses while any
  record is attached; otherwise it clears optional `spaceId` fields and refuses
  if a required one remains, so no record points at a missing Space.
- Concurrent conflicting operations fail without partial changes. Read current
  state before submitting another authorized operation. An `operationKey` is
  scoped to the invoking delivery and Action call, not a global deduplication
  key.

Plain `collections.space.list()` is an administrative view that also returns
archived Spaces. Direct Collection writes to `spaceId` bypass the move and
lifecycle checks; use the Action.

Code that already owns a transaction inside an Action can call the exported
`attachSpaceRecord(context, transaction, spaceId, collection, recordId)` for the
same checks. It reads through the surrounding context, so it cannot see a record
created earlier in that same transaction: create first, then attach.

### Authorization is yours

The Action checks invariants (owner exists, record declares the relation, Space
is active), **not** who is calling. Membership describes who the work involves;
it is not a permission system. Before calling `spaces`, the host decides from a
trusted principal whether the caller may change the Space, and for `attach`
whether they may act on the record and on **both** the source and target Space.
Granting the Action to an agent as a Tool hands that decision to the model, so
keep it in trusted Processors unless you add your own checks. See
[Authenticate and isolate tenants](getting-started/part-4-release-to-users/16-authenticate-and-isolate-tenants.md).

Assets referenced by records in a Space are stored per namespace, not per Space.
Authorizing someone for a Space does not authorize reading its records' Assets,
or vice versa; check content access on its own route.

### What reads across a Space

- **Memory.** Each thread keeps writing to its own memory scope. Threads
  attached to the same _active_ Space can read each other's memories, read only.
  Peer access comes from attached threads, not from `memberIds`: removing a
  member does not by itself stop their thread reading peers; detaching or moving
  it does. Detach, move, archive and remove stop future peer-memory reads. Each
  thread retains its own certified conversation continuity, including peer
  information already summarized, like saved messages; it does not restart
  consolidation when a peer leaves. Explicit Memory grants are separate and
  unaffected. See [Memory](memory.md).
- **Knowledge.** The built-in `document` Collection does not declare the Space
  relation, so documents cannot be attached. Knowledge's `knowledgeSpaceIds` are
  a metadata filter for search, not Space ownership. See
  [Knowledge](knowledge.md).

## What this unlocks

- One place per record: project views are a `list({ where: { spaceId } })`,
  never a reconciliation of tags.
- Shared conversational context across a project's threads that ends when the
  Space is archived or a thread leaves.
- Your own Collections (briefs, boards, notes) can join Spaces by declaring the
  relation, and gain the same move and removal guarantees.

## Next steps

- [Memory](memory.md): how peer reads combine with consolidation and grants.
- [Collections](collections.md): declaring relations on your own records.
- [Authenticate and isolate tenants](getting-started/part-4-release-to-users/16-authenticate-and-isolate-tenants.md):
  deciding who may call `spaces`.
