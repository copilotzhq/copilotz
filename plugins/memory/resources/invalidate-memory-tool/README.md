# Invalidate memory tool

## What it is

A tool resource named `invalidate_memory` for editorial semantic-memory
maintenance.

## Why it exists

Agents need a safe way to retract, supersede, or archive incorrect or outdated
records without falsifying domain lifecycle.

## How to use it

Install the memory plugin and grant `invalidate_memory` only to agents that
should perform audited memory maintenance.

## How it works

The tool exposes the narrow invalidate Action. The Action enforces trusted Core
provenance and writable memory-space access, while retaining the original
lifecycle status.
