# Search Code Action

## What it is

The executable Action that searches workspace file contents.

## Why it exists

It lets agents locate relevant code without reading full trees or files.

## How to use it

Compose it through `createWorkspaceToolsPlugin()` using the `search_code` alias.

## How it works

The Action applies bounded recursive search, pattern filtering, and match
projection through shared filesystem utilities.
