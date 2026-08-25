# Write File Tool Resource

## What it is

The data-only LLM presentation for the Write File Action.

## Why it exists

It exposes bounded file mutation without putting executable code in a Resource.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` as the `write_file` Tool.

## How it works

The Resource references the matching Action alias and inherits its schemas.
