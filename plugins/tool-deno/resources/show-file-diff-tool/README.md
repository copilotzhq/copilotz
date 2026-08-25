# Show File Diff Tool Resource

## What it is

The data-only LLM presentation for the Show File Diff Action.

## Why it exists

It exposes snapshot comparison without putting executable code in a Resource.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` as the `show_file_diff` Tool.

## How it works

The Resource references the matching Action alias and inherits its schemas.
