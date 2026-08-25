# Tool Authoring

## What it is

The export-only family surface for Tool Resources and helpers that compile
developer declarations into native Actions and data-only Tool Resources.

## Why it exists

Tool authoring spans more than one runtime primitive, while concrete Tool
plugins still need independent physical owners.

## How to use it

Import `defineTool` and `createToolsPlugin` from `/tools`. Import concrete Tool
families from their dedicated subpaths.

## How it works

The family barrel exports only authoring contracts and helpers. Concrete Tool
implementations live in `tool-*` plugin roots, while OpenAPI and MCP generators
own their generated primitives.
