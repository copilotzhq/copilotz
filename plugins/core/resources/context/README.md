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

Core selects contributors by purpose, validates unique contributions,
materializes content, and renders it into the prompt.
