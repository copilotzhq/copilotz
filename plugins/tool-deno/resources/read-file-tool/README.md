# Read File Tool Resource

## What it is

The data-only LLM presentation for the Read File Action.

## Why it exists

It exposes bounded file-reading semantics without executable code.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` as the `read_file` Tool.

## How it works

The Resource references the matching Action alias and inherits its schemas.
