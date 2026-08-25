# Run Command Tool Resource

## What it is

The data-only LLM presentation for the Run Command Action.

## Why it exists

It exposes bounded process execution without putting executable code in a
Resource.

## How to use it

Compose it through `createProcessToolsPlugin()` as the `run_command` Tool.

## How it works

The Resource references the matching Action alias and inherits its schemas.
