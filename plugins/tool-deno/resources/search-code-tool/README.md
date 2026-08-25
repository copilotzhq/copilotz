# Search Code Tool Resource

## What it is

The data-only LLM presentation for the Search Code Action.

## Why it exists

It exposes bounded workspace search without putting executable code in a
Resource.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` as the `search_code` Tool.

## How it works

The Resource references the matching Action alias and inherits its schemas.
