# Scheduled Jobs Action

## What it is

The executable Action behind the `scheduled_jobs` Tool Resource.

## Why it exists

Agent-visible Tool presentation and durable scheduled-job execution have
separate runtime responsibilities.

## How to use it

Compose `coreSchedulesPlugin` and grant the `scheduled_jobs` Tool to an Agent.

## How it works

The Action validates the requested operation and delegates to the generic
Schedules commands while enforcing the Core scheduled-message payload shape.
