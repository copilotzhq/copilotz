# Deno Tools

## What it is

Selectable workspace filesystem and subprocess Tools for Deno hosts.

## Why it exists

Agents need bounded local capabilities without coupling host code to individual
Action and Tool Resource definitions.

## How to use it

Compose `createWorkspaceToolsPlugin()` for filesystem Tools or
`createProcessToolsPlugin()` for the process Tool. Each factory accepts an
optional `include` selection.

## How it works

The plugin selects durable Actions and matching data-only Tool Resources by
stable alias. Filesystem helpers remain private to the Action category.
