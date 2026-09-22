# Legacy Space attachment

## What it is

The historical association shape used before resources declared `spaceId`.

## Why it exists

Existing event streams must still replay faithfully while an operator migrates
stored ownership into each resource's declared `spaceId` field.

## How to use it

Do not use this Collection for new application behavior. It remains registered
for historical replay and bounded migration only.

## How it works

The stable ID encodes canonical collection name and record ID, so old snapshots
and events stay addressable. Current ownership is the resource's `spaceId`, and
the normal declared relation projects its graph edge.
