# Schedules plugin

## What it is

The Schedules plugin turns host clock inputs into durable Scheduled Job due
facts while keeping job payloads opaque.

## Why it exists

Scheduling requires atomic claims, deterministic occurrence identities, and
restart-safe delivery without making time a generic runtime concern.

## How to use it

Compose `schedulesPlugin`, author jobs with the exported helpers, and send
`scheduleTick(...)` from the host scheduler.

## How it works

Two Actions claim manual or clock-driven occurrences, one Collection owns cron
state, and two Processors route typed application inputs into those Actions.
