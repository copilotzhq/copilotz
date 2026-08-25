# Apply Patch Tool Resource

## What it is

The data-only LLM presentation for the Apply Patch Action.

## Why it exists

It exposes safe patch semantics without putting executable code in a Resource.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` as the `apply_patch` Tool.

## How it works

The Resource references the matching Action alias and inherits its schemas.
