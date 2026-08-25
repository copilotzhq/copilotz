# List Directory Action

## What it is

The executable Action that lists bounded workspace directories.

## Why it exists

It gives agents a predictable file-tree view while excluding noisy directories.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` using the `list_directory`
alias.

## How it works

The Action delegates bounded traversal and filtering to shared filesystem
utilities.
