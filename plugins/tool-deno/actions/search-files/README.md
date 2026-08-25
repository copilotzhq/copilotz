# Search Files Action

## What it is

The executable Action that finds workspace files by glob-like name pattern.

## Why it exists

It gives agents a focused alternative to broad directory listing.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` using the `search_files`
alias.

## How it works

The Action traverses within configured bounds and filters entries with the
shared filesystem glob utility.
