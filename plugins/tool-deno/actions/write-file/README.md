# Write File Action

## What it is

The executable Action that writes or appends UTF-8 workspace files.

## Why it exists

It provides controlled creation and replacement with a restorable snapshot.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` using the `write_file` alias.

## How it works

The Action captures pre-existing content, writes within the workspace, and
reports whether unread content was overwritten.
