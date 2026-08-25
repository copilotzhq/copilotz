# Scheduled Job Collection

## What it is

This Collection stores opaque Scheduled Jobs and their next due occurrence.

## Why it exists

Scheduling claims must be atomic, tenant-scoped, and restart-safe before a
semantic plugin reacts to them.

## How to use it

Compose `schedulesPlugin` and use the exported Scheduled Job authoring helpers.

## How it works

The `due` command validates status and occurrence identity, advances cron state,
and emits the durable `scheduled_job.due` fact atomically.
