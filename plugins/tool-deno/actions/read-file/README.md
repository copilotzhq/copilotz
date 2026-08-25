# Read File Action

## What it is

The executable Action that reads a bounded range from a workspace file.

## Why it exists

It prevents accidental oversized file responses while retaining precise reads.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` using the `read_file` alias.

## How it works

The Action enforces range and output limits before returning UTF-8 text.
