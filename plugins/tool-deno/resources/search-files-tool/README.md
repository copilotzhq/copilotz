# Search Files Tool Resource

## What it is

The data-only LLM presentation for the Search Files Action.

## Why it exists

It exposes bounded file discovery without putting executable code in a Resource.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` as the `search_files` Tool.

## How it works

The Resource references the matching Action alias and inherits its schemas.
