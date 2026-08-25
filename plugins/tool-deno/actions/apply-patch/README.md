# Apply Patch Action

## What it is

The executable Action that applies text-anchored workspace patches.

## Why it exists

It provides controlled edits with snapshots that can later be restored.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` using the `apply_patch` alias.

## How it works

The Action validates patch operations, captures a snapshot, then applies them
through the shared filesystem utilities.
