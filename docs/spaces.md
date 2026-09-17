# Shared Spaces

A Core Space is durable shared work context. It has an owner Participant, member
Participants and attachments to collection records. It is separate from a
Thread's producer memory scope. Core uses ordinary Collections, Actions and
relations; the runtime has no Space-specific behavior. Memory remains optional.

## Public API

The Core plugin exposes `space` and `spaceAttachment` Collections and the
`spaces` Action (`copilotz.core.spaces`). In an authorized Action/Processor
context:

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
// Any registered durable collection works, including application collections.
await context.actions.spaces({
  operation: "attach",
  spaceId: "research",
  collection: "document",
  recordId: "notes",
});
const spaces = await context.collections.space.queries.active();
const records = await context.collections.spaceAttachment.queries.bySpace({
  spaceId: "research",
});
```

Code that already owns a transaction can call the exported
`attachSpaceRecord(context, transaction, spaceId, collection, recordId)` helper
to apply the same canonical attachment and atomic move semantics as the Action.

Participants and target records must already exist in the current namespace.
`collection` is a registered alias; attachment identity uses its canonical
collection name and record ID, so aliases cannot bypass uniqueness. Each record
has at most one attachment. IDs are namespace-scoped and delimiter-safe.

The owner is included in membership and cannot be removed. `removeMember`
removes other members. Applications decide who can invoke every operation, read
records, change membership or attach records. Authorize both Spaces and the
record when moving. Membership is context, not an authentication or permission
implementation. Direct collection writes are trusted low-level operations; use
the Action for lifecycle and attachment invariants.

## Move, detach and lifecycle

- `attach` to another active Space moves the attachment atomically. The old
  Space loses access as the new association commits. A failed move preserves the
  old association. An identical attach keeps the existing association.
- `detach` accepts `spaceId`, `collection` and `recordId`. It only removes an
  attachment still belonging to that Space; an already-detached or moved record
  is left alone.
- `archive` excludes the Space from `space.queries.active()` and disables
  derived memory access, while keeping attachments and membership.
- `restore` reactivates remaining attachments. A record moved out while archived
  is not reclaimed, so restoration cannot introduce a second active attachment.
- `remove` permanently removes the Space and its attachments. Pass
  `requireEmpty: true` to reject removal while attachments exist. Original
  records, Thread producer scopes and memory records survive, now without that
  Space.

Archive, restore and remove need only `spaceId`. Ordinary collection listing is
an administrative view and can include archived Spaces. Use the active query for
discovery. Attachment/lifecycle operations share an optimistic transaction; a
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
