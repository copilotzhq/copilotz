# Deno Persistent Terminal Adapter

## What it is

A Deno-hosted `PersistentTerminalService` implementation.

## Why it exists

Subprocess and filesystem ownership are host capabilities, not portable plugin
behavior.

## How to use it

Import `createPersistentTerminalService` from the `/deno` subpath and pass the
service to the plugin factory.

## How it works

It manages scoped child-process sessions, bounded output, isolated workspace
paths, uploads, exports, restart, and shutdown.
