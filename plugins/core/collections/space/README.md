# Space

## What it is

A durable Core hub with an owner Participant, members, optional description and
active/archived status. `name` remains its canonical title field.

## Why it exists

Applications need shared context without adding product semantics to the
runtime.

## How to use it

Use `actions.spaces` to create a Space and change membership or lifecycle.
`collections.space.queries.active()` discovers active Spaces. The owner is
included in membership and cannot be removed. Existing records may omit
`description`. Application guards authorize every operation and all direct
collection reads/writes.

## How it works

Ordinary collection relations connect the owner and members. Resources declare
their own `belongsTo("space", "spaceId")` relation; the runtime projects the
corresponding `has_<resource>` edge from this Space. Ownership changes touch a
revision in the same transaction to conflict with concurrent archive/removal.
Archiving retains ownership; restoring does not reclaim resources moved
elsewhere.
