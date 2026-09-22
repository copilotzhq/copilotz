# Spaces Action

## What it is

One native Core Action for creating Spaces, editing metadata, membership,
declared resource ownership and lifecycle.

## Why it exists

Keeps public mutations transactional and discoverable without action factories
or Space-specific runtime behavior.

## How to use it

Call `actions.spaces({ operation, spaceId, ... })`:

- `create`: existing `ownerId`, optional `name` and `description`.
- `update`: an application-authorized owner/member supplies a non-empty `name`
  and/or `description`; an explicitly empty description clears it, while an
  omitted description is unchanged. No-op and invalid patches are rejected. The
  result is `{ spaceId, operation: "update", space }` with the updated Space.
- `addMember` / `removeMember`: existing `participantId`.
- `attach` / `detach`: `collection` alias and `recordId`; the target must
  declare `space: relation.belongsTo("space", "spaceId")`.
- `archive` / `restore`: only `spaceId`.
- `remove`: `spaceId`; pass `requireEmpty: true` to reject removal while the
  Space has resources.

Core also exports `attachSpaceRecord` for authorized Action or Processor code
that already has a transaction. It writes the target resource's authoritative
`spaceId` and relies on its declared relation for the projected graph edge.

Application/server guards must authorize the operation, both Spaces on a move,
and the target record. The Action does not authenticate callers. Use ordinary
Action idempotency keys when retrying. Surface transaction conflicts and retry
with fresh state; do not silently overwrite another writer's intent.

## How it works

The owning Participant is always a member. Attach accepts active destinations; a
second attach moves the resource atomically. A failed move leaves its original
`spaceId`. Detach names the expected Space and does nothing if already detached
or moved elsewhere. Archive disables active discovery and derived memory access.
Remove clears optional ownership and refuses to remove a Space that still owns a
required resource. Transactional revision changes fence ownership changes
against concurrent lifecycle changes.
