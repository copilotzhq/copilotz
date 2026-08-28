# Dispatch consolidation

## what it is

The detached processor that turns a reserved checkpoint into an internal, scoped
Core Agent turn.

## why it exists

Memory must use the same Agent prompt, models, credentials, and Tool lifecycle
as ordinary conversation turns without exposing maintenance in public history.

## how to use it

It is composed automatically by `createLongTermMemoryPlugin` when Memory is
enabled.

## how it works

It captures normal conversation Context once, creates a deterministic internal
Message addressed to the owning Agent, and marks that Message with generic Core
Agent-turn metadata whose successful completion Action is `consolidate_memory`.
