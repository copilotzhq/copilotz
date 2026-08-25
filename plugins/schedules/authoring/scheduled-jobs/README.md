# Scheduled Job Authoring

## What it is

These helpers create, update, read, and list Scheduled Job records.

## Why it exists

Owning plugins need typed Collection mutations while scheduled payloads remain
opaque to the generic scheduler.

## How to use it

Pass a scoped domain context to `createScheduledJob`, `updateScheduledJob`,
`getScheduledJob`, or `listScheduledJobs`.

## How it works

The helpers validate cron state and normalize Collection records without
creating a second persistence or lifecycle abstraction.
