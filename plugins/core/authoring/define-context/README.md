# Context Resource

## What it is

A runtime-neutral contributor of prompt context or sourced evidence.

## Why it exists

Applications and plugins need typed prompt enrichment without turning read-only
policy into Actions.

## How to use it

Create one with `defineContextResource` and register it under
`resources.promptContext`.

## How it works

Core selects contributors by purpose and validates unique contributions.
`prepareContextContributions` uses runtime `resolveContentInputs` to resolve
references in one authorized batch without persisting literal contributions.
`renderContextContent(content)` is a synchronous, pure projection of prepared
values; it receives no runtime services and never loads Assets.
