# Record Tool Usage Processor

## What it is

This Processor records terminal Core Tool Action lifecycle facts as Usage.

## Why it exists

Tool executions need the same durable, queryable accounting model as LLM
provider requests.

## How to use it

Compose the Usage plugin; Tool lifecycle events are detected automatically.

## How it works

It recognizes exact Core Tool Action metadata, resolves initiator attribution,
and writes one idempotent Usage record for the Action run.
