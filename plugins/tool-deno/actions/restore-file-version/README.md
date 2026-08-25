# Restore File Version Action

## What it is

The executable Action that restores a captured workspace-file snapshot.

## Why it exists

It gives agents a controlled recovery path after an edit.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` using the
`restore_file_version` alias.

## How it works

The Action resolves the requested snapshot and rewrites the bounded workspace
file through shared filesystem utilities.
