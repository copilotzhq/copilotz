# List Directory Tool Resource

## What it is

The data-only LLM presentation for the List Directory Action.

## Why it exists

It tells an LLM how to request a workspace directory listing without executing
it.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` as the `list_directory` Tool.

## How it works

The Resource references the matching Action alias and inherits its schemas.
