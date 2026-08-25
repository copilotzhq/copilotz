# Channel resource helper

## What it is

Validates the data-only policy for a channel alias.

## Why it exists

Providers need a stable declarative egress policy separate from their adapter
behavior.

## How to use it

Pass `defineChannelResource(...)` in a provider plugin's `resources.channels`
map.

## How it works

It validates the egress mode and freezes JSON-safe metadata and default agent
aliases.
