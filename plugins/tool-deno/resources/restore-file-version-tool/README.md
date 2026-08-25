# Restore File Version Tool Resource

## What it is

The data-only LLM presentation for the Restore File Version Action.

## Why it exists

It exposes snapshot recovery without putting executable code in a Resource.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` as the `restore_file_version`
Tool.

## How it works

The Resource references the matching Action alias and inherits its schemas.
