# Persistent Terminal Tools

## What it is

A configurable Tool that exposes scoped, stateful terminal sessions.

## Why it exists

Long-running agent work needs shell state that survives individual Tool calls
without making the portable plugin own host processes.

## How to use it

Create a host service, pass it to `createPersistentTerminalToolsPlugin`, and
grant the configured Tool alias to an Agent.

## How it works

The Action delegates process work to an external service while mediating durable
Asset reads and publication. The Resource contains only Tool presentation.
