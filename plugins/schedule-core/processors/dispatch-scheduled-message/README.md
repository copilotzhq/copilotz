# Dispatch Scheduled Message Processor

## What it is

A Processor for typed `scheduled_job.due` Events.

## Why it exists

Only Core scheduled-message payloads should be projected into conversations.

## How to use it

It is registered by `coreSchedulesPlugin`; applications do not invoke it
directly.

## How it works

It validates the durable occurrence and invokes the dispatch Action with an
occurrence-stable operation key.
