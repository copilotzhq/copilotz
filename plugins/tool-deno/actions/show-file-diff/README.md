# Show File Diff Action

## What it is

The executable Action that compares a workspace file with a captured snapshot.

## Why it exists

It lets agents inspect pending changes before deciding whether to restore them.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` using the `show_file_diff`
alias.

## How it works

The Action obtains the snapshot diff from shared filesystem utilities and
returns its bounded hunk projection.
