# Tools Plugin Authoring

## What it is

A compiler from alias-keyed compound Tool declarations to one concrete plugin.

## Why it exists

Each declaration produces both an Action and a matching Tool Resource and needs
one implementation owner.

## How to use it

Create declarations with object-form `defineTool`, then pass their alias map to
`createToolsPlugin`.

## How it works

The compiler rejects duplicate Action IDs, registers Actions by map alias, and
derives data-only Tool Resources with the same aliases.
