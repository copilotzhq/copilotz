# Shared Spaces

A Core Space is durable shared work context. It has an owner Participant, member
Participants and resource relationships declared by their own Collections. It is
separate from a Thread's producer memory scope. Core uses ordinary Collections,
Actions and relations; the runtime has no Space-specific behavior. Memory
remains optional.

## Public API

The Core plugin exposes the `space` Collection and the `spaces` Action
(`copilotz.core.spaces`). Resources opt in through their own definition:

```ts
relations: {
  space: relation.belongsTo("space", "spaceId"),
}
```

`spaceId` is authoritative. The ordinary relation projection derives
`Space --has_<resource>--> Resource`; it is not competing ownership state. The
resource schema decides whether that field is optional or required. In an
authorized Action/Processor context:

```ts
await context.actions.spaces({
  operation: "create",
  spaceId: "research",
  name: "Research",
  ownerId: "vinicius",
});
await context.actions.spaces({
  operation: "addMember",
  spaceId: "research",
  participantId: "colleague",
});
await context.actions.spaces({
  operation: "attach",
  spaceId: "research",
  collection: "thread",
  recordId: "discussion-a",
});
// The resource declares the relationship above.
await context.actions.spaces({
  operation: "attach",
  spaceId: "research",
  collection: "document",
  recordId: "notes",
});
const spaces = await context.collections.space.queries.active();
const records = await context.collections.document.list({
  where: { spaceId: "research" },
});
```

Code that already owns a transaction can call the exported
`attachSpaceRecord(context, transaction, spaceId, collection, recordId)` helper
to apply the same declared-relationship and atomic move semantics as the Action.

Participants and target records must already exist in the current namespace.
`collection` is a registered alias; Core resolves its canonical definition and
requires `space: relation.belongsTo("space", "spaceId")`. Each resource has one
authoritative `spaceId` field.

The owner is included in membership and cannot be removed. `removeMember`
removes other members. Applications decide who can invoke every operation, read
records, change membership or attach records. Authorize both Spaces and the
record when moving. Membership is context, not an authentication or permission
implementation. Direct collection writes are trusted low-level operations; use
the Action for lifecycle and ownership-move invariants.

## Move, detach and lifecycle

- `attach` to another active Space moves the resource atomically. The old Space
  loses access as the new association commits. A failed move preserves the old
  association. An identical attach keeps the existing association.
- `detach` accepts `spaceId`, `collection` and `recordId`. It clears an optional
  `spaceId` only when it still belongs to that Space; an already-detached or
  moved record is left alone. A required relation rejects detachment.
- `archive` excludes the Space from `space.queries.active()` and disables
  derived memory access, while keeping resource ownership and membership.
- `restore` retains remaining ownership. A record moved out while archived is
  not reclaimed, so restoration cannot introduce a second active association.
- `remove` permanently removes the Space. Pass `requireEmpty: true` to reject
  removal while resources exist. Without it, Core clears optional relationships
  and rejects required ones, so it never leaves a dangling `spaceId`.

Archive, restore and remove need only `spaceId`. Ordinary collection listing is
an administrative view and can include archived Spaces. Use the active query for
discovery. Ownership/lifecycle operations share an optimistic transaction; a
concurrent conflicting operation fails without partial changes. Read current
state before retrying with the normal Action idempotency mechanism.

## Memory semantics

Each Thread continues to write to its own producer scope. Threads attached to
the same active Space read their peers' producer scopes; no memory is moved or
copied into the Space, and no peer write grant is created. Consumer grants are
not shared transitively. Existing explicit application-managed memory grants
remain separate and are not revoked by detaching a Space.

Direct search and inspection, consolidation candidates and prompt context use
one scope resolver. Database queries filter allowed scopes before bounded
retrieval and normal relevance ranking. Readable memories can come from
different Agents. Peer memories can inform consolidation, but their records
cannot be edited or have their lifecycle changed by the consuming Thread.

Prompt context includes current read-only peer memories even before the
consuming Thread has a checkpoint. A checkpoint that depends on revoked scopes
cannot be used as prompt context or as a history cutoff. Detach, move, archive
and removal affect subsequent reads; already-captured model input and historical
conversation outputs cannot be recalled. Applications must govern disclosure of
that history.

## Validation

The Core Space test runs with PGlite and, when `COPILOTZ_TEST_POSTGRES_URL` is
set, PostgreSQL. Memory regression tests cover same-Space reads, separate-Space
isolation, peer writes, stale checkpoints and lifecycle revocation.

```sh
deno task check
deno task test
```

Optional live-model validation uses `COPILOTZ_LIVE_MODEL` and `OPENAI_API_KEY`
from the host environment; never commit credentials. The normal suite uses
fixtures.
