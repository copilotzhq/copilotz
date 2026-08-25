# Finance Tool Resource

## What it is

The data-only LLM presentation for the Finance Action.

## Why it exists

Tool discovery needs schemas and presentation without exposing executable code
on the Resource.

## How to use it

`createFinanceToolsPlugin` creates and registers this Resource automatically.

## How it works

It uses `defineTool` to copy the Finance Action schemas into an immutable Tool
Resource bound to the `finance` Action alias.
